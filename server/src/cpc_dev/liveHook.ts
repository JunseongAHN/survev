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
 * The teammate's brain is deliberately the *scripted selector* for now: week 2 is about whether the
 * skills feel like a person to play with, before an SLM is choosing between them.
 *
 * Environment:
 *   CPC_LIVE=1                      enable (required)
 *   CPC_SCRIPTED=chaser|racer|idle  enemy duo behaviour (default chaser)
 *   CPC_SCRIPTED_OPTIONS={json}     enemy strength, e.g. {"aimNoiseDeg":10,"reactionDelay":0.5}
 *   CPC_HUMANIZATION={json}         CPC motor constraints, same three keys plus pathJitterDeg
 *   CPC_OBJECTIVE=race|none         shared capture point (default none)
 *   CPC_SEED=...                    loot layout / spawn geometry (default the scenario default)
 *   CPC_LOG=path.jsonl              append one line per second of game time (positions, hp, skill)
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { v2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
import type { Player } from "../game/objects/player.ts";
import { applyCpcAction } from "./applyCpcAction.ts";
import { normalizeSeed } from "./createScenarioGame.ts";
import { type ObjectiveOptions, RaceObjective } from "./objective.ts";
import {
    scriptedAction,
    type ScriptedContext,
    type ScriptedOptions,
    type ScriptedPolicyName,
    selectSkill,
} from "./scriptedPolicy.ts";
import { seededRand } from "./seededRand.ts";
import { type HeldNoise, runSkill, type SkillOptions } from "./skills.ts";

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
    seed: string;
    log?: string;
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
        seed: env.CPC_SEED ?? "cpc-live-seed-0",
        log: env.CPC_LOG,
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
    // the CPC runs its skill every tick, so its aim/path noise has to be held per decision or
    // the character visibly shakes; the scripted enemies decide every 0.1 s and keep the old path
    const skillNoise = new Map<number, HeldNoise>();

    let cpc: Player | undefined;
    let enemies: Player[] = [];
    /** the skill the CPC is committed to, re-picked at the policy cadence */
    let currentChoice: ReturnType<typeof selectSkill>;
    let cpcSkill: string | null = null;
    let tick = 0;
    let objective: RaceObjective | undefined;
    let lastLog = -1;

    const centre = v2.create(game.map.width / 2, game.map.height / 2);
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
            t: game.startedTime,
            rand,
            contactSince,
            noise: skillNoise,
            objective: objective ? { pos: objective.current.pos, radius: objective.radius } : undefined,
        };

        // the CPC picks a skill at the policy cadence and executes it every tick, which is the
        // commit/interrupt shape System 2 will drive; for now the scripted selector picks
        if (tick % decisionTicks === 0 && !cpc.dead && !cpc.downed) {
            const choice = selectSkill({ ...ctx, options: config.humanization }, cpc, Number.POSITIVE_INFINITY);
            cpcSkill = choice?.skill ?? null;
            currentChoice = choice;
        }
        if (currentChoice && !cpc.dead && !cpc.downed) {
            const status = runSkill(
                currentChoice.skill,
                currentChoice.params as never,
                { ...ctx, options: config.humanization },
                cpc,
            );
            applyCpcAction(cpc, status.action);
            if (status.done) currentChoice = undefined;
        }

        if (tick % decisionTicks === 0) {
            const enemyCtx: ScriptedContext = { ...ctx, options: config.scriptedOptions };
            for (const bot of enemies) {
                if (!bot.dead) applyCpcAction(bot, scriptedAction(config.scripted, enemyCtx, bot));
            }
        }

        update(dt);
        tick++;
        objective?.tick(players, game.startedTime);
        log(game.startedTime);
    };

    return true;
}
