/**
 * The prompt System 2 reads. Two things matter and both are tested here: it is built from the
 * agent's observation and nothing else (so information-set parity holds by construction), and it
 * fits the ~400 token budget the plan sets, because the persona and skill list are a fixed prefix
 * and this block is what gets re-sent on every call.
 */

import { expect, test } from "vitest";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";
import { bearing, buildStateBlock } from "../../../server/src/cpc_dev/stateBlock.ts";
import { v2 } from "../../../shared/utils/v2.ts";

/** ~4 characters per token is the usual rule of thumb for English/ASCII prompts. */
const tokenEstimate = (text: string) => Math.ceil(text.length / 4);

test("bearings are world space, where y grows upward", () => {
    const origin = v2.create(0, 0);
    expect(bearing(origin, v2.create(0, 10))).toBe("N");
    expect(bearing(origin, v2.create(0, -10))).toBe("S");
    expect(bearing(origin, v2.create(10, 0))).toBe("E");
    expect(bearing(origin, v2.create(-10, 10))).toBe("NW");
    expect(bearing(origin, origin)).toBe("here");
});

test("a real observation becomes a block that fits the budget", () => {
    const episode = new CpcEpisode({
        seed: "cpc-state-block",
        scripted: "chaser",
        controlled: ["team-a-0", "team-a-1"],
        loadout: "armed",
        objective: { mode: "race", radius: 4 },
    });
    let msg = episode.reset();

    let worst = 0;
    let sample = "";
    for (let step = 0; step < 40 && !msg.done; step++) {
        const obs = msg.obs["team-a-0"];
        const block = buildStateBlock(obs, {
            agentId: "team-a-0",
            t: msg.t,
            currentSkill: msg.info.skills?.["team-a-0"] ?? null,
            chat: ["team-a-1: 밀자"],
        });
        const tokens = tokenEstimate(block);
        if (tokens > worst) {
            worst = tokens;
            sample = block;
        }
        msg = episode.step({}, 10);
    }
    episode.close();

    // the whole point of the compact block: it has to stay inside the plan's 400-token budget even
    // in a busy step (both enemies visible, loot everywhere, shots incoming, the race point up)
    expect(worst).toBeLessThanOrEqual(400);
    expect(worst).toBeGreaterThan(20); // and it is not empty
    expect(sample).toMatch(/^\[t=\d+s you=team-a-0 \d+hp/);
    expect(sample).toContain("[weapon:");
    expect(sample).toContain("[teammate team-a-1:");
});

test("the block never names anything the agent cannot see", () => {
    const episode = new CpcEpisode({ seed: "cpc-state-block", scripted: "idle", controlled: ["team-a-0"] });
    const msg = episode.reset();
    const obs = msg.obs["team-a-0"];
    const block = buildStateBlock(obs, { agentId: "team-a-0", t: 0 });
    episode.close();

    // at spawn the enemy duo is 64 u away, outside the view rectangle, so it is not in the block
    expect(obs.players).toHaveLength(0);
    expect(block).not.toContain("team-b");
    // the teammate is on the HUD whether or not it is visible, which is what a client shows
    expect(block).toContain("team-a-1");
});

test("an empty topic is omitted rather than printed empty", () => {
    const episode = new CpcEpisode({ seed: "cpc-state-block", scripted: "idle", controlled: ["team-a-0"] });
    const msg = episode.reset();
    const block = buildStateBlock(msg.obs["team-a-0"], { agentId: "team-a-0", t: 0 });
    episode.close();
    expect(block).not.toMatch(/\[enemies seen: \]/);
    expect(block).not.toMatch(/\[shots heard: \]/);
    expect(block).not.toContain("[point:"); // no objective in this episode
});

test("the skills that can run now are listed, and omitted when not given", () => {
    const episode = new CpcEpisode({ seed: "cpc-state-block", scripted: "idle", controlled: ["team-a-0"] });
    const obs = episode.reset().obs["team-a-0"];
    episode.close();
    expect(buildStateBlock(obs, { agentId: "team-a-0", t: 0, canDo: ["loot", "move_to"] }))
        .toContain("[can do: loot, move_to]");
    expect(buildStateBlock(obs, { agentId: "team-a-0", t: 0 })).not.toContain("[can do:");
    expect(buildStateBlock(obs, { agentId: "team-a-0", t: 0, canDo: [] })).not.toContain("[can do:");
});

test("cover and buildings are named, so a decision can point at one", () => {
    const episode = new CpcEpisode({
        seed: "cpc-state-block-cover",
        scripted: "idle",
        controlled: ["team-a-0"],
        cover: "default",
    });
    const obs = episode.reset().obs["team-a-0"];
    episode.close();

    const block = buildStateBlock(obs, { agentId: "team-a-0", t: 0 });
    const coverLine = block.split("\n").find((line) => line.startsWith("[cover:"));
    expect(coverLine, block).toBeDefined();
    // `c1 stone 8m NE`: a name the grammar will offer and the resolver will look up
    expect(coverLine).toMatch(/\[cover: c1 [a-z]+ \d+m [NESW]{1,2}/);
    expect(coverLine).not.toContain("_01"); // engine ids never reach the planner
});

test("no cover, no line", () => {
    const episode = new CpcEpisode({ seed: "cpc-state-block-bare", scripted: "idle", controlled: ["team-a-0"] });
    const obs = episode.reset().obs["team-a-0"];
    episode.close();
    const block = buildStateBlock(obs, { agentId: "team-a-0", t: 0 });
    expect(block).not.toContain("[cover:");
    expect(block).not.toContain("[buildings:");
});
