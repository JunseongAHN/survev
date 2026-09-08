import { expect, test } from "vitest";
import { CpcEpisode, type ObsMessage } from "../../../server/src/cpc_dev/episode.ts";
import { type AgentObservation, observationAllowlist } from "../../../server/src/cpc_dev/observation.ts";
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

function runUntilDone(episode: CpcEpisode, actions: Record<string, object>, maxSeconds: number): ObsMessage {
    let msg = episode.step(actions as never, 10);
    while (!msg.done && msg.t < maxSeconds) msg = episode.step({}, 10);
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
    expect(msg.info).toEqual({ alive_teams: 2, winner_team: null, reason: null, metrics: null });

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

test("the armed loadout starts everyone with a loaded ak47", () => {
    const episode = new CpcEpisode({ seed: "cpc-episode-test", scripted: "idle", controlled: [], loadout: "armed" });
    const msg = episode.reset();
    for (const id of agentIds) {
        expect(msg.obs[id].self.weapon).toBe("ak47");
        expect(msg.obs[id].self.clip).toBe(30);
        expect(msg.obs[id].self.reserve).toBe(90);
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
    expect(metrics["team-b-0"].damage_dealt + metrics["team-b-1"].damage_dealt).toBeCloseTo(
        metrics["team-a-0"].damage_taken + metrics["team-a-1"].damage_taken,
        5,
    );
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
