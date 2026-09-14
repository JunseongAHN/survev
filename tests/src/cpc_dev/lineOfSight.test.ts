/**
 * What a shot would do, told to the agent: the line to each enemy, the obstacle sitting on it, and
 * how far each direction is clear. The rule is the engine's own (`bullet.ts`: a bullet passes
 * anything dead, on another layer, shorter than `GameConfig.bullet.height`, or not collidable), so
 * the policy is never told a wall is cover when a bullet would go through it.
 */

import { expect, test } from "vitest";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";
import { type AgentObservation, rayCount, rayRange } from "../../../server/src/cpc_dev/observation.ts";

function observe(cover: "none" | "default"): AgentObservation {
    const episode = new CpcEpisode({ seed: "cpc-line-of-sight", scripted: "idle", controlled: ["team-a-0"], cover });
    const obs = episode.reset().obs["team-a-0"];
    episode.close();
    return obs;
}

test("the open field is clear in every direction", () => {
    const obs = observe("none");
    expect(obs.rays).toHaveLength(rayCount);
    expect(obs.rays.every((d) => d === rayRange)).toBe(true);
});

test("with cover, some directions are blocked and none reads past the range", () => {
    const obs = observe("default");
    expect(obs.rays).toHaveLength(rayCount);
    expect(obs.rays.some((d) => d < rayRange)).toBe(true);
    expect(obs.rays.every((d) => d > 0 && d <= rayRange)).toBe(true);
});

test("a reading is the distance to the thing that would stop the shot", () => {
    const obs = observe("default");
    const blocked = obs.rays.filter((d) => d < rayRange);
    // whatever is stopping the shot is one of the obstacles in view, so no reading is shorter than
    // the nearest bullet-stopping obstacle
    const nearest = Math.min(
        ...obs.obstacles.filter((o) => o.collidable).map((o) => o.dist),
        rayRange,
    );
    for (const reading of blocked) expect(reading).toBeGreaterThanOrEqual(nearest - 3);
});

test("every visible player carries a line-of-sight flag, every obstacle a cover reading", () => {
    const obs = observe("default");
    for (const player of obs.players) expect(typeof player.los_blocked).toBe("boolean");
    for (const obstacle of obs.obstacles) {
        expect(typeof obstacle.blocks_los).toBe("boolean");
        expect(obstacle.cover_score).toBeGreaterThanOrEqual(0);
        expect(obstacle.cover_score).toBeLessThanOrEqual(1);
    }
});

test("with nothing to hide behind, nothing claims to be cover", () => {
    const obs = observe("none");
    expect(obs.obstacles).toHaveLength(0);
    expect(obs.players.every((p) => !p.los_blocked)).toBe(true);
});
