/**
 * The compact state block System 2 reads (week 3).
 *
 * The planner gets plain text, not JSON, and it gets it from exactly one place: the agent's own
 * `AgentObservation`. That is the point — the observation is already the allowlisted information
 * set a human client would receive, so building the prompt from it and nothing else makes
 * information-set parity a property of the code path rather than a promise. Nothing here reads
 * `game` state.
 *
 * The budget is ~400 tokens, which is why this is terse, ASCII, one bracketed line per topic. The
 * persona, the rules and the skill list are a fixed prefix on the serving side so the KV cache is
 * reused across calls; only this block changes, and it is the *last* thing in the prompt.
 *
 * Directions are the 8 compass points in **world** space (y grows upward, `"N"` = +y), the same
 * convention `shots_heard` uses — not the harness's screen-space `MOVE_LABELS`.
 */

import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import { buildingTargets, coverTargets } from "./namedTargets.ts";
import type { AgentObservation } from "./observation.ts";

const compass = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"] as const;

/** 8-point compass bearing from `from` to `to`, world space. */
export function bearing(from: Vec2, to: Vec2): string {
    const offset = v2.sub(to, from);
    if (v2.length(offset) < 1e-6) return "here";
    return compass[(Math.round(Math.atan2(offset.y, offset.x) / (Math.PI / 4)) + 8) % 8];
}

const round = (n: number) => Math.round(n);

/** Items worth a line; ammo counts are noisy and ride with the weapon instead. */
const carried = ["bandage", "healthkit", "soda", "painkiller"] as const;

export interface StateBlockOptions {
    /** the agent's own id, so the planner knows which player it is */
    agentId: string;
    /** game time in seconds */
    t: number;
    /** what the agent is doing now, so the planner can decide to keep or break the commitment */
    currentSkill?: { skill: string; done: boolean; failed?: string } | null;
    /** most recent chat lines, oldest first: `["Kim: 밀자"]` */
    chat?: string[];
    /** the skills the planner's grammar accepts this turn; listed so the model is not steering against it */
    canDo?: readonly string[];
}

/**
 * One block per call. Lines are omitted entirely when they have nothing to say — an empty
 * `[enemies: ]` teaches the model that the field is usually empty, which is not the lesson.
 */
export function buildStateBlock(obs: AgentObservation, options: StateBlockOptions): string {
    const me = obs.self;
    const lines: string[] = [];

    lines.push(`[t=${round(options.t)}s you=${options.agentId} ${round(me.hp)}hp${me.downed ? " DOWNED" : ""}]`);

    const gun = me.weapon && me.weapon !== "fists" ? `${me.weapon} ${me.clip}/${me.reserve}` : "fists (no gun)";
    const bag = carried
        .map((item) => (me.inventory[item] ? `${me.inventory[item]} ${item}` : ""))
        .filter(Boolean)
        .join(" ");
    lines.push(`[weapon: ${gun}${bag ? ` | bag: ${bag}` : ""} | scope ${me.scope}]`);

    for (const mate of obs.teammates) {
        const state = mate.dead ? "DEAD" : mate.downed ? "DOWNED" : `${round(mate.hp)}hp`;
        lines.push(
            `[teammate ${mate.id}: ${state}, ${round(mate.dist)}m ${bearing(me.pos, mate.pos)}]`,
        );
    }

    if (obs.players.length) {
        const seen = obs.players
            .filter((p) => !p.dead)
            .sort((a, b) => a.dist - b.dist)
            .map((p) => {
                const armed = p.weapon && p.weapon !== "fists" ? p.weapon : "no gun";
                return `${p.id} ${round(p.dist)}m ${bearing(me.pos, p.pos)} ${armed}${p.downed ? " DOWNED" : ""}`;
            });
        if (seen.length) lines.push(`[enemies seen: ${seen.join(" | ")}]`);
    }

    if (obs.shots_heard.length) {
        // collapse to "3x NE mid" so a firefight does not eat the budget
        const counts = new Map<string, number>();
        for (const shot of obs.shots_heard) {
            const key = `${shot.dir} ${shot.range}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const heard = [...counts].map(([key, n]) => (n > 1 ? `${n}x ${key}` : key));
        lines.push(`[shots heard: ${heard.join(", ")}]`);
    }

    if (obs.loot.length) {
        const nearby = obs.loot
            .slice()
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 6)
            .map((l) => `${l.type}${l.count > 1 ? ` x${l.count}` : ""} ${round(l.dist)}m ${bearing(me.pos, l.pos)}`);
        lines.push(`[loot: ${nearby.join(", ")}]`);
    }

    // named, because a decision may say "hold c2": the same helper feeds the grammar and the resolver
    const cover = coverTargets(obs);
    if (cover.length) {
        lines.push(
            `[cover: ${
                cover.map((c) => `${c.name} ${c.label} ${round(c.dist)}m ${bearing(me.pos, c.pos)}`).join(", ")
            }]`,
        );
    }

    const buildings = buildingTargets(obs);
    if (buildings.length) {
        lines.push(
            `[buildings: ${
                buildings.map((b) => `${b.name} ${b.label} ${round(b.dist)}m ${bearing(me.pos, b.pos)}`).join(", ")
            }]`,
        );
    }

    if (obs.objective) {
        lines.push(`[point: ${round(obs.objective.dist)}m ${bearing(me.pos, obs.objective.pos)} (capture it)]`);
    }

    if (obs.gas.mode !== 0) {
        lines.push(`[gas: closing to r=${round(obs.gas.rad_new)} at ${bearing(me.pos, obs.gas.pos_new)}]`);
    }

    if (options.canDo?.length) lines.push(`[can do: ${options.canDo.join(", ")}]`);

    if (options.currentSkill) {
        const { skill, done, failed } = options.currentSkill;
        const state = failed ? `failed: ${failed}` : done ? "done" : "running";
        lines.push(`[doing: ${skill} (${state})]`);
    }

    for (const line of options.chat ?? []) lines.push(`[said: ${line}]`);

    return lines.join("\n");
}
