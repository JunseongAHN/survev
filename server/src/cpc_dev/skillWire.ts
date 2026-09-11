/**
 * Wire form of a skill request -> engine parameters.
 *
 * Shared by the two paths that hand System 1 a skill: the headless episode (Python over the bridge)
 * and the live hook (the SLM planner). Both must resolve a request identically — above all the
 * information-set rule for named places: `move_to {"to": ...}` is looked up in the requesting
 * agent's *own observation*, so an enemy off screen or an item not in view cannot be a destination.
 *
 * Agents are named by agent id, points by `{x, y}`; a malformed request throws with the field that
 * was wrong, which the bridge turns into an error message and the live planner into a fallback.
 */

import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Player } from "../game/objects/player.ts";
import type { AgentObservation } from "./observation.ts";
import type { SkillChoice } from "./scriptedPolicy.ts";
import type { SkillName } from "./skills.ts";

/**
 * A skill request as it arrives. Held like a primitive action: the skill runs every tick until
 * another action replaces it, which is the commit half of the planner's loop.
 */
export interface SkillRequest {
    skill: SkillName;
    params?: Record<string, unknown>;
}

export interface SkillResolver {
    /** the engine player behind an agent id; throws on an unknown id */
    playerOf(agentId: string): Player;
    /** the requesting agent's own observation; only built when a request names a place */
    observation(): AgentObservation;
}

export function wireVec(value: unknown, where: string): Vec2 {
    const v = value as { x?: unknown; y?: unknown } | undefined;
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") {
        throw new Error(`${where} must be {x, y}, got ${JSON.stringify(value)}`);
    }
    return v2.create(v.x, v.y);
}

export function wireNumber(value: unknown, where: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${where} must be a finite number, got ${JSON.stringify(value)}`);
    }
    return value;
}

export function wireString(value: unknown, where: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${where} must be a string, got ${JSON.stringify(value)}`);
    return value;
}

/**
 * A place named the way the state block names it — `"point"`, an agent id, `"loot:ak47"` — looked
 * up in the agent's own observation.
 */
export function namedPosition(obs: AgentObservation, to: string): Vec2 {
    if (to === "point") {
        if (!obs.objective) throw new Error(`move_to.params.to is "point" but there is no objective`);
        return v2.copy(obs.objective.pos);
    }
    if (to.startsWith("loot:")) {
        const type = to.slice("loot:".length);
        const pile = obs.loot.filter((l) => l.type === type).sort((a, b) => a.dist - b.dist)[0];
        if (!pile) throw new Error(`move_to.params.to: no ${type} in view`);
        return v2.copy(pile.pos);
    }
    const mate = obs.teammates.find((t) => t.id === to);
    if (mate) return v2.copy(mate.pos);
    const enemy = obs.players.find((p) => p.id === to);
    if (enemy) return v2.copy(enemy.pos);
    throw new Error(`move_to.params.to: ${to} is not in view`);
}

export function resolveSkillRequest(request: SkillRequest, resolver: SkillResolver): SkillChoice {
    const params = request.params ?? {};
    const at = (key: string): Player => {
        const id = wireString(params[key], `${request.skill}.params.${key}`);
        if (!id) throw new Error(`skill ${request.skill} needs params.${key} (an agent id)`);
        return resolver.playerOf(id);
    };
    const maybeAt = (key: string): Player | undefined =>
        params[key] === undefined || params[key] === null ? undefined : at(key);

    switch (request.skill) {
        case "move_to": {
            const arrive = wireNumber(params.arrive, "move_to.params.arrive");
            const face = params.face === undefined || params.face === null
                ? undefined
                : wireVec(params.face, "move_to.params.face");
            // a planner names places the way the state block does; raw coordinates stay for
            // programmatic callers (the Python skill mode)
            const pos = params.to !== undefined && params.to !== null
                ? namedPosition(resolver.observation(), wireString(params.to, "move_to.params.to")!)
                : wireVec(params.pos, "move_to.params.pos");
            return { skill: "move_to", params: { pos, arrive, face } };
        }
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
