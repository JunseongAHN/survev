/**
 * M10: one line runs one episode and writes it as JSONL, with no bridge and no Python.
 *
 *   pnpm cpc:episode -- --scenario duo2v2 --policy random --seconds 60 --out .tmp/ep.jsonl
 *
 * Each line is one `ObsMessage` exactly as the bridge would have sent it (observations for every
 * agent, the events of the step, and `info` — with `info.metrics` on the last line), so the file
 * is a faithful log of the episode and a superset of what the harness export needs. The point of
 * the runner is that it depends on nothing but this repo: it is the smallest way to answer "does
 * the scenario still run" and the thing CI can call.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Config } from "../config.ts";
import type { CpcAction } from "./applyCpcAction.ts";
import { defaultScenarioSeed } from "./createScenarioGame.ts";
import { CpcEpisode, type ObsMessage } from "./episode.ts";
import type { ScriptedPolicyName } from "./scriptedPolicy.ts";
import { seededRand } from "./seededRand.ts";

/** Accepts both `--name value` and `--name=value`; the plan's command line uses the first. */
function readOption(name: string): string | undefined {
    const args = process.argv;
    const flag = `--${name}`;
    const prefix = `${flag}=`;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flag) return args[i + 1];
        if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
    }
    return undefined;
}

function readNumber(name: string, fallback: number): number {
    const raw = readOption(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${raw}`);
    return value;
}

/** The 8 keyboard directions the engine quantizes movement to, plus standing still. */
const moveDirs = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
];

/** Seeded random actions for the controlled agents — the floor a real policy is compared against. */
function randomPolicy(rand: () => number): CpcAction {
    const angle = rand() * Math.PI * 2;
    return {
        move: moveDirs[Math.floor(rand() * moveDirs.length)],
        aim: { x: Math.cos(angle), y: Math.sin(angle) },
        fire: { hold: rand() < 0.2 },
        // reach for whatever is underfoot now and then, so a random run still picks things up
        inputs: rand() < 0.1 ? ["Interact"] : [],
    };
}

const policies = ["random", "chaser", "racer", "idle"] as const;
type PolicyName = (typeof policies)[number];

async function main(): Promise<void> {
    Config.logging.logDate = false;
    Config.logging.debugLogs = false;
    Config.logging.infoLogs = false;
    Config.logging.warnLogs = true;
    Config.logging.errorLogs = true;

    const scenario = readOption("scenario") ?? "duo2v2";
    if (scenario !== "duo2v2" && scenario !== "duo2v2_field") {
        throw new Error(`unknown scenario ${scenario} (only duo2v2 / duo2v2_field exist)`);
    }
    const policy = (readOption("policy") ?? "random") as PolicyName;
    if (!policies.includes(policy)) {
        throw new Error(`unknown policy ${policy} (one of ${policies.join(", ")})`);
    }
    const seconds = readNumber("seconds", 60);
    const ticks = readNumber("ticks", 10);
    const seed = readOption("seed") ?? defaultScenarioSeed;
    const scripted = (readOption("scripted") ?? "chaser") as ScriptedPolicyName;
    const out = resolve(readOption("out") ?? ".tmp/cpc_dev/episode.jsonl");

    // `random` drives team-a from here; anything else lets the server script all four
    const controlled = policy === "random" ? ["team-a-0", "team-a-1"] : [];
    const episode = new CpcEpisode({
        seed,
        timeLimit: seconds,
        controlled,
        scripted: policy === "random" ? scripted : (policy as ScriptedPolicyName),
    });

    const rand = seededRand(Date.now() & 0xffff, 31337);
    const lines: string[] = [];
    const record = (msg: ObsMessage) => lines.push(JSON.stringify(msg));

    let msg = episode.reset();
    record(msg);
    const started = Date.now();
    while (!msg.done) {
        const actions: Record<string, CpcAction> = {};
        for (const agentId of controlled) actions[agentId] = randomPolicy(rand);
        msg = episode.step(actions, ticks);
        record(msg);
    }
    const wall = (Date.now() - started) / 1000;
    episode.close();

    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, lines.join("\n") + "\n", "utf8");

    const metrics = msg.info.metrics ?? {};
    console.log(
        `CPC episode: ${scenario} policy=${policy} vs ${scripted} seed=${seed} `
            + `-> ${msg.t.toFixed(1)}s game time in ${wall.toFixed(1)}s wall (${(msg.t / wall).toFixed(0)}x), `
            + `${lines.length} steps, reason=${msg.info.reason}, winner=${msg.info.winner_team ?? "none"}`,
    );
    for (const [agentId, m] of Object.entries(metrics)) {
        console.log(
            `  ${agentId}: survival ${m.survival_time.toFixed(1)}s hp_mean ${m.hp_mean.toFixed(0)} `
                + `dealt ${m.damage_dealt.toFixed(0)} taken ${m.damage_taken.toFixed(0)} kills ${m.kills}`,
        );
    }
    console.log(`wrote ${out}`);
}

await main();
