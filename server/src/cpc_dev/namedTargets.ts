/**
 * Names for the places a decision may point at: `c1` for a piece of cover, `b1` for a building.
 *
 * The planner is told where to go by *name*, never by coordinate — a 90-token block with 45-degree
 * bearings is not enough to pick a spot on a map, and a model asked for coordinates writes "74m E"
 * as `{"x": 74, "y": 0}`. Names close that gap: the state block prints them, the grammar offers
 * exactly the ones in view this turn, and `skillWire` resolves them from the same observation. One
 * helper feeds all three, so the three can never disagree about what `c2` means.
 *
 * Ids are assigned by distance (nearest first) at the moment the question is asked, and a decision
 * is resolved against the observation it was asked about, so they only have to be stable for that
 * one exchange.
 *
 * Cover means *bullet-stopping*: collidable, and at least as tall as a bullet flies
 * (`GameConfig.bullet.height`). A bush hides a player from the eye but not from a shot, so it is
 * never named as cover.
 */

import { GameConfig } from "../../../shared/gameConfig.ts";
import type { Vec2 } from "../../../shared/utils/v2.ts";
import type { AgentObservation } from "./observation.ts";

export interface NamedTarget {
    /** `c1`, `b2`, ... */
    name: string;
    /** short word for the block: `wall`, `stone`, `crate`, `shack` */
    label: string;
    pos: Vec2;
    dist: number;
}

/** How many of each the planner may choose between; more would cost block budget and decide nothing. */
export const maxCover = 6;
export const maxBuildings = 3;

const coverWords = ["wall", "stone", "crate", "barrel", "tree", "locker", "table", "shack", "bunker"];

/** `concrete_wall_ext_5` -> `wall`, `stone_01` -> `stone`: the block has no room for engine ids. */
export function shortLabel(type: string): string {
    const word = coverWords.find((candidate) => type.includes(candidate));
    return word ?? type.replace(/_\d+$/, "");
}

function stops(obstacle: AgentObservation["obstacles"][number]): boolean {
    return obstacle.collidable && obstacle.height >= GameConfig.bullet.height;
}

/** Bullet-stopping obstacles in view, nearest first, as `c1`, `c2`, ... */
export function coverTargets(obs: AgentObservation): NamedTarget[] {
    return obs.obstacles
        .filter(stops)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, maxCover)
        .map((obstacle, index) => ({
            name: `c${index + 1}`,
            label: shortLabel(obstacle.type),
            pos: obstacle.pos,
            dist: obstacle.dist,
        }));
}

/** Buildings in view, nearest first, as `b1`, `b2`, ... */
export function buildingTargets(obs: AgentObservation): NamedTarget[] {
    return (obs.buildings ?? [])
        .slice()
        .sort((a, b) => a.dist - b.dist)
        .slice(0, maxBuildings)
        .map((building, index) => ({
            name: `b${index + 1}`,
            label: shortLabel(building.type),
            pos: building.pos,
            dist: building.dist,
        }));
}

/** `cover:c1` / `building:b2` -> the place it names, or undefined when the name is not one of them. */
export function namedTargetPos(obs: AgentObservation, name: string): Vec2 | undefined {
    if (name.startsWith("cover:")) {
        return coverTargets(obs).find((target) => target.name === name.slice("cover:".length))?.pos;
    }
    if (name.startsWith("building:")) {
        return buildingTargets(obs).find((target) => target.name === name.slice("building:".length))?.pos;
    }
    return undefined;
}
