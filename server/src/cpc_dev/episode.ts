import { DamageType, GameConfig } from "../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import { Config } from "../config.ts";
import type { Player } from "../game/objects/player.ts";
import { applyCpcAction, type CpcAction } from "./applyCpcAction.ts";
import { createScenarioGame, defaultScenarioMapSize, defaultScenarioSeed, normalizeSeed } from "./createScenarioGame.ts";
import { attachEventTaps, type CpcEvent, type EventTaps } from "./eventTaps.ts";
import { type CaptureEvent, type ObjectiveOptions, RaceObjective } from "./objective.ts";
import {
    type AgentObservation,
    extractAgentObservation,
    hearShot,
    type ObservationIds,
    type ShotHeard,
} from "./observation.ts";
import { buildDuo2v2FieldScenario, type Duo2v2FieldScenario, type FieldLayout } from "./scenarios/duo2v2Field.ts";
import {
    type ScriptedContext,
    type ScriptedOptions,
    scriptedAction,
    type ScriptedPolicyName,
    type SkillChoice,
} from "./scriptedPolicy.ts";
import {
    runSkill,
    type SkillContext,
    type SkillName,
    type SkillOptions,
    type SkillStatus,
} from "./skills.ts";
import { seededRand } from "./seededRand.ts";

export interface EpisodeOptions {
    scenario?: "duo2v2_field";
    seed?: string | number;
    mapSize?: number;
    /** seconds of game time before the episode ends with reason "time_limit" */
    timeLimit?: number;
    /** agent ids driven through step(); the rest use the scripted policy */
    controlled?: string[];
    scripted?: ScriptedPolicyName;
    /** strength knobs of the scripted opponents (aim noise, reaction delay, racer engage distance); default exact */
    scriptedOptions?: ScriptedOptions;
    /** motor constraints for the controlled agents' skills (aim noise, reaction delay, path jitter) */
    humanization?: SkillOptions;
    /** "armed" starts everyone with a loaded ak47 and reserve ammo (curriculum helper); default "fists" */
    loadout?: "fists" | "armed";
    /** "random" rotates the spawn axis and draws the spawn distance per seed (see `FieldLayout`); default "fixed" */
    layout?: FieldLayout;
    /** shared objective; `{ mode: "race" }` turns on the moving capture point (see `objective.ts`); default none */
    objective?: ObjectiveOptions;
    /**
     * `true` (default): the episode ends when one team is left. `false`: it runs to the time limit even
     * after a team is wiped (a race keeps paying points to the survivors) and ends early only when every
     * controlled agent is dead.
     */
    endOnElimination?: boolean;
}

/**
 * Wire form of a System 1 skill request. Params name agents by agent id and points by `{x, y}`;
 * `episode` resolves them, because it owns the id map. Held like a primitive action: the skill runs
 * every tick until another action replaces it, which is the commit half of the planner's loop.
 */
export interface SkillRequest {
    skill: SkillName;
    params?: Record<string, unknown>;
}

/** What a controlled agent may be sent: raw inputs, or a skill for System 1 to execute. */
export type ControlledAction = CpcAction | SkillRequest;

export interface BridgeEvent {
    type: CpcEvent["type"] | "capture";
    t: number;
    agent: string;
    /** capture: the capturing agent's team, point index, seconds the point was up */
    team?: string;
    index?: number;
    time_to_capture?: number;
    source?: string | null;
    weapon?: string | null;
    /** damage: what dealt it — "player" | "bleeding" | "gas" | "airdrop" | "airstrike" */
    damage_type?: string;
    amount?: number;
    hp_before?: number;
    hp_after?: number;
    /** loot: the picked-up item and the pile's count. heal: the consumed item */
    item?: string;
    count?: number;
    boost_before?: number;
    boost_after?: number;
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
    /** race objective: points this agent touched first / points its team took */
    captures: number;
    team_captures: number;
}

export interface EpisodeInfo {
    alive_teams: number;
    winner_team: string | null;
    reason: "elimination" | "time_limit" | "controlled_dead" | null;
    metrics: Record<string, AgentMetrics> | null;
    /** race objective: the current point and the captures per team so far */
    objective: { index: number; pos: { x: number; y: number }; radius: number; captures: Record<string, number> } | null;
    /**
     * Per controlled agent running a skill: what it is and whether it finished or could not run.
     * This is the interrupt half of the planner's loop — it is controller state, not world state,
     * which is why it rides in `info` and not in an agent's observation.
     */
    skills: Record<string, { skill: SkillName; done: boolean; failed?: string }> | null;
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

/** A controlled action is a skill request when it names one; otherwise it is raw inputs. */
export function isSkillRequest(action: ControlledAction): action is SkillRequest {
    return typeof (action as SkillRequest).skill === "string";
}

function wireVec(value: unknown, where: string): Vec2 {
    const v = value as { x?: unknown; y?: unknown } | undefined;
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") {
        throw new Error(`${where} must be {x, y}, got ${JSON.stringify(value)}`);
    }
    return v2.create(v.x, v.y);
}

function wireNumber(value: unknown, where: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${where} must be a finite number, got ${JSON.stringify(value)}`);
    }
    return value;
}

function wireString(value: unknown, where: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${where} must be a string, got ${JSON.stringify(value)}`);
    return value;
}


const tps = Config.gameTps;
const netSyncEvery = Math.round(Config.gameTps / Config.netSyncTps);
const scriptedDecisionTicks = 10;
/** seededRand stream for the scripted opponents' aim noise (0 = loot, 7919 = spawns, 104729 = objective) */
const scriptedSeedStream = 15485863;

interface AgentStats {
    aliveTicks: number;
    downedTicks: number;
    hpSum: number;
    damageDealt: number;
    damageTaken: number;
    kills: number;
    shots: number;
    hitsGiven: number;
    captures: number;
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
    private objective?: RaceObjective;
    private pendingCaptures: CaptureEvent[] = [];
    private scriptedRand: () => number = Math.random;
    private contactSince = new Map<number, number>();
    /** the skill each controlled agent is currently committed to, already resolved to players */
    private currentSkill = new Map<string, SkillChoice>();
    private skillStatus = new Map<string, SkillStatus>();
    private info: EpisodeInfo = {
        alive_teams: 2,
        winner_team: null,
        reason: null,
        metrics: null,
        objective: null,
        skills: null,
    };

    constructor(options: EpisodeOptions = {}) {
        this.options = {
            scenario: options.scenario ?? "duo2v2_field",
            seed: options.seed ?? defaultScenarioSeed,
            mapSize: options.mapSize ?? defaultScenarioMapSize,
            timeLimit: options.timeLimit ?? 60,
            controlled: options.controlled ?? ["team-a-0", "team-a-1"],
            scripted: options.scripted ?? "chaser",
            scriptedOptions: options.scriptedOptions ?? {},
            humanization: options.humanization ?? {},
            loadout: options.loadout ?? "fists",
            layout: options.layout ?? "fixed",
            objective: options.objective ?? { mode: "none" },
            endOnElimination: options.endOnElimination ?? true,
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
                captures: 0,
            }]),
        );
        this.tick = 0;
        this.eventCursor = 0;
        this.done = false;
        this.pendingCaptures = [];
        const rand = seededRand(normalizeSeed(seed) ?? 0, scriptedSeedStream);
        this.scriptedRand = () => rand();
        this.contactSince = new Map();
        this.currentSkill = new Map();
        this.skillStatus = new Map();
        const { mode, ...objectiveOptions } = this.options.objective;
        this.objective = mode === "race"
            ? new RaceObjective(this.scenario.scenarioRegion, normalizeSeed(seed) ?? 0, objectiveOptions, 0)
            : undefined;
        this.info = {
            alive_teams: this.aliveTeams(),
            winner_team: null,
            reason: null,
            metrics: null,
            objective: this.objectiveInfo(),
            skills: null,
        };
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

    step(actions: Record<string, ControlledAction>, ticks: number): ObsMessage {
        if (this.done) throw new Error("episode is done, call reset()");
        if (!Number.isInteger(ticks) || ticks < 1) throw new Error(`ticks must be a positive integer, got ${ticks}`);

        for (const [agentId, action] of Object.entries(actions)) {
            if (!this.options.controlled.includes(agentId)) throw new Error(`${agentId} is not a controlled agent`);
            if (isSkillRequest(action)) {
                this.currentSkill.set(agentId, this.resolveSkill(action));
                this.skillStatus.delete(agentId);
            } else {
                // raw inputs replace whatever skill was committed to
                this.currentSkill.delete(agentId);
                this.skillStatus.delete(agentId);
                applyCpcAction(this.playerOf(agentId), action);
            }
        }

        const scripted = this.players.filter((p) => !this.options.controlled.includes(this.agentIdOf.get(p.__id)!));
        for (let i = 0; i < ticks; i++) {
            if (this.tick % scriptedDecisionTicks === 0) {
                const ctx: ScriptedContext = {
                    game: this.game,
                    players: this.players,
                    t: this.t,
                    objective: this.objective ? { pos: this.objective.current.pos, radius: this.objective.radius } : undefined,
                    options: this.options.scriptedOptions,
                    rand: this.scriptedRand,
                    contactSince: this.contactSince,
                };
                for (const bot of scripted) applyCpcAction(bot, scriptedAction(this.options.scripted, ctx, bot));
            }
            // System 1: a committed skill is re-evaluated every tick, not once per policy step, so
            // aim tracks a moving target and completion is noticed the tick it happens
            this.runSkills();
            this.game.update(1 / tps);
            this.tick++;
            if (this.tick % netSyncEvery === 0) this.game.netSync();
            this.accumulate();
            const capture = this.objective?.tick(this.players, this.t);
            if (capture) {
                this.pendingCaptures.push(capture);
                this.stats.get(this.agentIdOf.get(capture.playerId)!)!.captures++;
            }
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

    /** Runs every committed skill for this tick and records its status for `info.skills`. */
    private runSkills(): void {
        if (this.currentSkill.size === 0) return;
        const ctx: SkillContext = {
            game: this.game,
            players: this.players,
            t: this.t,
            options: this.options.humanization,
            rand: this.scriptedRand,
            contactSince: this.contactSince,
        };
        for (const [agentId, choice] of this.currentSkill) {
            const me = this.playerOf(agentId);
            const status = runSkill(choice.skill, choice.params, ctx, me);
            this.skillStatus.set(agentId, status);
            applyCpcAction(me, status.action);
        }
    }

    private skillInfo(): EpisodeInfo["skills"] {
        if (this.currentSkill.size === 0) return null;
        const out: Record<string, { skill: SkillName; done: boolean; failed?: string }> = {};
        for (const [agentId, choice] of this.currentSkill) {
            const status = this.skillStatus.get(agentId);
            out[agentId] = { skill: choice.skill, done: status?.done ?? false };
            if (status?.failed) out[agentId].failed = status.failed;
        }
        return out;
    }

    /** Wire params -> engine params. Agents are named by agent id, points by `{x, y}`. */
    private resolveSkill(request: SkillRequest): SkillChoice {
        const params = request.params ?? {};
        const at = (key: string): Player => {
            const id = wireString(params[key], `${request.skill}.params.${key}`);
            if (!id) throw new Error(`skill ${request.skill} needs params.${key} (an agent id)`);
            return this.playerOf(id);
        };
        const maybeAt = (key: string): Player | undefined =>
            params[key] === undefined || params[key] === null ? undefined : at(key);

        switch (request.skill) {
            case "move_to":
                return {
                    skill: "move_to",
                    params: {
                        pos: wireVec(params.pos, "move_to.params.pos"),
                        arrive: wireNumber(params.arrive, "move_to.params.arrive"),
                        face: params.face === undefined || params.face === null
                            ? undefined
                            : wireVec(params.face, "move_to.params.face"),
                    },
                };
            case "follow":
                return {
                    skill: "follow",
                    params: { target: at("target"), distance: wireNumber(params.distance, "follow.params.distance") },
                };
            case "loot":
                return { skill: "loot", params: { type: wireString(params.type, "loot.params.type") } };
            case "heal":
                return { skill: "heal", params: { item: wireString(params.item, "heal.params.item") } };
            case "engage": {
                const style = wireString(params.style, "engage.params.style");
                if (style !== undefined && style !== "push" && style !== "hold_angle" && style !== "trade") {
                    throw new Error(`engage.params.style must be push | hold_angle | trade, got ${style}`);
                }
                return { skill: "engage", params: { target: at("target"), style } };
            }
            case "retreat":
                return {
                    skill: "retreat",
                    params: {
                        awayFrom: maybeAt("away_from"),
                        distance: wireNumber(params.distance, "retreat.params.distance"),
                    },
                };
            case "revive":
                return { skill: "revive", params: { target: at("target") } };
            default:
                throw new Error(`unknown skill ${JSON.stringify(request.skill)}`);
        }
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

    private teamCaptures(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const team of new Set(this.teamOf.values())) out[team] = 0;
        for (const entry of this.scenario.players) out[entry.teamId] += this.stats.get(entry.agentId)!.captures;
        return out;
    }

    private objectiveInfo(): EpisodeInfo["objective"] {
        if (!this.objective) return null;
        const { index, pos, radius } = this.objective.current;
        return { index, pos: { x: pos.x, y: pos.y }, radius, captures: this.teamCaptures() };
    }

    /** Race: the team with more captures; otherwise the surviving team (null on a tie / both alive). */
    private winner(): string | null {
        if (this.objective) {
            const captures = Object.entries(this.teamCaptures()).sort((a, b) => b[1] - a[1]);
            return captures.length > 1 && captures[0][1] === captures[1][1] ? null : captures[0][0];
        }
        const alive = new Set(this.players.filter((p) => !p.dead).map((p) => this.teamOf.get(this.agentIdOf.get(p.__id)!)!));
        return alive.size === 1 ? [...alive][0] : null;
    }

    private checkDone(): boolean {
        const aliveTeams = this.aliveTeams();
        this.info.alive_teams = aliveTeams;
        const controlledDead = this.options.controlled.length > 0
            && this.options.controlled.every((id) => this.playerOf(id).dead);
        if (this.options.endOnElimination && aliveTeams <= 1) {
            this.info.reason = "elimination";
        } else if (!this.options.endOnElimination && (controlledDead || aliveTeams === 0)) {
            this.info.reason = "controlled_dead";
        } else if (this.t >= this.options.timeLimit - 1e-9) {
            this.info.reason = "time_limit";
        } else {
            return false;
        }
        this.info.winner_team = this.winner();
        this.done = true;
        return true;
    }

    private drainEvents(): BridgeEvent[] {
        const fresh = this.taps.events.slice(this.eventCursor);
        this.eventCursor = this.taps.events.length;
        const out: BridgeEvent[] = [];
        for (const c of this.pendingCaptures) {
            const agent = this.agentIdOf.get(c.playerId) ?? String(c.playerId);
            out.push({
                type: "capture",
                t: c.t,
                agent,
                team: this.teamOf.get(agent),
                index: c.index,
                pos: { x: c.pos.x, y: c.pos.y },
                time_to_capture: c.timeToCapture,
            });
        }
        this.pendingCaptures = [];
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
                        damage_type: DamageType[e.damageType].toLowerCase(),
                        amount: e.amount,
                        hp_before: e.hpBefore,
                        hp_after: e.hpAfter,
                        downed: e.downed,
                        dead: e.dead,
                        pos: e.pos,
                    });
                    break;
                }
                case "loot":
                    out.push({ type: "loot", t: e.t, agent, item: e.item, count: e.count, pos: e.pos });
                    break;
                case "heal":
                    out.push({
                        type: "heal",
                        t: e.t,
                        agent,
                        item: e.item,
                        hp_before: e.hpBefore,
                        hp_after: e.hpAfter,
                        boost_before: e.boostBefore,
                        boost_after: e.boostAfter,
                    });
                    break;
                case "revive":
                    out.push({
                        type: "revive",
                        t: e.t,
                        agent,
                        source: this.agentIdOf.get(e.sourceId) ?? String(e.sourceId),
                    });
                    break;
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
        out.sort((a, b) => a.t - b.t);
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
                captures: s.captures,
                team_captures: s.captures + (partnerStats?.captures ?? 0),
            };
        }
        return result;
    }

    private message(events: BridgeEvent[]): ObsMessage {
        const ids: ObservationIds = {
            agentIdOf: (p) => this.agentIdOf.get(p.__id) ?? p.name,
            teamIdOf: (p) => this.teamOf.get(this.agentIdOf.get(p.__id) ?? "") ?? String(p.groupId),
        };
        // shots of this step, bucketed per listener from where each agent stands now
        const fires = events.filter((e) => e.type === "fire" && e.pos);
        const obs: Record<string, AgentObservation> = {};
        for (const entry of this.scenario.players) {
            const heard: ShotHeard[] = [];
            for (const fire of fires) {
                // your own shots are not "heard": you know you pulled the trigger
                if (fire.agent === entry.agentId) continue;
                const shot = hearShot(entry.player.pos, fire.pos!);
                if (shot) heard.push(shot);
            }
            obs[entry.agentId] = extractAgentObservation(
                this.game,
                entry.player,
                ids,
                this.objective ? this.objective.observe(entry.player.pos) : null,
                heard,
            );
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
            info: { ...this.info, objective: this.objectiveInfo(), skills: this.skillInfo() },
        };
    }
}
