/**
 * `pnpm cpc:live`: play a duo with the CPC in a real browser.
 *
 * The headless bridge is how Python trains and evaluates; this is the other half — the same skills
 * running in a live game against a real person, which is what the weekly playtest needs. It is off
 * unless `CPC_LIVE=1`, so a normal server is untouched.
 *
 * When the first human joins, the hook turns the match into the `duo2v2_field` scenario around
 * them: a CPC teammate in their group, a scripted duo as the enemy, and the seeded starter kits.
 * From then on it drives the CPC with `runSkill` and the opponents with `scriptedAction` on every
 * tick, exactly as `CpcEpisode` does — the point being that the live and headless paths run the
 * same System 1 code, so what the playtest reveals is a real property of the agent.
 *
 * With `CPC_PLANNER_URL` set, the teammate's brain is the SLM planner under the commit/interrupt
 * loop (`plannerLoop.ts`); the scripted selector only covers the gaps — before the first reply and
 * after an error — so a slow or dead planner never freezes the teammate. Without it, the scripted
 * selector picks, as in week 2.
 *
 * Environment:
 *   CPC_LIVE=1                      enable (required)
 *   CPC_SCRIPTED=chaser|racer|idle  enemy duo behaviour (default chaser)
 *   CPC_SCRIPTED_OPTIONS={json}     enemy strength, e.g. {"aimNoiseDeg":10,"reactionDelay":0.5}
 *   CPC_HUMANIZATION={json}         CPC motor constraints, same three keys plus pathJitterDeg
 *   CPC_OBJECTIVE=race|none         shared capture point (default none)
 *   CPC_COVER=none|sparse|default|dense  bullet-stopping cover between the duos (default none)
 *   CPC_SEED=...                    loot layout / spawn geometry (default the scenario default)
 *   CPC_PLANNER_URL=http://...      System 2 (llama-server); unset = scripted brain
 *   CPC_SAY_LANG=ko|en              language of the planner's chat lines (default ko)
 *   CPC_PLANNER_TIMEOUT_MS=2000     a slower reply counts as an error and the fallback plays on
 *   CPC_LOG=path.jsonl              append one line per second of game time (positions, hp, skill)
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { v2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
import type { Player } from "../game/objects/player.ts";
import { applyCpcAction } from "./applyCpcAction.ts";
import { normalizeSeed } from "./createScenarioGame.ts";
import { buildingTargets, coverTargets } from "./namedTargets.ts";
import { type ObjectiveOptions, RaceObjective } from "./objective.ts";
import { type AgentObservation, extractAgentObservation, type ObservationIds } from "./observation.ts";
import { askPlanner } from "./plannerClient.ts";
import { type PlannerEvent, PlannerLoop } from "./plannerLoop.ts";
import { plannerSystemPrompt, type SayLanguage } from "./plannerPrompt.ts";
import { applyCoverLayout, type CoverDensity, coverDensityFrom, createCoverLayout } from "./scenarios/coverLayout.ts";
import {
    scriptedAction,
    type ScriptedContext,
    type ScriptedOptions,
    type ScriptedPolicyName,
    selectSkill,
    type SkillChoice,
} from "./scriptedPolicy.ts";
import type { SightMemory } from "./botVision.ts";
import { seededRand } from "./seededRand.ts";
import { buildSkillGrammar } from "./skillGrammar.ts";
import { type HeldNoise, runSkill, type SkillOptions, type SkillStatus, weaponInputs } from "./skills.ts";
import { resolveSkillRequest } from "./skillWire.ts";

/** Same streams as `CpcEpisode`, so a seed means the same layout live and headless. */
const lootStream = 0;
const spawnStream = 7919;
const objectiveStream = 104729;
const skillStream = 15485863;

const decisionTicks = 10;

interface LiveConfig {
    enabled: boolean;
    scripted: ScriptedPolicyName;
    scriptedOptions: ScriptedOptions;
    humanization: SkillOptions;
    objective: ObjectiveOptions;
    cover: CoverDensity;
    seed: string;
    log?: string;
    plannerUrl?: string;
    sayLanguage: SayLanguage;
    plannerTimeoutMs: number;
}

function readJson<T>(raw: string | undefined, where: string): T | undefined {
    if (!raw) return undefined;
    try {
        return JSON.parse(raw) as T;
    } catch (err) {
        throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
    }
}

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
    const scripted = (env.CPC_SCRIPTED ?? "chaser") as ScriptedPolicyName;
    if (!["chaser", "racer", "idle"].includes(scripted)) {
        throw new Error(`CPC_SCRIPTED must be chaser | racer | idle, got ${scripted}`);
    }
    const objective = env.CPC_OBJECTIVE === "race"
        ? { mode: "race" as const, radius: 4 }
        : { mode: "none" as const };
    return {
        enabled: env.CPC_LIVE === "1" || env.CPC_LIVE === "true",
        scripted,
        scriptedOptions: readJson<ScriptedOptions>(env.CPC_SCRIPTED_OPTIONS, "CPC_SCRIPTED_OPTIONS") ?? {},
        humanization: readJson<SkillOptions>(env.CPC_HUMANIZATION, "CPC_HUMANIZATION") ?? {},
        objective,
        cover: coverDensityFrom(env.CPC_COVER, "CPC_COVER"),
        seed: env.CPC_SEED ?? "cpc-live-seed-0",
        log: env.CPC_LOG,
        plannerUrl: env.CPC_PLANNER_URL || undefined,
        sayLanguage: env.CPC_SAY_LANG === "en" ? "en" : "ko",
        plannerTimeoutMs: Number(env.CPC_PLANNER_TIMEOUT_MS ?? 2000),
    };
}

/** The 12 starter items each duo gets, mirrored around the region centre (as in `duo2v2Field`). */
const teamKit = [
    { type: "ak47", count: 1 },
    { type: "mp5", count: 1 },
    { type: "bandage", count: 4 },
    { type: "soda", count: 2 },
    { type: "helmet01", count: 1 },
    { type: "chest01", count: 1 },
    { type: "2xscope", count: 1 },
];
const centreKit = [
    { type: "healthkit", count: 1 },
    { type: "painkiller", count: 1 },
    { type: "4xscope", count: 1 },
];

/**
 * Attaches the live CPC to a game. Returns `false` (and touches nothing) unless `CPC_LIVE` is set,
 * so the single call site in `gameProcess.ts` is inert on a normal server.
 */
export function attachCpcLive(game: Game, config: LiveConfig = liveConfigFromEnv()): boolean {
    if (!config.enabled) return false;

    const seed = normalizeSeed(config.seed) ?? 0;
    const rand = seededRand(seed, skillStream);
    const contactSince = new Map<number, number>();
    const sightMemory: SightMemory = new Map();
    // the CPC runs its skill every tick, so its aim/path noise has to be held per decision or
    // the character visibly shakes; the scripted enemies decide every 0.1 s and keep the old path
    const skillNoise = new Map<number, HeldNoise>();

    let cpc: Player | undefined;
    let enemies: Player[] = [];
    /** the skill the CPC is committed to, re-picked at the policy cadence */
    let currentChoice: ReturnType<typeof selectSkill>;
    let cpcSkill: string | null = null;
    let tick = 0;
    /**
     * The AI's clock. Not `game.startedTime`: survev does not start a match until two groups each
     * have someone alive for `minActiveTime`, and until then startedTime sits at 0. Driven by that,
     * every reaction delay stayed unexpired (nobody ever fired) and every planner commit window stayed
     * open — the first ~11 s of a match played as a standoff. This clock runs from the moment the
     * scenario is set up.
     */
    let clockStart: number | undefined;
    const now = () => (clockStart === undefined ? 0 : (performance.now() - clockStart) / 1000);
    /** System 2, when configured; the last skill status feeds its interrupts */
    let planner: PlannerLoop | undefined;
    let lastStatus: SkillStatus | undefined;
    let cpcBrain: "scripted" | "planner" | "fallback" | "down" = "scripted";
    /** stable ids for the planner: the CPC is team-a-0, the human team-a-1, the bots team-b-0/1 */
    const agentIdOf = new Map<Player, string>();
    const ids: ObservationIds = {
        agentIdOf: (p) => agentIdOf.get(p) ?? p.name,
        teamIdOf: (p) => (agentIdOf.get(p) ?? "").startsWith("team-a") ? "team-a" : "team-b",
    };
    const observe = (): AgentObservation =>
        extractAgentObservation(game, cpc!, ids, objective ? objective.observe(cpc!.pos) : null);
    const plannerLog = config.log ? `${config.log.replace(/\.jsonl$/, "")}.planner.jsonl` : undefined;
    function logPlanner(event: PlannerEvent): void {
        if (event.kind === "decided" && event.say) console.log(`[cpc:say] ${event.say}`);
        if (event.kind === "error" || event.kind === "rejected") {
            console.log(`[cpc:planner] ${event.kind}: ${event.error}`);
        }
        if (!plannerLog) return;
        mkdirSync(dirname(plannerLog), { recursive: true });
        appendFileSync(plannerLog, JSON.stringify(event) + "\n", "utf8");
    }
    let objective: RaceObjective | undefined;
    let lastLog = -1;

    const centre = v2.create(game.map.width / 2, game.map.height / 2);
    // cover goes in now, not in setUp: the client receives the map objects when it joins, and it
    // draws from its own stream so a seed's kits and spawns stay exactly where they were
    const coverPieces = createCoverLayout(
        { x: centre.x - 64, y: centre.y - 64, width: 128, height: 128 },
        seed,
        config.cover,
    );
    applyCoverLayout(game, coverPieces);
    if (coverPieces.length) {
        console.log(`[cpc:cover] ${config.cover}: ${coverPieces.length} pieces around ${centre.x},${centre.y}`);
    }
    /** Human and CPC west of centre, the enemy duo east, 32 u out — the fixed field layout. */
    const spawnAt = (side: 1 | -1, index: 0 | 1) =>
        v2.create(centre.x + side * 32, centre.y + (index === 0 ? -6.4 : 6.4));

    function dropKit(items: typeof teamKit, at: { x: number; y: number }, place: () => number) {
        for (const item of items) {
            const jitterX = (place() - 0.5) * 4;
            const jitterY = (place() - 0.5) * 4;
            game.lootBarn.addLoot(item.type, v2.create(at.x + jitterX, at.y + jitterY), 0, item.count, {
                source: "map",
            });
        }
    }

    function setUp(human: Player): void {
        const loot = seededRand(seed, lootStream);
        const spawn = seededRand(seed, spawnStream);
        // the human takes the west slot it is nearest to; the CPC takes the other
        const humanIndex: 0 | 1 = human.pos.y <= centre.y ? 0 : 1;
        const mateIndex: 0 | 1 = humanIndex === 0 ? 1 : 0;
        human.pos = spawnAt(-1, humanIndex);
        human.setDirty();

        cpc = game.playerBarn.addTestPlayer({
            group: human.group,
            team: human.team,
            pos: spawnAt(-1, mateIndex),
            name: "CPC",
        });
        // one group for the pair: without it `addTestPlayer` gives each its own and the "enemy duo"
        // shoots itself
        const enemyGroup = game.playerBarn.addGroup(false);
        enemies = [0, 1].map((i) =>
            game.playerBarn.addTestPlayer({ group: enemyGroup, pos: spawnAt(1, i as 0 | 1), name: `BOT-${i}` })
        );

        agentIdOf.set(cpc, "team-a-0");
        agentIdOf.set(human, "team-a-1");
        enemies.forEach((bot, i) => agentIdOf.set(bot, `team-b-${i}`));
        if (config.plannerUrl) {
            const byId = new Map([...agentIdOf].map(([p, id]) => [id, p] as const));
            const agentIds = [...byId.keys()];
            const systemPrompt = plannerSystemPrompt(config.sayLanguage);
            const url = config.plannerUrl;
            planner = new PlannerLoop({
                agentId: "team-a-0",
                ask: (block, skills, obs) =>
                    askPlanner({
                        url,
                        systemPrompt,
                        block,
                        // only what can run now, and only the places in view: a skill that must not
                        // be chosen and a spot the agent cannot see cannot be generated
                        grammar: buildSkillGrammar({
                            agentIds,
                            skills,
                            covers: coverTargets(obs).map((target) => target.name),
                            buildings: buildingTargets(obs).map((target) => target.name),
                            point: !!obs.objective,
                        }),
                        timeoutMs: config.plannerTimeoutMs,
                    }),
                resolve: (request) =>
                    resolveSkillRequest(request, {
                        playerOf: (id) => {
                            const player = byId.get(id);
                            if (!player) throw new Error(`unknown agent ${id}`);
                            return player;
                        },
                        observation: observe,
                    }),
                onEvent: logPlanner,
            });
        }

        // seeded kits: one per duo 10 u toward the centre, one contested at the centre
        dropKit(teamKit, v2.create(centre.x - 22, centre.y), loot);
        dropKit(teamKit, v2.create(centre.x + 22, centre.y), loot);
        dropKit(centreKit, centre, loot);
        // one draw so the spawn stream is consumed like the headless scenario's
        spawn();

        if (config.objective.mode === "race") {
            const { mode: _mode, ...options } = config.objective;
            objective = new RaceObjective(
                { x: centre.x - 64, y: centre.y - 64, width: 128, height: 128 },
                seed + objectiveStream,
                options,
                0,
            );
        }

        clockStart = performance.now();
        game.preventStart = false;
        console.log(
            `[cpc:live] ${human.name} + CPC vs ${enemies.length} ${config.scripted}`
                + ` | seed ${config.seed} | objective ${config.objective.mode}`
                + ` | enemy ${JSON.stringify(config.scriptedOptions)} | cpc ${JSON.stringify(config.humanization)}`,
        );
    }

    /** The human is whoever has a real socket; test players do not. */
    const humans = () => game.playerBarn.players.filter((p) => !p.disconnected && p !== cpc && !enemies.includes(p));

    function log(t: number): void {
        if (!config.log || !cpc) return;
        const second = Math.floor(t);
        if (second === lastLog) return;
        lastLog = second;
        const line = {
            t: second,
            players: game.playerBarn.players.map((p) => ({
                name: p.name,
                pos: { x: Number(p.pos.x.toFixed(2)), y: Number(p.pos.y.toFixed(2)) },
                hp: Math.round(p.health),
                downed: p.downed,
                dead: p.dead,
                weapon: p.activeWeapon,
                // slots too: an agent can hold a gun it has not equipped, which `activeWeapon` hides
                slots: p.weapons.map((w) => w.type || "-").join("/"),
                // the fire gate, so "why did it not shoot" is answerable from the log: a looted gun
                // arrives with a full clip, so a silent agent is walking, deploying (0.75 s) or
                // waiting out its reaction delay — not reloading
                clip: p.weapons[p.curWeapIdx]?.ammo ?? 0,
                action: p.actionType,
            })),
            cpc_skill: cpcSkill,
            cpc_brain: cpcBrain,
            captures: objective ? objective.current.index : null,
        };
        mkdirSync(dirname(config.log), { recursive: true });
        appendFileSync(config.log, JSON.stringify(line) + "\n", "utf8");
    }

    const update = game.update.bind(game);

    game.update = (dt?: number) => {
        if (!cpc) {
            const [human] = humans();
            if (human && !human.dead) setUp(human);
            update(dt);
            return;
        }

        const players = [cpc, ...humans(), ...enemies].filter((p) => !p.dead);
        const ctx: ScriptedContext = {
            game,
            players: [cpc, ...humans(), ...enemies],
            t: now(),
            rand,
            contactSince,
            sightMemory,
            noise: skillNoise,
            objective: objective ? { pos: objective.current.pos, radius: objective.radius } : undefined,
        };

        // the CPC picks a skill at the policy cadence and executes it every tick. With a planner,
        // System 2 picks under the commit/interrupt loop and the scripted selector only fills the
        // gaps; without one, the selector picks
        const cpcCtx: ScriptedContext = { ...ctx, options: config.humanization };
        // nothing to fight, nothing to fetch: stay with the human. Idling is System 1's call, not a
        // prompt rule — adding it to the prompt made the planner follow while being shot
        const partner = humans().find((p) => !p.dead);
        const scriptedChoice = (): SkillChoice | undefined =>
            selectSkill(cpcCtx, cpc!, Number.POSITIVE_INFINITY)
                ?? (partner ? { skill: "follow", params: { target: partner, distance: 6 } } : undefined);
        if (tick % decisionTicks === 0 && !cpc.dead && !cpc.downed) {
            currentChoice = planner
                ? planner.decide(now(), observe(), lastStatus, scriptedChoice)
                : scriptedChoice();
            cpcSkill = currentChoice?.skill ?? null;
            cpcBrain = planner ? planner.source : "scripted";
            // nothing to do: keep the gun equipped and loaded, as the scripted bots' idle branch
            // does — the first planner session left the CPC standing with an empty clip
            if (!currentChoice) applyCpcAction(cpc, { inputs: weaponInputs(cpc) });
        } else if (tick % decisionTicks === 0) {
            // downed or dead: no skill runs, and the log must not keep showing the last one
            cpcSkill = null;
            cpcBrain = "down";
        }
        if (currentChoice && !cpc.dead && !cpc.downed) {
            const status = runSkill(currentChoice.skill, currentChoice.params as never, cpcCtx, cpc);
            applyCpcAction(cpc, status.action);
            lastStatus = status;
            // the planner loop reads `done` at its next decision; without it the skill is dropped now
            if (status.done && !planner) currentChoice = undefined;
        }

        if (tick % decisionTicks === 0) {
            const enemyCtx: ScriptedContext = { ...ctx, options: config.scriptedOptions };
            for (const bot of enemies) {
                if (!bot.dead) applyCpcAction(bot, scriptedAction(config.scripted, enemyCtx, bot));
            }
        }

        update(dt);
        tick++;
        objective?.tick(players, now());
        log(now());
    };

    return true;
}
