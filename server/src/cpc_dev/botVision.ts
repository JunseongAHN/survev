/**
 * What a scripted bot can actually see.
 *
 * Until now `selectSkill` picked the nearest living enemy out of `ctx.players` with no line-of-sight
 * test, and the chaser's engage distance is infinite — so the bots were omniscient, and breaking
 * line of sight did nothing to their pursuit. That made withdrawing impossible by construction: over
 * three seeds the nearest-enemy distance and the "enemy is closing" rate came out the same whether
 * the controller was told to engage or to retreat (24-27 m, ~50% of steps, either way). A planner
 * whose choices cannot change the world is not a hierarchy.
 *
 * So a bot sees an enemy when it is inside `sightRange` and no obstacle blocks the line — the
 * engine's own bullet rule via `firstBlocker`, the same test the observations and the reward use, so
 * the agent, its opponent and the thing that pays it all agree on what "behind cover" means. When
 * sight is lost the bot pursues the last place it saw the enemy for `pursuitMemory` seconds and then
 * gives up, which is what makes "break the line and stay hidden" an actual escape.
 */

import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
import type { Player } from "../game/objects/player.ts";
import { firstBlocker } from "./observation.ts";

/**
 * How far a bot notices an enemy at all (world units).
 *
 * Deliberately larger than the duos' opening distance (spawns sit 32 u either side of the centre, so
 * 64 u apart): the mechanic being added here is that *obstacles* break contact, not distance. At 60
 * the two duos could not see each other at spawn and simply stood still.
 */
export const defaultSightRange = 100;
/** How long a bot keeps chasing the last place it saw an enemy (seconds). */
export const defaultPursuitMemory = 3;

export interface Sighting {
    /** where the enemy was when it was last seen */
    pos: Vec2;
    /** game time of that sighting */
    t: number;
}

/** Per bot, per enemy: the last time and place that bot saw that enemy. */
export type SightMemory = Map<number, Map<number, Sighting>>;

export interface VisionOptions {
    /** `omniscient` restores the pre-2026-09-14 behaviour, for reproducing old baselines */
    vision?: "line_of_sight" | "omniscient";
    sightRange?: number;
    pursuitMemory?: number;
}

export function canSee(
    game: Game,
    me: Player,
    target: Player,
    sightRange: number = defaultSightRange,
): boolean {
    if (v2.distance(me.pos, target.pos) > sightRange) return false;
    return !firstBlocker(game, me.pos, target.pos, me.layer);
}

/** Record what `me` can see now, and forget nothing — stale sightings are aged out by the reader. */
export function rememberSightings(
    memory: SightMemory,
    game: Game,
    me: Player,
    enemies: Player[],
    t: number,
    sightRange: number = defaultSightRange,
): Player[] {
    let mine = memory.get(me.__id);
    if (!mine) memory.set(me.__id, (mine = new Map()));
    const seen: Player[] = [];
    for (const enemy of enemies) {
        if (!canSee(game, me, enemy, sightRange)) continue;
        seen.push(enemy);
        mine.set(enemy.__id, { pos: v2.copy(enemy.pos), t });
    }
    return seen;
}

/**
 * The freshest sighting still worth chasing, or `undefined` once the trail has gone cold.
 *
 * Only enemies that are still alive are remembered as targets: walking to where a dead player was
 * standing is not pursuit, it is a bug that would read as one.
 */
export function lastKnown(
    memory: SightMemory,
    me: Player,
    enemies: Player[],
    t: number,
    pursuitMemory: number = defaultPursuitMemory,
): Sighting | undefined {
    const mine = memory.get(me.__id);
    if (!mine) return undefined;
    let best: Sighting | undefined;
    for (const enemy of enemies) {
        const seen = mine.get(enemy.__id);
        if (!seen || t - seen.t > pursuitMemory) continue;
        if (!best || seen.t > best.t) best = seen;
    }
    return best;
}
