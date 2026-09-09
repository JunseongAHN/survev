import { GameConfig } from "../../../shared/gameConfig.ts";
import { Config } from "../config.ts";
import type { Player } from "../game/objects/player.ts";
import { applyCpcAction, type CpcAction } from "./applyCpcAction.ts";
import { createScenarioGame, defaultScenarioMapSize, defaultScenarioSeed } from "./createScenarioGame.ts";
import { attachEventTaps, type CpcEvent, type EventTaps } from "./eventTaps.ts";
import { type AgentObservation, extractAgentObservation, type ObservationIds } from "./observation.ts";
import { buildDuo2v2FieldScenario, type Duo2v2FieldScenario, type FieldLayout } from "./scenarios/duo2v2Field.ts";
import { type ScriptedContext, scriptedAction, type ScriptedPolicyName } from "./scriptedPolicy.ts";

export interface EpisodeOptions {
    scenario?: "duo2v2_field";
    seed?: string | number;
    mapSize?: number;
    /** seconds of game time before the episode ends with reason "time_limit" */
    timeLimit?: number;
    /** agent ids driven through step(); the rest use the scripted policy */
    controlled?: string[];
    scripted?: ScriptedPolicyName;
    /** "armed" starts everyone with a loaded ak47 and reserve ammo (curriculum helper); default "fists" */
    loadout?: "fists" | "armed";
    /** "random" rotates the spawn axis and draws the spawn distance per seed (see `FieldLayout`); default "fixed" */
    layout?: FieldLayout;
}

export interface BridgeEvent {
    type: CpcEvent["type"];
    t: number;
    agent: string;
    source?: string | null;
    weapon?: string | null;
    amount?: number;
    hp_before?: number;
    hp_after?: number;
    downed?: boolean;
    dead?: boolean;
    pos?: { x: number; y: number };
    dir?: { x: number; y: number };
}

export interface AgentMetrics {
    survival_time: number;
    alive_at_end: boolean;
    downed_time: number;
    hp_mean: number;
    hp_end: number;
    damage_dealt: number;
    damage_taken: number;
    kills: number;
    shots: number;
    hits_given: number;
    team_win: boolean;
    partner_survival_time: number;
    partner_hp_end: number;
}

export interface EpisodeInfo {
    alive_teams: number;
    winner_team: string | null;
    reason: "elimination" | "time_limit" | null;
    metrics: Record<string, AgentMetrics> | null;
}

export interface ObsMessage {
    type: "obs";
    env_id?: number;
    t: number;
    tick: number;
    done: boolean;
    agent_ids: string[];
    teams: Record<string, string>;
    obs: Record<string, AgentObservation>;
    events: BridgeEvent[];
    info: EpisodeInfo;
}

const tps = Config.gameTps;
const netSyncEvery = Math.round(Config.gameTps / Config.netSyncTps);
const scriptedDecisionTicks = 10;

interface AgentStats {
    aliveTicks: number;
    downedTicks: number;
    hpSum: number;
    damageDealt: number;
    damageTaken: number;
    kills: number;
    shots: number;
    hitsGiven: number;
}

/**
 * One offline game plus the scenario on top of it, driven step by step. Actions of controlled agents are
 * held between steps (the engine keeps the last InputMsg state, like a held key); scripted agents decide
 * every 0.1 s of game time. Observations are extracted after a netSync so they match the client-visible set.
 */
export class CpcEpisode {
    readonly options: Required<EpisodeOptions>;
    private game!: ReturnType<typeof createScenarioGame>["game"];
    private scenario!: Duo2v2FieldScenario;
    private taps!: EventTaps;
    private players: Player[] = [];
    private agentIdOf = new Map<number, string>();
    private teamOf = new Map<string, string>();
    private stats = new Map<string, AgentStats>();
    private tick = 0;
    private eventCursor = 0;
    private done = false;
    private info: EpisodeInfo = { alive_teams: 2, winner_team: null, reason: null, metrics: null };

    constructor(options: EpisodeOptions = {}) {
        this.options = {
            scenario: options.scenario ?? "duo2v2_field",
            seed: options.seed ?? defaultScenarioSeed,
            mapSize: options.mapSize ?? defaultScenarioMapSize,
            timeLimit: options.timeLimit ?? 60,
            controlled: options.controlled ?? ["team-a-0", "team-a-1"],
            scripted: options.scripted ?? "chaser",
            loadout: options.loadout ?? "fists",
            layout: options.layout ?? "fixed",
        };
    }

    get t(): number {
        return this.tick / tps;
    }

    reset(): ObsMessage {
        this.taps?.detach();
        const { game, seed, mapSize } = createScenarioGame({ seed: this.options.seed, mapSize: this.options.mapSize });
        this.game = game;
        this.scenario = buildDuo2v2FieldScenario(game, { seed, mapSize, layout: this.options.layout });
        this.players = this.scenario.players.map((p) => p.player);
        this.agentIdOf = new Map(this.scenario.players.map((p) => [p.player.__id, p.agentId]));
        this.teamOf = new Map(this.scenario.players.map((p) => [p.agentId, p.teamId]));
        for (const id of this.options.controlled) {
            if (!this.teamOf.has(id)) throw new Error(`unknown controlled agent ${id}`);
        }
        this.stats = new Map(
            this.scenario.players.map((p) => [p.agentId, {
                aliveTicks: 0,
                downedTicks: 0,
                hpSum: 0,
                damageDealt: 0,
                damageTaken: 0,
                kills: 0,
                shots: 0,
                hitsGiven: 0,
            }]),
        );
        this.tick = 0;
        this.eventCursor = 0;
        this.done = false;
        this.info = { alive_teams: this.aliveTeams(), winner_team: null, reason: null, metrics: null };
        if (this.options.loadout === "armed") {
            for (const player of this.players) {
                player.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "ak47", 30);
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
                player.invManager.set("762mm", 90);
            }
        }
        this.taps = attachEventTaps(this.players, () => this.t);
        game.netSync();
        return this.message([]);
    }

    step(actions: Record<string, CpcAction>, ticks: number): ObsMessage {
        if (this.done) throw new Error("episode is done, call reset()");
        if (!Number.isInteger(ticks) || ticks < 1) throw new Error(`ticks must be a positive integer, got ${ticks}`);

        for (const [agentId, action] of Object.entries(actions)) {
            if (!this.options.controlled.includes(agentId)) throw new Error(`${agentId} is not a controlled agent`);
            applyCpcAction(this.playerOf(agentId), action);
        }

        const scripted = this.players.filter((p) => !this.options.controlled.includes(this.agentIdOf.get(p.__id)!));
        for (let i = 0; i < ticks; i++) {
            if (this.tick % scriptedDecisionTicks === 0) {
                const ctx: ScriptedContext = { game: this.game, players: this.players, t: this.t };
                for (const bot of scripted) applyCpcAction(bot, scriptedAction(this.options.scripted, ctx, bot));
            }
            this.game.update(1 / tps);
            this.tick++;
            if (this.tick % netSyncEvery === 0) this.game.netSync();
            this.accumulate();
            if (this.checkDone()) break;
        }
        if (this.tick % netSyncEvery !== 0) this.game.netSync();

        const events = this.drainEvents();
        if (this.done) this.info.metrics = this.metrics();
        return this.message(events);
    }

    close(): void {
        this.taps?.detach();
        this.game?.stop();
    }

    private playerOf(agentId: string): Player {
        const entry = this.scenario.players.find((p) => p.agentId === agentId);
        if (!entry) throw new Error(`unknown agent ${agentId}`);
        return entry.player;
    }

    private aliveTeams(): number {
        return new Set(this.players.filter((p) => !p.dead).map((p) => p.groupId)).size;
    }

    private accumulate(): void {
        for (const player of this.players) {
            if (player.dead) continue;
            const s = this.stats.get(this.agentIdOf.get(player.__id)!)!;
            s.aliveTicks++;
            s.hpSum += player.health;
            if (player.downed) s.downedTicks++;
        }
    }

    private checkDone(): boolean {
        const aliveTeams = this.aliveTeams();
        this.info.alive_teams = aliveTeams;
        if (aliveTeams <= 1) {
            const survivor = this.players.find((p) => !p.dead);
            this.info.winner_team = survivor ? this.teamOf.get(this.agentIdOf.get(survivor.__id)!)! : null;
            this.info.reason = "elimination";
            this.done = true;
        } else if (this.t >= this.options.timeLimit - 1e-9) {
            this.info.winner_team = null;
            this.info.reason = "time_limit";
            this.done = true;
        }
        return this.done;
    }

    private drainEvents(): BridgeEvent[] {
        const fresh = this.taps.events.slice(this.eventCursor);
        this.eventCursor = this.taps.events.length;
        const out: BridgeEvent[] = [];
        for (const e of fresh) {
            const agent = this.agentIdOf.get(e.playerId) ?? String(e.playerId);
            const stats = this.stats.get(agent);
            switch (e.type) {
                case "fire":
                    if (stats) stats.shots++;
                    out.push({ type: "fire", t: e.t, agent, weapon: e.weapon, pos: e.pos, dir: e.dir });
                    break;
                case "damage": {
                    const source = e.sourceId == null ? null : this.agentIdOf.get(e.sourceId) ?? String(e.sourceId);
                    if (stats) stats.damageTaken += e.amount;
                    const sourceStats = source ? this.stats.get(source) : undefined;
                    if (sourceStats && source !== agent) {
                        sourceStats.damageDealt += e.amount;
                        sourceStats.hitsGiven++;
                    }
                    out.push({
                        type: "damage",
                        t: e.t,
                        agent,
                        source,
                        weapon: e.weapon,
                        amount: e.amount,
                        hp_before: e.hpBefore,
                        hp_after: e.hpAfter,
                        downed: e.downed,
                        dead: e.dead,
                        pos: e.pos,
                    });
                    break;
                }
                case "down":
                case "kill": {
                    const source = e.sourceId == null ? null : this.agentIdOf.get(e.sourceId) ?? String(e.sourceId);
                    if (e.type === "kill" && source && source !== agent) {
                        const sourceStats = this.stats.get(source);
                        if (sourceStats) sourceStats.kills++;
                    }
                    out.push({ type: e.type, t: e.t, agent, source });
                    break;
                }
            }
        }
        return out;
    }

    private metrics(): Record<string, AgentMetrics> {
        const result: Record<string, AgentMetrics> = {};
        for (const entry of this.scenario.players) {
            const s = this.stats.get(entry.agentId)!;
            const partner = this.scenario.players.find((p) => p !== entry && p.teamId === entry.teamId);
            const partnerStats = partner ? this.stats.get(partner.agentId)! : undefined;
            result[entry.agentId] = {
                survival_time: s.aliveTicks / tps,
                alive_at_end: !entry.player.dead,
                downed_time: s.downedTicks / tps,
                hp_mean: s.aliveTicks ? s.hpSum / s.aliveTicks : 0,
                hp_end: entry.player.dead ? 0 : entry.player.health,
                damage_dealt: s.damageDealt,
                damage_taken: s.damageTaken,
                kills: s.kills,
                shots: s.shots,
                hits_given: s.hitsGiven,
                team_win: this.info.winner_team === entry.teamId,
                partner_survival_time: partnerStats ? partnerStats.aliveTicks / tps : 0,
                partner_hp_end: partner && !partner.player.dead ? partner.player.health : 0,
            };
        }
        return result;
    }

    private message(events: BridgeEvent[]): ObsMessage {
        const ids: ObservationIds = {
            agentIdOf: (p) => this.agentIdOf.get(p.__id) ?? p.name,
            teamIdOf: (p) => this.teamOf.get(this.agentIdOf.get(p.__id) ?? "") ?? String(p.groupId),
        };
        const obs: Record<string, AgentObservation> = {};
        for (const entry of this.scenario.players) {
            obs[entry.agentId] = extractAgentObservation(this.game, entry.player, ids);
        }
        return {
            type: "obs",
            t: this.t,
            tick: this.tick,
            done: this.done,
            agent_ids: this.scenario.players.map((p) => p.agentId),
            teams: Object.fromEntries(this.teamOf),
            obs,
            events,
            info: { ...this.info },
        };
    }
}
