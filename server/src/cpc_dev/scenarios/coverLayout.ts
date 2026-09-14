/**
 * Deterministic cover for the 2v2 scenarios.
 *
 * The field scenario is bare by design — `test_normal` generates no obstacles, so combat there is a
 * duel in the open. Cover-aware fighting (peeking, reloading out of sight, holding an angle) needs
 * something to hide behind, and it needs the *same* something every run: a seeded layout is
 * reproducible, its density is a difficulty knob, and none of it touches the map generator.
 *
 * Cover draws from its own random stream, so adding it to an existing seed leaves the spawn geometry
 * and the loot exactly where they were. `none` is the default everywhere; `duo2v2_field` stays the
 * open field the PPO runs and the v0 baseline were measured on.
 *
 * Only bullet-stopping pieces are placed: the engine lets a bullet pass anything shorter than
 * `GameConfig.bullet.height` (0.25) or not collidable, which is why bushes (collidable: false) are
 * absent — they hide a player from the eye but not from a shot.
 */

import { MsgType } from "../../../../shared/net/net.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../../game/game.ts";
import { seededRand } from "../seededRand.ts";
import type { ScenarioRegion } from "./duo2v2.ts";

export type CoverDensity = "none" | "sparse" | "default" | "dense";

export interface CoverPiece {
    kind: "obstacle" | "building";
    /** map object type, e.g. `stone_01` or `shack_01` */
    type: string;
    pos: Vec2;
    /** survev orientation, 0-3 (90 degrees each) */
    ori: number;
    /** half-extent kept clear around the piece when placing the next one */
    gap: number;
}

interface Recipe {
    /** indestructible concrete, the backbone: an angle that is still there a minute later */
    walls: number;
    /** 250 hp, survives a magazine */
    stones: number;
    /** 140 hp: cover that wears out under fire */
    crates: number;
    /** a shack: four walls, a doorway, and loot inside */
    shacks: number;
}

/**
 * Counts are **per side**: every piece is mirrored, so a recipe of 2 walls places 4. `band` is the
 * fraction of the region each recipe may spread over — a denser recipe needs more ground, otherwise
 * the placement runs out of room and "dense" quietly lands fewer pieces than "default".
 */
const recipes: Record<Exclude<CoverDensity, "none">, Recipe & { band: number }> = {
    sparse: { walls: 1, stones: 1, crates: 2, shacks: 0, band: 0.2 },
    default: { walls: 2, stones: 2, crates: 3, shacks: 1, band: 0.26 },
    dense: { walls: 3, stones: 4, crates: 5, shacks: 1, band: 0.3 },
};

/** its own stream: adding cover to a seed must not move that seed's loot or spawns */
const coverStream = 611953;

/**
 * Spawns sit 32 u out on the x axis, the kits 22 u out and one at the centre (see `duo2v2Field`).
 *
 * These radii used to be 11 and 7. On the axis the circles then joined into one clear lane from
 * x=-43 to x=+43 — exactly where the duos meet — and every piece was pushed 9 to 32 u off it. The
 * fight happened in the open: a trained controller had an armed enemy's line broken in 1% of its
 * steps, less often than the scripted bots managed by accident. A player is about 1 u across, so 6 u
 * of room at a spawn and 4 u at a loot pile is enough to keep them reachable.
 */
function keepClear(centre: Vec2): Array<{ pos: Vec2; r: number }> {
    return [
        { pos: v2.create(centre.x - 32, centre.y - 6.4), r: 6 },
        { pos: v2.create(centre.x - 32, centre.y + 6.4), r: 6 },
        { pos: v2.create(centre.x + 32, centre.y - 6.4), r: 6 },
        { pos: v2.create(centre.x + 32, centre.y + 6.4), r: 6 },
        { pos: v2.create(centre.x - 22, centre.y), r: 4 },
        { pos: v2.create(centre.x + 22, centre.y), r: 4 },
        { pos: centre, r: 4 },
    ];
}

/** Half of every kind is placed within this distance of the line the duos face each other along. */
export const axisBand = 8;

/**
 * Where the duos actually meet. Pieces are drawn in the western half of the band and each one is
 * mirrored through the centre, the way `duo2v2Field` mirrors the kits: a fight is only about skill
 * if both duos approach the same geometry. A seeded draw keeps it reproducible; density is the knob.
 */
export function createCoverLayout(
    region: ScenarioRegion,
    seed: number,
    density: CoverDensity = "none",
): CoverPiece[] {
    if (density === "none") return [];
    const recipe = recipes[density];
    const rand = seededRand(seed, coverStream);
    const centre = v2.create(region.x + region.width / 2, region.y + region.height / 2);
    const clear = keepClear(centre);
    const halfWidth = region.width * recipe.band; // ~29 u on a 128 region at the default density
    const halfHeight = region.height * recipe.band;
    const pieces: CoverPiece[] = [];
    const mirror = (pos: Vec2) => v2.create(2 * centre.x - pos.x, 2 * centre.y - pos.y);

    const fits = (pos: Vec2, gap: number): boolean =>
        clear.every((spot) => v2.length(v2.sub(pos, spot.pos)) > spot.r + gap)
        && pieces.every((piece) => v2.length(v2.sub(pos, piece.pos)) > piece.gap + gap);

    const place = (perSide: number, kind: CoverPiece["kind"], types: string[], gap: number): void => {
        for (let placed = 0; placed < perSide;) {
            // Half of the small pieces go where the duos actually meet. Walls and shacks are not
            // pinned there: a shack keeps 12 u clear and the axis band is only 16 u tall, so forcing
            // one into it fills the lane and the kinds placed after it find no room at all — seed 2
            // came out with four walls, two crates and nothing else.
            const small = gap <= 4;
            const wantAxis = small && placed < Math.ceil(perSide / 2);
            let found = false;
            // two passes: try the axis first when it is wanted, then fall back to the whole band so a
            // crowded lane can never end the placement early. The draw order stays deterministic.
            for (let attempt = 0; attempt < 400 && !found; attempt++) {
                const spreadY = wantAxis && attempt < 200 ? axisBand : halfHeight;
                // west half only, clear of the centre line so a piece and its mirror never collide
                const pos = v2.create(
                    centre.x - rand(gap + 2, halfWidth),
                    centre.y + rand(-spreadY, spreadY),
                );
                const twin = mirror(pos);
                const type = types[Math.floor(rand(0, types.length)) % types.length];
                const ori = Math.floor(rand(0, 4)) % 4;
                if (!fits(pos, gap) || !fits(twin, gap)) continue;
                pieces.push({ kind, type, pos, ori, gap });
                pieces.push({ kind, type, pos: twin, ori, gap });
                found = true;
            }
            if (!found) return; // the band is full; a sparser layout is better than an overlapping one
            placed++;
        }
    };

    // biggest first: a shack needs room, a crate can take what is left
    place(recipe.shacks, "building", ["shack_01"], 12);
    place(recipe.walls, "obstacle", ["concrete_wall_ext_5", "concrete_wall_ext_25"], 6);
    place(recipe.stones, "obstacle", ["stone_01", "stone_02"], 4);
    place(recipe.crates, "obstacle", ["crate_02", "crate_01"], 3.5);
    return pieces;
}

/**
 * Put the layout into a live or offline game, after the map has been generated.
 *
 * The map message is serialized once at the end of `map.init()` and that one buffer is what every
 * joining client receives, so obstacles added later exist on the server and are never drawn. Writing
 * the message again after placing them is what makes the cover visible (and puts it on the minimap).
 */
export function applyCoverLayout(game: Game, pieces: readonly CoverPiece[]): void {
    if (!pieces.length) return;
    for (const piece of pieces) {
        if (piece.kind === "building") {
            game.map.genBuilding(piece.type, piece.pos, 0, piece.ori);
        } else {
            game.map.genObstacle(piece.type, piece.pos, 0, piece.ori);
        }
    }
    game.map.mapStream.stream.index = 0;
    game.map.mapStream.serializeMsg(MsgType.Map, game.map.msg);
}

export function coverDensityFrom(value: string | undefined, where: string): CoverDensity {
    const density = (value ?? "none") as CoverDensity;
    if (!["none", "sparse", "default", "dense"].includes(density)) {
        throw new Error(`${where} must be none | sparse | default | dense, got ${value}`);
    }
    return density;
}
