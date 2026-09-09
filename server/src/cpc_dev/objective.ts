import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Player } from "../game/objects/player.ts";
import type { ScenarioRegion } from "./scenarios/duo2v2.ts";
import { seededRand } from "./seededRand.ts";

/**
 * "race": one shared objective point at a time, visible to every agent. The first standing player to
 * come within `radius` captures it for their team; the point then moves to a fresh seeded position
 * `minDist..maxDist` away from the previous one (rejection sampled inside the region minus `margin`).
 * Points keep coming until the episode's time limit, so a team that eliminates the other collects the
 * rest uncontested — that, not an explicit death penalty, is what makes staying alive and fighting pay.
 */
export interface ObjectiveOptions {
    mode: "none" | "race";
    /** capture radius in world units */
    radius?: number;
    /** distance from the previous point (or the region center for the first one) */
    minDist?: number;
    maxDist?: number;
    /** points are kept this far from the region border */
    margin?: number;
}

export interface ObjectivePoint {
    index: number;
    pos: Vec2;
    radius: number;
    /** game time the point appeared */
    spawnedAt: number;
}

export interface CaptureEvent {
    type: "capture";
    t: number;
    playerId: number;
    index: number;
    pos: Vec2;
    /** seconds the point was up before it was captured */
    timeToCapture: number;
}

export const objectiveSeedStream = 104729;
const defaultObjective = { radius: 4, minDist: 30, maxDist: 70, margin: 12 } as const;

export class RaceObjective {
    readonly radius: number;
    readonly minDist: number;
    readonly maxDist: number;
    readonly margin: number;
    current: ObjectivePoint;
    captures: CaptureEvent[] = [];
    private readonly rand: (min?: number, max?: number) => number;

    constructor(
        readonly region: ScenarioRegion,
        seed: number,
        options: Omit<ObjectiveOptions, "mode"> = {},
        t0 = 0,
    ) {
        this.radius = options.radius ?? defaultObjective.radius;
        this.minDist = options.minDist ?? defaultObjective.minDist;
        this.maxDist = options.maxDist ?? defaultObjective.maxDist;
        this.margin = options.margin ?? defaultObjective.margin;
        this.rand = seededRand(seed, objectiveSeedStream);
        const center = v2.create(region.x + region.width / 2, region.y + region.height / 2);
        this.current = { index: 0, pos: this.sample(center), radius: this.radius, spawnedAt: t0 };
    }

    /** Uniform point inside the region (minus margin) at `minDist..maxDist` from `from`; falls back after 64 tries. */
    private sample(from: Vec2): Vec2 {
        const x0 = this.region.x + this.margin;
        const x1 = this.region.x + this.region.width - this.margin;
        const y0 = this.region.y + this.margin;
        const y1 = this.region.y + this.region.height - this.margin;
        let last = v2.create(this.rand(x0, x1), this.rand(y0, y1));
        for (let i = 0; i < 64; i++) {
            const d = v2.distance(last, from);
            if (d >= this.minDist && d <= this.maxDist) return last;
            last = v2.create(this.rand(x0, x1), this.rand(y0, y1));
        }
        return last;
    }

    /**
     * Call once per game tick after `game.update()`. Returns the capture event when a standing player is
     * within the radius (closest player wins a same-tick tie) and moves the point.
     */
    tick(players: Player[], t: number): CaptureEvent | undefined {
        let best: { player: Player; dist: number } | undefined;
        for (const player of players) {
            if (player.dead || player.downed) continue;
            const dist = v2.distance(player.pos, this.current.pos);
            if (dist <= this.radius && (!best || dist < best.dist)) best = { player, dist };
        }
        if (!best) return undefined;
        const event: CaptureEvent = {
            type: "capture",
            t,
            playerId: best.player.__id,
            index: this.current.index,
            pos: v2.copy(this.current.pos),
            timeToCapture: t - this.current.spawnedAt,
        };
        this.captures.push(event);
        this.current = {
            index: this.current.index + 1,
            pos: this.sample(this.current.pos),
            radius: this.radius,
            spawnedAt: t,
        };
        return event;
    }

    /** What an agent's client would show: the point, its radius and the agent's distance to it. */
    observe(pos: Vec2): { index: number; pos: Vec2; radius: number; dist: number } {
        return {
            index: this.current.index,
            pos: { x: this.current.pos.x, y: this.current.pos.y },
            radius: this.radius,
            dist: v2.distance(pos, this.current.pos),
        };
    }
}
