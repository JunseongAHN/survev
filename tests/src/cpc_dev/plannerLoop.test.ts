/**
 * The commit/interrupt loop, with the planner replaced by a promise the test controls. No network:
 * what is under test is the shape of the loop — it never waits, it holds a decision for its window,
 * it asks again on the plan's interrupts, and it falls back instead of freezing.
 */

import { beforeEach, expect, test } from "vitest";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";
import type { AgentObservation } from "../../../server/src/cpc_dev/observation.ts";
import type { PlannerReply } from "../../../server/src/cpc_dev/plannerClient.ts";
import { parseDecision } from "../../../server/src/cpc_dev/plannerClient.ts";
import { type PlannerEvent, PlannerLoop } from "../../../server/src/cpc_dev/plannerLoop.ts";
import type { SkillChoice } from "../../../server/src/cpc_dev/scriptedPolicy.ts";

let baseObs: AgentObservation;

beforeEach(() => {
    const episode = new CpcEpisode({ seed: "cpc-planner-loop", scripted: "idle", controlled: ["team-a-0"] });
    baseObs = episode.reset().obs["team-a-0"];
    episode.close();
});

const clone = (obs: AgentObservation): AgentObservation => structuredClone(obs);
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A planner that answers only when the test says so. */
function scriptedPlanner() {
    const asked: string[] = [];
    let answer: ((reply: PlannerReply) => void) | undefined;
    return {
        asked,
        ask: (block: string) => {
            asked.push(block);
            return new Promise<PlannerReply>((resolve) => (answer = resolve));
        },
        reply: (reply: PlannerReply) => answer!(reply),
    };
}

const fallbackChoice: SkillChoice = { skill: "loot", params: {} };
const fallback = () => fallbackChoice;
const heal = (commit_ms = 1200): PlannerReply => ({
    decision: { skill: "heal", params: {}, commit_ms, say: "힐할게" },
    latencyMs: 250,
});

function makeLoop(planner: ReturnType<typeof scriptedPlanner>, resolve?: () => SkillChoice) {
    const events: PlannerEvent[] = [];
    const loop = new PlannerLoop({
        agentId: "team-a-0",
        ask: planner.ask,
        resolve: resolve ?? ((request) => ({ skill: request.skill, params: {} }) as SkillChoice),
        onEvent: (e) => events.push(e),
        errorBackoff: 0.5,
    });
    return { loop, events };
}

test("it never waits: the fallback runs until the first reply, then the decision is committed", async () => {
    const planner = scriptedPlanner();
    const { loop, events } = makeLoop(planner);

    expect(loop.decide(0, baseObs, undefined, fallback)).toBe(fallbackChoice);
    expect(loop.source).toBe("fallback");
    expect(planner.asked).toHaveLength(1);
    expect(planner.asked[0]).toContain("[t=0s you=team-a-0");
    expect(events[0]).toMatchObject({ kind: "asked", reason: "start" });

    // still in flight: keep playing on the fallback, and do not ask twice
    expect(loop.decide(0.1, baseObs, undefined, fallback)).toBe(fallbackChoice);
    expect(planner.asked).toHaveLength(1);

    planner.reply(heal());
    await flush();
    const choice = loop.decide(0.3, baseObs, undefined, fallback);
    expect(choice?.skill).toBe("heal");
    expect(loop.source).toBe("planner");
    expect(events.at(-1)).toMatchObject({ kind: "decided", skill: "heal", say: "힐할게", commitMs: 1200 });
});

test("a decision is held for its window, then the planner is asked again while it keeps running", async () => {
    const planner = scriptedPlanner();
    const { loop, events } = makeLoop(planner);
    loop.decide(0, baseObs, undefined, fallback);
    planner.reply(heal(1200));
    await flush();
    loop.decide(0.2, baseObs, undefined, fallback);

    const running = { action: {}, done: false };
    expect(loop.decide(0.9, baseObs, running, fallback)?.skill).toBe("heal");
    expect(planner.asked).toHaveLength(1);

    // window closed (0.2 + 1.2 s): ask again, but keep healing until the answer arrives
    expect(loop.decide(1.5, baseObs, running, fallback)?.skill).toBe("heal");
    expect(planner.asked).toHaveLength(2);
    expect(events.filter((e) => e.kind === "asked").at(-1)).toMatchObject({ reason: "commit_expired" });
});

test("a finished skill is dropped for the fallback while the next decision is pending", async () => {
    const planner = scriptedPlanner();
    const { loop, events } = makeLoop(planner);
    loop.decide(0, baseObs, undefined, fallback);
    planner.reply(heal(3000));
    await flush();
    loop.decide(0.2, baseObs, undefined, fallback);

    expect(loop.decide(1.0, baseObs, { action: {}, done: true }, fallback)).toBe(fallbackChoice);
    expect(loop.source).toBe("fallback");
    expect(events.filter((e) => e.kind === "asked").at(-1)).toMatchObject({ reason: "skill_done" });
});

test("getting hit, a new enemy and a downed teammate each interrupt the commitment", async () => {
    for (
        const [mutate, reason] of [
            [(o: AgentObservation) => (o.self.hp -= 15), "hit"],
            [(o: AgentObservation) =>
                o.players.push(
                    { ...o.teammates[0], team: "team-b", id: "team-b-0", dir: { x: 1, y: 0 }, weapon: "ak47" } as never,
                ), "enemy_seen"],
            [(o: AgentObservation) => (o.teammates[0].downed = true), "mate_downed"],
        ] as const
    ) {
        const planner = scriptedPlanner();
        const { loop, events } = makeLoop(planner);
        loop.decide(0, baseObs, undefined, fallback);
        planner.reply(heal(3000));
        await flush();
        loop.decide(0.2, baseObs, undefined, fallback);

        const changed = clone(baseObs);
        mutate(changed);
        loop.decide(0.4, changed, { action: {}, done: false }, fallback);
        expect(planner.asked, reason).toHaveLength(2);
        expect(events.filter((e) => e.kind === "asked").at(-1)).toMatchObject({ reason });
    }
});

test("a planner error falls back, and the loop waits out the backoff before asking again", async () => {
    const planner = scriptedPlanner();
    const { loop, events } = makeLoop(planner);
    loop.decide(0, baseObs, undefined, fallback);
    planner.reply({ error: "planner unreachable: connect ECONNREFUSED", latencyMs: 3 });
    await flush();

    expect(loop.decide(0.1, baseObs, undefined, fallback)).toBe(fallbackChoice);
    expect(events.at(-1)).toMatchObject({ kind: "error" });
    expect(planner.asked).toHaveLength(1);
    loop.decide(0.4, baseObs, undefined, fallback);
    expect(planner.asked).toHaveLength(1);
    loop.decide(0.7, baseObs, undefined, fallback);
    expect(planner.asked).toHaveLength(2);
});

test("a decision that cannot run is rejected, not committed", async () => {
    const planner = scriptedPlanner();
    const { loop, events } = makeLoop(planner, () => {
        throw new Error("move_to.params.to: team-b-0 is not in view");
    });
    loop.decide(0, baseObs, undefined, fallback);
    planner.reply(heal());
    await flush();

    expect(loop.decide(0.2, baseObs, undefined, fallback)).toBe(fallbackChoice);
    expect(events.at(-1)).toMatchObject({ kind: "rejected", error: expect.stringContaining("not in view") });
});

test("parseDecision accepts a grammar-shaped reply and refuses the rest", () => {
    expect(parseDecision(`{"skill":"engage","params":{"target":"team-b-0"},"commit_ms":600,"say":null}`, 200))
        .toMatchObject({ decision: { skill: "engage", commit_ms: 600, say: null }, latencyMs: 200 });
    expect(parseDecision(`{"skill":"loot","params":{}}`, 1).decision?.commit_ms).toBe(1200);
    expect(parseDecision(`{"skill":"dance","params":{}}`, 1).error).toMatch(/unknown skill/);
    expect(parseDecision(`{"skill":"loot"}`, 1).error).toMatch(/no params/);
    expect(parseDecision(`{"skill":"lo`, 1).error).toMatch(/not JSON/);
});

// the first live session: armed, the planner kept choosing `loot`, which completes on its first tick,
// so the loop asked three times a second; a decision that finishes at once now earns a pause
test("a decision that finishes at once is not re-asked immediately", async () => {
    const planner = scriptedPlanner();
    const { loop } = makeLoop(planner);
    loop.decide(0, baseObs, undefined, fallback);
    planner.reply(heal(1800));
    await flush();
    loop.decide(0.2, baseObs, undefined, fallback);

    // done 0.1 s after it was committed: fall back, and hold off
    expect(loop.decide(0.3, baseObs, { action: {}, done: true }, fallback)).toBe(fallbackChoice);
    expect(planner.asked).toHaveLength(1);
    loop.decide(0.9, baseObs, undefined, fallback);
    expect(planner.asked).toHaveLength(1);
    loop.decide(1.35, baseObs, undefined, fallback);
    expect(planner.asked).toHaveLength(2);
});

// the playtest's eight revives under fire: every question now carries the skills that may run, and
// the block tells the model the same thing the grammar enforces
test("each question offers only the skills that can run now", async () => {
    const { availableSkills } = await import("../../../server/src/cpc_dev/skillMask.ts");
    const offered: Array<readonly string[]> = [];
    const blocks: string[] = [];
    const loop = new PlannerLoop({
        agentId: "team-a-0",
        ask: (block, skills) => {
            blocks.push(block);
            offered.push(skills);
            return new Promise<PlannerReply>(() => {});
        },
        resolve: (request) => ({ skill: request.skill, params: {} }) as SkillChoice,
    });
    const obs = clone(baseObs);
    obs.teammates[0].downed = true;
    obs.players.push(
        {
            ...obs.teammates[0],
            team: "team-b",
            id: "team-b-0",
            dist: 21,
            dir: { x: 1, y: 0 },
            downed: false,
            dead: false,
            weapon: "ak47",
        } as never,
    );
    loop.decide(0, obs, undefined, fallback);

    expect(offered[0]).toEqual(availableSkills(obs));
    expect(offered[0]).not.toContain("revive");
    expect(blocks[0]).toContain(`[can do: ${offered[0].join(", ")}]`);
});
