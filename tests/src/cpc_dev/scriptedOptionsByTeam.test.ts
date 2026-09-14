/**
 * Weakening one team only.
 *
 * A trained policy fights bots with aim noise and a reaction delay; the scripted baseline it is
 * compared against has to fight the same weakened bots, or the comparison measures the handicap
 * rather than the policy. One shared options object could not say that.
 *
 * Every assertion here sums over several episodes on purpose. The episode seed fixes the map,
 * spawns and the scripted aim noise, but not the fight: the engine rolls headshots with a bare
 * `Math.random()` (`player.ts`), so the same seed can end in four seconds or eight. A single
 * episode is therefore not a stable unit to assert on — an earlier version of this file asserted
 * on one and failed roughly one run in three.
 */

import { expect, test } from "vitest";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";

const seeds = ["cpc-team-options", "cpc-team-options-2", "cpc-team-options-3"];

function damageByTeam(
    seed: string,
    options: Record<string, object> | undefined,
): Record<string, number> {
    const episode = new CpcEpisode({
        seed,
        scripted: "chaser",
        loadout: "armed",
        controlled: [],
        scriptedOptionsByTeam: options as never,
    });
    episode.reset();
    let msg = episode.step({}, 10);
    while (!msg.done && msg.t < 12) msg = episode.step({}, 10);
    const metrics = msg.info.metrics ?? {};
    episode.close();
    const dealt: Record<string, number> = { "team-a": 0, "team-b": 0 };
    for (const [agentId, m] of Object.entries(metrics)) {
        dealt[agentId.startsWith("team-a") ? "team-a" : "team-b"] += m.damage_dealt;
    }
    return dealt;
}

function totalDamage(options: Record<string, object> | undefined): Record<string, number> {
    const total: Record<string, number> = { "team-a": 0, "team-b": 0 };
    for (const seed of seeds) {
        const dealt = damageByTeam(seed, options);
        total["team-a"] += dealt["team-a"];
        total["team-b"] += dealt["team-b"];
    }
    return total;
}

test("both teams shoot when neither is handicapped", () => {
    const dealt = totalDamage(undefined);
    expect(dealt["team-a"]).toBeGreaterThan(0);
    expect(dealt["team-b"]).toBeGreaterThan(0);
});

test("a reaction delay longer than the fight silences that team alone", () => {
    // team-b never fires, in any episode; team-a is untouched by the handicap
    const dealt = totalDamage({ "team-b": { reactionDelay: 999 } });
    expect(dealt["team-b"]).toBe(0);
    expect(dealt["team-a"]).toBeGreaterThan(0);
});
