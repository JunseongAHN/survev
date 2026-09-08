import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../../game/game.ts";
import { normalizeSeed } from "../createScenarioGame.ts";
import {
    buildDuo2v2Scenario,
    type Duo2v2Scenario,
    type Duo2v2ScenarioOptions,
    type ScenarioRegion,
} from "./duo2v2.ts";

export interface FieldLoot {
    type: string;
    count: number;
    pos: Vec2;
}

export interface Duo2v2FieldScenario extends Duo2v2Scenario {
    loot: FieldLoot[];
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

/** Seeded loot layout: mirror-symmetric team kits plus the center kit. */
export function createFieldLoot(region: ScenarioRegion, seed: number): FieldLoot[] {
    // Park-Miller needs a seed in [1, 2^31 - 2]
    const rand = util.seededRand((seed % 2147483646) + 1);
    const scatter = () => v2.create(rand(-kitScatter, kitScatter), rand(-kitScatter, kitScatter));

    const centerX = region.x + region.width / 2;
    const centerY = region.y + region.height / 2;
    const leftX = region.x + region.width * 0.25 + kitOffsetFromSpawn;
    const rightX = region.x + region.width * 0.75 - kitOffsetFromSpawn;

    const loot: FieldLoot[] = [];
    for (const item of teamKit) {
        const offset = scatter();
        loot.push({ ...item, pos: v2.create(leftX + offset.x, centerY + offset.y) });
        loot.push({ ...item, pos: v2.create(rightX - offset.x, centerY + offset.y) });
    }
    for (const item of centerKit) {
        const offset = scatter();
        loot.push({ ...item, pos: v2.create(centerX + offset.x, centerY + offset.y) });
    }
    return loot;
}

export function buildDuo2v2FieldScenario(
    game: Game,
    options: Duo2v2ScenarioOptions,
): Duo2v2FieldScenario {
    const scenario = buildDuo2v2Scenario(game, options);
    const loot = createFieldLoot(scenario.scenarioRegion, normalizeSeed(options.seed) ?? 0);

    for (const item of loot) {
        game.lootBarn.addLoot(item.type, item.pos, 0, item.count, { source: "map" });
    }

    return { ...scenario, loot };
}
