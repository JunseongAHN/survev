import { expect, test } from "vitest";
import { CpcEpisode, type ObsMessage } from "../../../server/src/cpc_dev/episode.ts";
import {
    type AgentObservation,
    observationAllowlist,
    shotsHeardRadius,
} from "../../../server/src/cpc_dev/observation.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { v2 } from "../../../shared/utils/v2.ts";

const agentIds = ["team-a-0", "team-a-1", "team-b-0", "team-b-1"];

function expectAllowlisted(value: unknown, path: string) {
    if (Array.isArray(value)) {
        for (const item of value) expectAllowlisted(item, path);
        return;
    }
    if (value === null || typeof value !== "object") return;
    const keys = Object.keys(value as object);
    const isVec = keys.length === 2 && keys.includes("x") && keys.includes("y");
    const allowed = isVec ? observationAllowlist.vec2 : observationAllowlist[path as keyof typeof observationAllowlist];
    expect(allowed, `no allowlist entry for "${path}"`).toBeDefined();
    for (const key of keys) {
        expect(allowed, `key "${key}" at "${path}" is not allowlisted`).toContain(key);
        if (!isVec) expectAllowlisted((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    }
}

const collectedEvents: ObsMessage["events"] = [];

function runUntilDone(episode: CpcEpisode, actions: Record<string, object>, maxSeconds: number): ObsMessage {
    collectedEvents.length = 0;
    let msg = episode.step(actions as never, 10);
    collectedEvents.push(...msg.events);
    while (!msg.done && msg.t < maxSeconds) {
        msg = episode.step({}, 10);
        collectedEvents.push(...msg.events);
    }
    return msg;
}

test("reset returns a full, allowlisted observation for every agent", () => {
    const episode = new CpcEpisode({ seed: "cpc-episode-test" });
    const msg = episode.reset();

    expect(msg.type).toBe("obs");
    expect(msg.t).toBe(0);
    expect(msg.done).toBe(false);
    expect(msg.agent_ids).toEqual(agentIds);
    expect(msg.teams).toEqual({
        "team-a-0": "team-a",
        "team-a-1": "team-a",
        "team-b-0": "team-b",
        "team-b-1": "team-b",
    });
    // `skills` is null until a controlled agent is given one (System 1's interrupt channel)
    expect(msg.info).toEqual({
        alive_teams: 2,
        winner_team: null,
        reason: null,
        metrics: null,
        objective: null,
        skills: null,
    });
    expect(msg.obs["team-a-0"].objective).toBeNull();

    for (const id of agentIds) {
        const obs: AgentObservation = msg.obs[id];
        expectAllowlisted(obs, "");
        expect(obs.self.id).toBe(id);
        expect(obs.self.hp).toBe(100);
        expect(obs.self.weapon).toBe("fists");
        expect(obs.teammates).toHaveLength(1);
        // the other duo spawns 64 u away: outside the 1x view rectangle, so no enemy is visible yet (M6)
        expect(obs.players).toEqual([]);
        // the team kit is 10 u away and visible
        expect(obs.loot.some((l) => l.type === "ak47")).toBe(true);
        expect(obs.alive_count).toBe(4);
        expect(obs.alive_teams).toBe(2);
    }
    episode.close();
});

test("observations equal the client-visible object set after every step (M5)", () => {
    const episode = new CpcEpisode({ seed: "cpc-episode-test", scripted: "chaser", controlled: [] });
    episode.reset();
    for (let i = 0; i < 20; i++) {
        const msg = episode.step({}, 10);
        // reach into the engine through the scenario players to compare against player.visibleObjects
        const scenario = (episode as unknown as { scenario: { players: Array<{ agentId: string; player: any }> } })
            .scenario;
        for (const { agentId, player } of scenario.players) {
            const obs = msg.obs[agentId];
            // the server streams whole grid cells; the observation must be the streamed set cut to the view rectangle
            const halfWidth = obs.self.zoom + 4;
            const halfHeight = halfWidth / (16 / 9);
            const inView = (pos: { x: number; y: number }) =>
                Math.abs(pos.x - player.pos.x) <= halfWidth && Math.abs(pos.y - player.pos.y) <= halfHeight;
            const visible = new Set<number>();
            const visibleEnemies = new Set<string>();
            for (const obj of player.visibleObjects) {
                if (!inView(obj.pos)) continue;
                const isProp = obj.__type === ObjectType.Loot || obj.__type === ObjectType.Obstacle
                    || obj.__type === ObjectType.DeadBody;
                if (isProp) visible.add(obj.__id);
                if (obj.__type === ObjectType.Player && obj !== player && obj.groupId !== player.groupId) {
                    visibleEnemies.add(obj.name);
                }
            }
            const listed = new Set<number>([...obs.loot.map((l) => l.id), ...obs.obstacles.map((o) => o.id)]);
            expect(listed.size + obs.dead_bodies.length).toBe(visible.size);
            for (const id of listed) expect(visible.has(id)).toBe(true);
            expect(new Set(obs.players.map((p) => p.id))).toEqual(visibleEnemies);
            for (const enemy of obs.players) expect(inView(enemy.pos)).toBe(true);
            // nothing the client would not draw leaks in, and enemies never carry HP
            for (const enemy of obs.players) expect("hp" in enemy).toBe(false);
        }
        if (msg.done) break;
    }
    episode.close();
});

test("controlled actions are held between steps and released by {}", () => {
    const episode = new CpcEpisode({ seed: "cpc-episode-test", scripted: "idle", controlled: ["team-a-0"] });
    const start = episode.reset().obs["team-a-0"].self.pos;

    const moved = episode.step({ "team-a-0": { move: v2.create(1, 0) } }, 10).obs["team-a-0"].self.pos;
    expect(moved.x - start.x).toBeCloseTo(1.3, 1); // 13 u/s * 0.1 s

    const held = episode.step({}, 10).obs["team-a-0"].self.pos;
    expect(held.x - moved.x).toBeCloseTo(1.3, 1);

    const released = episode.step({ "team-a-0": {} }, 10).obs["team-a-0"].self.pos;
    expect(released.x - held.x).toBe(0);
    episode.close();
});

test("scripted chasers eliminate idle controlled agents and the episode reports metrics", () => {
    const episode = new CpcEpisode({
        seed: "cpc-episode-test",
        scripted: "chaser",
        controlled: ["team-a-0", "team-a-1"],
        timeLimit: 60,
    });
    episode.reset();
    const last = runUntilDone(episode, {}, 60);

    expect(last.done).toBe(true);
    expect(last.info.reason).toBe("elimination");
    expect(last.info.winner_team).toBe("team-b");
    expect(last.info.alive_teams).toBe(1);

    const metrics = last.info.metrics!;
    expect(Object.keys(metrics).sort()).toEqual([...agentIds].sort());
    for (const id of agentIds) {
        const m = metrics[id];
        expect(m.survival_time).toBeGreaterThan(0);
        expect(m.survival_time).toBeLessThanOrEqual(last.t + 1e-9);
        expect(m.hp_mean).toBeGreaterThan(0);
        expect(m.hp_mean).toBeLessThanOrEqual(100);
        expect(m.team_win).toBe(id.startsWith("team-b"));
    }
    expect(metrics["team-a-0"].alive_at_end).toBe(false);
    expect(metrics["team-a-0"].hp_end).toBe(0);
    expect(metrics["team-a-0"].damage_taken).toBeGreaterThan(0);
    expect(metrics["team-b-0"].shots + metrics["team-b-1"].shots).toBeGreaterThan(0);
    // dealt counts hits by team-b on team-a; taken also includes bleed while downed (source null)
    const damage = collectedEvents.filter((e) => e.type === "damage" && e.agent.startsWith("team-a"));
    const byTeamB = damage.filter((e) => e.source?.startsWith("team-b")).reduce((sum, e) => sum + e.amount!, 0);
    const allTaken = damage.reduce((sum, e) => sum + e.amount!, 0);
    expect(metrics["team-b-0"].damage_dealt + metrics["team-b-1"].damage_dealt).toBeCloseTo(byTeamB, 5);
    expect(metrics["team-a-0"].damage_taken + metrics["team-a-1"].damage_taken).toBeCloseTo(allTaken, 5);
    expect(allTaken).toBeGreaterThanOrEqual(byTeamB);
    expect(metrics["team-b-0"].partner_survival_time).toBe(metrics["team-b-1"].survival_time);

    expect(() => episode.step({}, 10)).toThrow(/done/);
    episode.close();
});

test("events carry agent ids and the time limit ends a quiet episode", () => {
    const episode = new CpcEpisode({
        seed: "cpc-episode-test",
        scripted: "idle",
        controlled: ["team-a-0"],
        timeLimit: 1,
    });
    episode.reset();
    const msg = runUntilDone(episode, {}, 5);
    expect(msg.done).toBe(true);
    expect(msg.t).toBeCloseTo(1, 6);
    expect(msg.info.reason).toBe("time_limit");
    expect(msg.info.winner_team).toBeNull();
    expect(msg.info.metrics!["team-a-0"].survival_time).toBeCloseTo(1, 6);
    expect(msg.info.metrics!["team-a-0"].hp_mean).toBe(100);
    episode.close();

    const fight = new CpcEpisode({ seed: "cpc-episode-test", scripted: "chaser", controlled: [] });
    fight.reset();
    const events: ObsMessage["events"] = [];
    let step = fight.step({}, 10);
    while (!step.done && step.t < 60) {
        events.push(...step.events);
        step = fight.step({}, 10);
    }
    events.push(...step.events);
    const fires = events.filter((e) => e.type === "fire");
    const hits = events.filter((e) => e.type === "damage");
    expect(fires.length).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    expect(fires.every((e) => agentIds.includes(e.agent) && typeof e.weapon === "string")).toBe(true);
    expect(hits.every((e) => agentIds.includes(e.agent) && (e.source === null || agentIds.includes(e.source!))))
        .toBe(true);
    expect(events.filter((e) => e.type === "kill").length).toBeGreaterThan(0);
    fight.close();
});

test("race objective: seeded points, team-credited captures that move the point, and no end on elimination", () => {
    const make = () => new CpcEpisode({
        seed: "cpc-race-test",
        scripted: "idle",
        controlled: ["team-a-0", "team-a-1"],
        objective: { mode: "race", radius: 4, minDist: 30, maxDist: 70 },
        endOnElimination: false,
        timeLimit: 20,
    });
    const episode = make();
    const first = episode.reset();
    const other = make().reset();
    expect(first.info.objective).toEqual(other.info.objective); // seeded
    const point = first.obs["team-a-0"].objective!;
    expect(point.index).toBe(0);
    expect(point.radius).toBe(4);
    expect(point.dist).toBeCloseTo(v2.distance(first.obs["team-a-0"].self.pos, point.pos), 6);
    // everyone sees the same point (it is a shared HUD marker, not a per-agent secret)
    for (const id of agentIds) expect(first.obs[id].objective!.pos).toEqual(point.pos);
    const region = { x: 68, y: 68, width: 128, height: 128 };
    expect(point.pos.x).toBeGreaterThanOrEqual(region.x + 12);
    expect(point.pos.x).toBeLessThanOrEqual(region.x + region.width - 12);

    // walk team-a-0 onto the point: a capture event fires once, the point moves 30..70 u away, index increments
    let msg = first;
    let captured = false;
    for (let i = 0; i < 120 && !captured; i++) {
        const me = msg.obs["team-a-0"].self.pos;
        const to = v2.sub(msg.obs["team-a-0"].objective!.pos, me);
        msg = episode.step({ "team-a-0": { move: to, aim: to } }, 10);
        const capture = msg.events.find((e) => e.type === "capture");
        if (capture) {
            captured = true;
            expect(capture.agent).toBe("team-a-0");
            expect(capture.team).toBe("team-a");
            expect(capture.index).toBe(0);
            expect(capture.time_to_capture).toBeCloseTo(capture.t, 6);
            expect(v2.distance(capture.pos!, point.pos)).toBeLessThan(1e-6);
            const next = msg.obs["team-a-0"].objective!;
            expect(next.index).toBe(1);
            const moved = v2.distance(next.pos, point.pos);
            expect(moved).toBeGreaterThanOrEqual(30 - 1e-6);
            expect(moved).toBeLessThanOrEqual(70 + 1e-6);
            expect(msg.info.objective!.captures).toEqual({ "team-a": 1, "team-b": 0 });
        }
    }
    expect(captured).toBe(true);

    // no end on elimination: kill team-b outright, the episode keeps running to the time limit
    const all = (episode as unknown as { players: Array<{ name: string; kill: (p: object) => void; dead: boolean }> }).players;
    for (const p of all) {
        if (p.name.startsWith("team-b")) p.kill({ damageType: 0, dir: v2.create(1, 0), source: undefined });
    }
    msg = episode.step({}, 10);
    expect(msg.info.alive_teams).toBe(1);
    expect(msg.done).toBe(false);
    // the world keeps simulating after the wipe: the survivor can still move and take the next point
    const capturesBefore = msg.info.objective!.captures["team-a"];
    for (let i = 0; i < 100 && msg.info.objective!.captures["team-a"] === capturesBefore && !msg.done; i++) {
        const me = msg.obs["team-a-0"].self.pos;
        const to = v2.sub(msg.obs["team-a-0"].objective!.pos, me);
        msg = episode.step({ "team-a-0": { move: to, aim: to } }, 10);
    }
    expect(msg.info.objective!.captures["team-a"]).toBe(capturesBefore + 1);
    const last = runUntilDone(episode, {}, 20);
    expect(last.done).toBe(true);
    expect(last.info.reason).toBe("time_limit");
    expect(last.info.winner_team).toBe("team-a"); // more captures
    const m = last.info.metrics!;
    expect(m["team-a-0"].captures).toBeGreaterThanOrEqual(1);
    expect(m["team-a-0"].team_captures).toBe(m["team-a-0"].captures + m["team-a-1"].captures);
    expect(m["team-a-0"].team_win).toBe(true);
    expect(m["team-b-0"].team_win).toBe(false);
    expect(m["team-b-0"].captures).toBe(0);
});

test("without endOnElimination the episode ends early only when every controlled agent is dead", () => {
    const episode = new CpcEpisode({
        seed: "cpc-race-test-2",
        scripted: "idle",
        controlled: ["team-a-0", "team-a-1"],
        objective: { mode: "race" },
        endOnElimination: false,
        timeLimit: 30,
    });
    episode.reset();
    const all = (episode as unknown as { players: Array<{ name: string; kill: (p: object) => void }> }).players;
    for (const p of all) {
        if (p.name.startsWith("team-a")) p.kill({ damageType: 0, dir: v2.create(1, 0), source: undefined });
    }
    const msg = episode.step({}, 10);
    expect(msg.done).toBe(true);
    expect(msg.info.reason).toBe("controlled_dead");
    expect(msg.info.winner_team).toBeNull(); // 0 : 0 captures is a tie
});

test("racer opponents loot, run the race and engage only inside racerEngageDist", () => {
    // team-b = racers, team-a idle (controlled but never given actions): racers should take points
    const episode = new CpcEpisode({
        seed: "cpc-racer-test",
        scripted: "racer",
        controlled: ["team-a-0", "team-a-1"],
        objective: { mode: "race", radius: 4, minDist: 30, maxDist: 70 },
        endOnElimination: false,
        layout: "random",
        timeLimit: 30,
    });
    episode.reset();
    let msg = episode.step({}, 10);
    let firstCapture: number | undefined;
    let armedBeforeFirstCapture = false;
    while (!msg.done) {
        const b0 = msg.obs["team-b-0"].self;
        if (firstCapture === undefined && msg.events.some((e) => e.type === "capture")) {
            firstCapture = msg.t;
            armedBeforeFirstCapture = b0.weapons.some((w) => w.type === "ak47" || w.type === "mp5");
        }
        if (msg.t > 29) break;
        msg = episode.step({}, 10);
    }
    const captures = msg.info.objective!.captures;
    expect(captures["team-b"]).toBeGreaterThanOrEqual(3); // the racer keeps taking points
    expect(captures["team-a"]).toBe(0);
    expect(firstCapture).toBeDefined();
    expect(armedBeforeFirstCapture).toBe(true); // it picked up its kit gun before racing

    // a racer close to an enemy fights like the chaser: the idle team-a takes damage from team-b fire
    const dmg = msg.info.metrics ?? null;
    if (dmg) expect(dmg["team-b-0"].shots + dmg["team-b-1"].shots).toBeGreaterThan(0);
});

test("chaser behaviour is unchanged by the objective: it closes on enemies instead of racing", () => {
    const episode = new CpcEpisode({
        seed: "cpc-racer-test",
        scripted: "chaser",
        controlled: ["team-a-0", "team-a-1"],
        objective: { mode: "race", radius: 4 },
        endOnElimination: false,
        timeLimit: 20,
    });
    episode.reset();
    const last = runUntilDone(episode, {}, 20);
    expect(last.info.objective!.captures["team-b"]).toBe(0);
    expect(last.info.reason).toBe("controlled_dead"); // idle team-a gets eliminated
});

test("scriptedOptions.reactionDelay: chasers hold fire until an enemy has been in fire range that long", () => {
    const delay = 2;
    const episode = new CpcEpisode({
        seed: "cpc-episode-test",
        scripted: "chaser",
        scriptedOptions: { reactionDelay: delay },
        controlled: ["team-a-0", "team-a-1"],
        timeLimit: 30,
    });
    episode.reset();
    let msg = episode.step({}, 10);
    let firstContact: number | undefined;
    let firstFire: number | undefined;
    while (!msg.done && msg.t < 30) {
        const a = ["team-a-0", "team-a-1"].map((id) => msg.obs[id].self);
        const b = ["team-b-0", "team-b-1"].map((id) => msg.obs[id].self);
        const inRange = b.some((bot) => a.some((tgt) => !tgt.dead && v2.distance(bot.pos, tgt.pos) < 30));
        if (firstContact === undefined && inRange) firstContact = msg.t;
        const fire = msg.events.find((e) => e.type === "fire" && e.agent.startsWith("team-b"));
        if (firstFire === undefined && fire) firstFire = fire.t;
        if (firstFire !== undefined) break;
        msg = episode.step({}, 10);
    }
    expect(firstContact).toBeDefined();
    expect(firstFire).toBeDefined();
    // contact is sampled every 0.1 s step, so allow one decision interval of slack
    expect(firstFire! - firstContact!).toBeGreaterThanOrEqual(delay - 0.15);
});

test("scriptedOptions.aimNoiseDeg: noisy chasers hit far less often than exact ones on the same seed", () => {
    const hitRatio = (options: { aimNoiseDeg?: number }) => {
        const episode = new CpcEpisode({
            seed: "cpc-episode-test",
            scripted: "chaser",
            scriptedOptions: options,
            controlled: ["team-a-0", "team-a-1"],
            timeLimit: 30,
        });
        episode.reset();
        const last = runUntilDone(episode, {}, 30);
        const m = last.info.metrics ?? null;
        const shots = collectedEvents.filter((e) => e.type === "fire" && e.agent.startsWith("team-b")).length;
        const hits = collectedEvents.filter((e) => e.type === "damage" && e.source?.startsWith("team-b")).length;
        episode.close();
        return { shots, hits, ratio: hits / Math.max(1, shots), reason: last.info.reason, metrics: m };
    };
    const exact = hitRatio({});
    const noisy = hitRatio({ aimNoiseDeg: 60 });
    expect(exact.shots).toBeGreaterThan(0);
    expect(noisy.shots).toBeGreaterThan(0);
    expect(exact.ratio).toBeGreaterThan(0.3);
    expect(noisy.ratio).toBeLessThan(exact.ratio * 0.6);
});

test("scriptedOptions.engageDist: a racer with engageDist 0 races past the idlers without ever fighting", () => {
    const episode = new CpcEpisode({
        seed: "cpc-racer-test",
        scripted: "racer",
        scriptedOptions: { engageDist: 0 },
        controlled: ["team-a-0", "team-a-1"],
        objective: { mode: "race", radius: 4, minDist: 30, maxDist: 70 },
        endOnElimination: false,
        layout: "random",
        timeLimit: 30,
    });
    episode.reset();
    const last = runUntilDone(episode, {}, 30);
    expect(last.info.objective!.captures["team-b"]).toBeGreaterThanOrEqual(3);
    expect(collectedEvents.filter((e) => e.type === "fire" && e.agent.startsWith("team-b"))).toHaveLength(0);
    expect(last.info.reason).toBe("time_limit");
});

// S4: heard shots go to the agents in earshot and to nobody else. The fixed layout puts the two
// duos 64 u apart (out of earshot) and the partners 12.8 u apart (in earshot), so one team firing
// separates the two branches deterministically.
test("shots_heard reaches only agents within the audible radius, never the shooter", () => {
    const episode = new CpcEpisode({
        seed: "cpc-episode-test",
        scripted: "idle",
        controlled: agentIds,
        loadout: "armed",
    });
    const first = episode.reset();
    const posOf = (msg: ObsMessage, id: string) => msg.obs[id].self.pos;
    expect(v2.distance(posOf(first, "team-a-0"), posOf(first, "team-a-1"))).toBeLessThan(shotsHeardRadius);
    expect(v2.distance(posOf(first, "team-a-0"), posOf(first, "team-b-0"))).toBeGreaterThan(shotsHeardRadius);

    episode.step({}, 100); // let the spawned weapon deploy before pulling the trigger

    // only team-a-0 shoots; everyone else stands still
    const msg = episode.step({ "team-a-0": { aim: { x: 0, y: 1 }, fire: { hold: true } } }, 50);
    const fires = msg.events.filter((e) => e.type === "fire");
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((e) => e.agent === "team-a-0")).toBe(true);

    // the partner hears every shot, bucketed; the shooter and the far team hear nothing
    expect(msg.obs["team-a-1"].shots_heard).toHaveLength(fires.length);
    expect(msg.obs["team-a-1"].shots_heard.every((s) => s.range === "near")).toBe(true);
    expect(msg.obs["team-a-0"].shots_heard).toHaveLength(0);
    expect(msg.obs["team-b-0"].shots_heard).toHaveLength(0);
    expect(msg.obs["team-b-1"].shots_heard).toHaveLength(0);

    // and it is a snapshot of the step, not a running log: releasing the trigger clears it
    const quiet = episode.step({ "team-a-0": {} }, 50);
    expect(quiet.events.filter((e) => e.type === "fire")).toHaveLength(0);
    expect(quiet.obs["team-a-1"].shots_heard).toHaveLength(0);
    episode.close();
});

// System 1 over the wire: the planner sends `{skill, params}` and the episode executes it every tick
test("controlled agents can be driven by skills, held across steps, with status reported back", () => {
    const episode = new CpcEpisode({
        seed: "cpc-skill-test",
        scripted: "idle",
        controlled: ["team-a-0", "team-a-1"],
        timeLimit: 30,
    });
    const first = episode.reset();
    expect(first.info.skills).toBeNull();

    // team-a-0 walks to a point 12 u north of where it stands; team-a-1 follows it
    const start = first.obs["team-a-0"].self.pos;
    const goal = { x: start.x, y: start.y + 12 };
    let msg = episode.step({
        "team-a-0": { skill: "move_to", params: { pos: goal } },
        "team-a-1": { skill: "follow", params: { target: "team-a-0", distance: 4 } },
    }, 10);

    expect(msg.info.skills).toEqual({
        "team-a-0": { skill: "move_to", done: false },
        "team-a-1": { skill: "follow", done: false },
    });
    expect(v2.distance(msg.obs["team-a-0"].self.pos, goal)).toBeLessThan(v2.distance(start, goal));

    // the commit holds: further steps need no actions at all and the skills keep running
    while (!msg.done && !msg.info.skills!["team-a-0"].done && msg.t < 5) {
        msg = episode.step({}, 10);
    }
    expect(msg.info.skills!["team-a-0"].done).toBe(true);
    expect(v2.distance(msg.obs["team-a-0"].self.pos, goal)).toBeLessThanOrEqual(2);
    // and the follower closed on its partner while that happened
    expect(msg.obs["team-a-1"].teammates[0].dist).toBeLessThan(v2.distance(start, goal));

    // a failing skill says so instead of throwing
    const failing = episode.step({ "team-a-0": { skill: "heal", params: {} } }, 10);
    expect(failing.info.skills!["team-a-0"]).toEqual({
        skill: "heal",
        done: true,
        failed: "no healing item",
    });

    // raw inputs replace the commitment
    const raw = episode.step({ "team-a-0": { move: { x: 1, y: 0 } } }, 10);
    expect(raw.info.skills).toEqual({ "team-a-1": { skill: "follow", done: false } });
    episode.close();
});

test("bad skill requests are rejected with the field that was wrong", () => {
    const episode = new CpcEpisode({ seed: "cpc-skill-test", scripted: "idle", controlled: ["team-a-0"] });
    episode.reset();
    const send = (action: object) => () => episode.step({ "team-a-0": action as never }, 1);

    expect(send({ skill: "nope" })).toThrow(/unknown skill/);
    expect(send({ skill: "move_to", params: {} })).toThrow(/move_to.params.pos must be \{x, y\}/);
    expect(send({ skill: "follow", params: {} })).toThrow(/needs params.target/);
    expect(send({ skill: "follow", params: { target: "team-z-9" } })).toThrow(/unknown agent/);
    expect(send({ skill: "engage", params: { target: "team-b-0", style: "sprint" } }))
        .toThrow(/style must be push \| hold_angle \| trade/);
    expect(send({ skill: "move_to", params: { pos: { x: 1, y: 2 }, arrive: "soon" } }))
        .toThrow(/arrive must be a finite number/);
    episode.close();
});
