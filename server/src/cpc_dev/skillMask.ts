/**
 * Which skills make sense *right now*, computed from the agent's own observation.
 *
 * The planner's grammar is rebuilt from this on every question, so a skill that cannot run — or
 * must not — is not merely discouraged in the prompt, it cannot be generated. That is the lesson of
 * the first playtest: the prompt already said "revive when no enemy is within 25m", and the planner
 * chose `revive` eight times in a row with an armed enemy at 21 m, standing still for eight seconds
 * while it was shot from 68 hp to 1. In the same match it chose `loot` while armed and `heal` with
 * nothing to heal with. A 4B model does not reliably apply a numeric rule; a grammar does. And
 * adding prompt rules had already backfired once (a "follow when idle" rule leaked into fights).
 *
 * Only the agent's observation is read, so the mask can never encode something the agent does not
 * know — it is the same information set the prompt is built from.
 */

import type { AgentObservation } from "./observation.ts";
import { reviveSafeDist } from "./scriptedPolicy.ts";
import type { SkillName } from "./skills.ts";

const healItems = ["healthkit", "bandage"] as const;

type Enemy = AgentObservation["players"][number];

/** An enemy that can hurt you now: standing, armed. A downed or unarmed one is not a revive-blocker. */
const isThreat = (p: Enemy) => !p.dead && !p.downed && !!p.weapon && p.weapon !== "fists";

/** `loot` only does something when there is no gun at all, or the gun in hand is out of ammo. */
function lootWouldAct(me: AgentObservation["self"]): boolean {
    const hasGun = me.weapons.some((w) => (w.slot === 0 || w.slot === 1) && !!w.type);
    if (!hasGun) return true;
    const holdingGun = !!me.weapon && me.weapon !== "fists";
    return holdingGun && me.clip === 0 && me.reserve === 0;
}

export function availableSkills(obs: AgentObservation): SkillName[] {
    const me = obs.self;
    const enemies = obs.players.filter((p) => !p.dead);
    const threatClose = enemies.some((p) => isThreat(p) && p.dist <= reviveSafeDist);
    const out: SkillName[] = [];

    // there is always somewhere to go: the race point, the teammate, a listed item
    out.push("move_to");
    if (obs.teammates.some((m) => !m.dead && !m.downed)) out.push("follow");
    if (lootWouldAct(me)) out.push("loot");
    if (me.hp < 100 && healItems.some((item) => (me.inventory[item] ?? 0) > 0)) out.push("heal");
    // a downed enemy can still be finished, but there is nothing to back away from
    if (enemies.length) out.push("engage");
    if (enemies.some((p) => !p.downed)) out.push("retreat");
    // eight seconds standing still: only when nobody armed is close enough to punish it
    if (obs.teammates.some((m) => m.downed && !m.dead) && !threatClose) out.push("revive");
    return out;
}
