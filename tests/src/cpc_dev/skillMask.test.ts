/**
 * The per-question skill mask. Each case is a decision the planner got wrong in the first playtest
 * or the benchmark, and the mask is what now makes it unrepresentable.
 */

import { beforeEach, expect, test } from "vitest";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";
import type { AgentObservation } from "../../../server/src/cpc_dev/observation.ts";
import { availableSkills } from "../../../server/src/cpc_dev/skillMask.ts";

let unarmed: AgentObservation;
let armed: AgentObservation;

beforeEach(() => {
    for (const loadout of ["fists", "armed"] as const) {
        const episode = new CpcEpisode({ seed: "cpc-skill-mask", scripted: "idle", controlled: ["team-a-0"], loadout });
        const obs = episode.reset().obs["team-a-0"];
        episode.close();
        if (loadout === "fists") unarmed = obs;
        else armed = obs;
    }
});

const clone = (obs: AgentObservation) => structuredClone(obs);
const enemy = (over: Partial<AgentObservation["players"][number]>): AgentObservation["players"][number] => ({
    id: "team-b-0",
    team: "team-b",
    pos: { x: 0, y: 0 },
    dist: 21,
    dir: { x: 1, y: 0 },
    downed: false,
    dead: false,
    weapon: "ak47",
    los_blocked: false,
    ...over,
});

test("unarmed at spawn: go get a gun; nothing to fight, nobody to revive", () => {
    const skills = availableSkills(unarmed);
    expect(skills).toContain("loot");
    expect(skills).toContain("move_to");
    expect(skills).toContain("follow");
    expect(skills).not.toContain("engage");
    expect(skills).not.toContain("revive");
    expect(skills).not.toContain("heal"); // full hp
});

test("armed with ammo: loot has nothing to do, so it is not offered", () => {
    expect(availableSkills(armed)).not.toContain("loot");
});

test("armed but out of ammo entirely: loot is offered again", () => {
    const dry = clone(armed);
    dry.self.clip = 0;
    dry.self.reserve = 0;
    expect(availableSkills(dry)).toContain("loot");
});

test("heal only when hurt and holding something to heal with", () => {
    const hurt = clone(armed);
    hurt.self.hp = 40;
    for (const item of ["bandage", "healthkit", "soda", "painkiller"]) hurt.self.inventory[item] = 0;
    expect(availableSkills(hurt)).not.toContain("heal");
    hurt.self.inventory.bandage = 2;
    expect(availableSkills(hurt)).toContain("heal");
});

test("the playtest: teammate downed 2 m away, an armed enemy at 21 m -> no revive, fight instead", () => {
    const obs = clone(armed);
    obs.teammates[0].downed = true;
    obs.players.push(enemy({ dist: 21 }));
    const skills = availableSkills(obs);
    expect(skills).not.toContain("revive");
    expect(skills).toContain("engage");
    expect(skills).toContain("retreat");
});

test("revive is offered once the threat is gone, far away, unarmed, or downed", () => {
    for (
        const other of [
            undefined,
            enemy({ dist: 40 }),
            enemy({ dist: 8, weapon: "fists" }),
            enemy({ dist: 8, downed: true }),
        ]
    ) {
        const obs = clone(armed);
        obs.teammates[0].downed = true;
        if (other) obs.players.push(other);
        expect(availableSkills(obs), JSON.stringify(other)).toContain("revive");
    }
});

test("a dead teammate can be neither revived nor followed", () => {
    const obs = clone(armed);
    obs.teammates[0].dead = true;
    const skills = availableSkills(obs);
    expect(skills).not.toContain("revive");
    expect(skills).not.toContain("follow");
});

test("a downed enemy can be finished but not retreated from", () => {
    const obs = clone(armed);
    obs.players.push(enemy({ dist: 8, downed: true }));
    const skills = availableSkills(obs);
    expect(skills).toContain("engage");
    expect(skills).not.toContain("retreat");
});

test("healing in the open under fire is not offered; behind cover it is", () => {
    const hurt = clone(armed);
    hurt.self.hp = 40;
    hurt.self.inventory.bandage = 2;
    expect(availableSkills(hurt)).toContain("heal");

    // an armed enemy with a clear line: eight seconds standing still is a gift
    hurt.players.push(enemy({ dist: 19, los_blocked: false }));
    expect(availableSkills(hurt)).not.toContain("heal");

    // the same enemy, line broken by a wall: healing is the right call again
    hurt.players[0].los_blocked = true;
    expect(availableSkills(hurt)).toContain("heal");
});

test("an enemy that cannot shoot does not stop a heal", () => {
    for (const other of [enemy({ dist: 8, weapon: "fists" }), enemy({ dist: 8, downed: true })]) {
        const hurt = clone(armed);
        hurt.self.hp = 40;
        hurt.self.inventory.bandage = 2;
        hurt.players.push(other);
        expect(availableSkills(hurt), JSON.stringify(other)).toContain("heal");
    }
});
