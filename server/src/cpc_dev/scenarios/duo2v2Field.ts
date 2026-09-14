import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../../game/game.ts";
import { normalizeSeed } from "../createScenarioGame.ts";
import { seededRand } from "../seededRand.ts";
import { applyCoverLayout, type CoverDensity, type CoverPiece, createCoverLayout } from "./coverLayout.ts";
import {
    buildDuo2v2Scenario,
    type CpcAgentId,
    type CpcTeamId,
    type Duo2v2Scenario,
    type Duo2v2ScenarioOptions,
    type ScenarioRegion,
} from "./duo2v2.ts";

export interface FieldLoot {
    type: string;
    count: number;
    pos: Vec2;
}

/**
 * "fixed": the base scenario geometry (duos west/east of the center, 32 u out on a 128 region).
 * "random": the spawn axis is rotated by a seeded angle and the distance to the center is drawn from
 * [24, 44] u, so absolute directions carry no information across episodes; the duos stay mirror
 * images of each other through the center, face it, and the team kits move with them.
 */
export type FieldLayout = "fixed" | "random";

export interface FieldSpawnLayout {
    layout: FieldLayout;
    center: Vec2;
    /** angle of the center -> team-a axis (radians) */
    angle: number;
    /** distance from the center to each duo's midpoint */
    radius: number;
    spawns: Record<CpcAgentId, Vec2>;
    /** initial facing per agent (toward the center) */
    facing: Record<CpcAgentId, Vec2>;
}

export interface Duo2v2FieldOptions extends Omit<Duo2v2ScenarioOptions, "spawns"> {
    layout?: FieldLayout;
    /** bullet-stopping cover between the duos; `none` (the default) keeps the open field */
    cover?: CoverDensity;
    /**
     * Body skins per team so a spectator can tell the duos apart, the way 50v50 colours its factions
     * (`GameConfig.teamColors`): default team-a = "outfitBlueLeader" (blue), team-b = "outfitRed" (red).
     * `false` keeps the engine default skin. Purely visual: outfits are not part of the observation.
     */
    teamOutfits?: Partial<Record<CpcTeamId, string>> | false;
}

export const defaultTeamOutfits: Record<CpcTeamId, string> = {
    "team-a": "outfitBlueLeader",
    "team-b": "outfitRed",
};

export interface Duo2v2FieldScenario extends Duo2v2Scenario {
    loot: FieldLoot[];
    spawnLayout: FieldSpawnLayout;
    cover: CoverPiece[];
}

interface KitItem {
    type: string;
    count: number;
}

// Each duo gets the same starter kit next to its spawn, one better kit sits contested at the region center.
const teamKit: KitItem[] = [
    { type: "ak47", count: 1 },
    { type: "mp5", count: 1 },
    { type: "bandage", count: 4 },
    { type: "soda", count: 2 },
    { type: "helmet01", count: 1 },
    { type: "chest01", count: 1 },
    { type: "2xscope", count: 1 },
];

const centerKit: KitItem[] = [
    { type: "healthkit", count: 1 },
    { type: "painkiller", count: 1 },
    { type: "4xscope", count: 1 },
];

// team kits are dropped this far from the duo spawn toward the center, scattered by up to kitScatter
const kitOffsetFromSpawn = 10;
const kitScatter = 4;
// random layout: distance from the center to a duo's midpoint, and the teammate spacing along the perpendicular
// (seededRand streams: 0 = loot scatter, 7919 = spawn geometry; the objective uses 104729)
const spawnRadiusMin = 24;
const spawnRadiusMax = 44;
const teammateHalfSpacing = 6.4;

/** Seeded spawn geometry (see `FieldLayout`). `fixed` reproduces the base scenario exactly. */
export function createFieldSpawns(region: ScenarioRegion, seed: number, layout: FieldLayout): FieldSpawnLayout {
    const center = v2.create(region.x + region.width / 2, region.y + region.height / 2);
    let angle = Math.PI; // team-a west of the center
    let radius = region.width * 0.25; // 32 u on the 128 region
    let halfSpacing = region.height * 0.05;
    if (layout === "random") {
        const rand = seededRand(seed, 7919);
        angle = rand(0, Math.PI * 2);
        radius = rand(spawnRadiusMin, spawnRadiusMax);
        halfSpacing = teammateHalfSpacing;
    }
    const axis = v2.create(Math.cos(angle), Math.sin(angle));
    const perp = v2.perp(axis);
    const midA = v2.add(center, v2.mul(axis, radius));
    const midB = v2.sub(center, v2.mul(axis, radius));
    // team-b mirrors team-a across the line through the center perpendicular to the axis (for the west
    // axis that is the base scenario's x-mirror: team-a-0 / team-b-0 both at centerY - offset)
    const spawns: Record<CpcAgentId, Vec2> = {
        "team-a-0": v2.add(midA, v2.mul(perp, halfSpacing)),
        "team-a-1": v2.sub(midA, v2.mul(perp, halfSpacing)),
        "team-b-0": v2.add(midB, v2.mul(perp, halfSpacing)),
        "team-b-1": v2.sub(midB, v2.mul(perp, halfSpacing)),
    };
    const facing = Object.fromEntries(
        Object.entries(spawns).map(([id, pos]) => [id, v2.normalizeSafe(v2.sub(center, pos), v2.create(1, 0))]),
    ) as Record<CpcAgentId, Vec2>;
    return { layout, center, angle, radius, spawns, facing };
}

/** Reflects `pos` across the line through the layout center perpendicular to the spawn axis. */
export function mirrorAcrossCenter(layout: FieldSpawnLayout, pos: Vec2): Vec2 {
    const axis = v2.create(Math.cos(layout.angle), Math.sin(layout.angle));
    const rel = v2.sub(pos, layout.center);
    const along = v2.dot(rel, axis);
    return v2.sub(pos, v2.mul(axis, 2 * along));
}

/**
 * Seeded loot layout: mirror-symmetric team kits plus the center kit. With the fixed layout the kits are
 * mirrored across the vertical axis (unchanged since PR-S2); with a random layout each kit sits
 * `kitOffsetFromSpawn` u from its duo's midpoint toward the center and team-b's kit is team-a's kit
 * mirrored across the center (same reflection as the spawns), so both duos always have the same
 * distance to their guns.
 */
export function createFieldLoot(region: ScenarioRegion, seed: number, spawnLayout?: FieldSpawnLayout): FieldLoot[] {
    const rand = seededRand(seed);
    const scatter = () => v2.create(rand(-kitScatter, kitScatter), rand(-kitScatter, kitScatter));

    const centerX = region.x + region.width / 2;
    const centerY = region.y + region.height / 2;
    const loot: FieldLoot[] = [];

    if (spawnLayout && spawnLayout.layout !== "fixed") {
        const center = spawnLayout.center;
        const midA = v2.mul(v2.add(spawnLayout.spawns["team-a-0"], spawnLayout.spawns["team-a-1"]), 0.5);
        const anchorA = v2.add(
            midA,
            v2.mul(v2.normalizeSafe(v2.sub(center, midA), v2.create(1, 0)), kitOffsetFromSpawn),
        );
        for (const item of teamKit) {
            const posA = v2.add(anchorA, scatter());
            loot.push({ ...item, pos: posA });
            loot.push({ ...item, pos: mirrorAcrossCenter(spawnLayout, posA) });
        }
    } else {
        const leftX = region.x + region.width * 0.25 + kitOffsetFromSpawn;
        const rightX = region.x + region.width * 0.75 - kitOffsetFromSpawn;
        for (const item of teamKit) {
            const offset = scatter();
            loot.push({ ...item, pos: v2.create(leftX + offset.x, centerY + offset.y) });
            loot.push({ ...item, pos: v2.create(rightX - offset.x, centerY + offset.y) });
        }
    }
    for (const item of centerKit) {
        const offset = scatter();
        loot.push({ ...item, pos: v2.create(centerX + offset.x, centerY + offset.y) });
    }
    return loot;
}

export function buildDuo2v2FieldScenario(
    game: Game,
    options: Duo2v2FieldOptions,
): Duo2v2FieldScenario {
    const layout = options.layout ?? "fixed";
    const seed = normalizeSeed(options.seed) ?? 0;
    // the base scenario computes its own region; rebuild it the same way to place the spawns first
    const size = Math.min(options.mapSize, game.map.width, game.map.height);
    const region: ScenarioRegion = {
        x: (game.map.width - size) / 2,
        y: (game.map.height - size) / 2,
        width: size,
        height: size,
    };
    const spawnLayout = createFieldSpawns(region, seed, layout);
    const scenario = buildDuo2v2Scenario(game, {
        seed: options.seed,
        mapSize: options.mapSize,
        spawns: layout === "fixed" ? undefined : spawnLayout.spawns,
    });
    const outfits: Partial<Record<CpcTeamId, string>> = options.teamOutfits === false
        ? {}
        : { ...defaultTeamOutfits, ...options.teamOutfits };
    for (const entry of scenario.players) {
        const dir = spawnLayout.facing[entry.agentId];
        v2.set(entry.player.dir, dir);
        v2.set(entry.player.dirOld, dir);
        const outfit = outfits[entry.teamId];
        if (outfit) entry.player.setOutfit(outfit);
    }

    const loot = createFieldLoot(scenario.scenarioRegion, seed, spawnLayout);
    for (const item of loot) {
        game.lootBarn.addLoot(item.type, item.pos, 0, item.count, { source: "map" });
    }

    const cover = createCoverLayout(scenario.scenarioRegion, seed, options.cover ?? "none");
    applyCoverLayout(game, cover);

    return { ...scenario, loot, spawnLayout, cover };
}
