/**
 * The scripted opponents, as a skill selector on top of `skills.ts`.
 *
 * They read game state directly (omniscient); they are benchmark opponents and a strength axis, not
 * human-likeness references. What they contribute to the CPC is this file's shape: a priority order
 * over skills is exactly the job System 2 will do, so the hand-written order here is the baseline
 * the SLM planner has to beat.
 *
 * - `chaser`: loot the nearest gun (then ammo if dry), approach the nearest enemy to 22 u, strafe
 *   between 10 and 22 u, hold fire inside 30 u, revive a downed teammate when no enemy is within 25 u.
 * - `racer`: the same loot and combat behaviour, but it only engages an enemy inside `engageDist`;
 *   otherwise it runs to the shared race point (`ctx.objective`) so the other team's captures cost
 *   the controlled team points and killing it pays off within the episode. With no objective it chases.
 *
 * `ctx.options` weakens them for a curriculum: `aimNoiseDeg` jitters the combat aim, `reactionDelay`
 * makes them hold fire until an enemy has been inside `fireRange` for that long, `pathJitterDeg`
 * bends their paths, and `engageDist` moves the racer's break-off distance.
 */

import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Player } from "../game/objects/player.ts";
import type { CpcAction } from "./applyCpcAction.ts";
import {
    defaultPursuitMemory,
    defaultSightRange,
    lastKnown,
    rememberSightings,
    type Sighting,
    type VisionOptions,
} from "./botVision.ts";
import {
    alive,
    fireRange,
    nearest,
    runSkill,
    type SkillContext,
    type SkillName,
    type SkillOptions,
    type SkillParams,
    trackContact,
    wantsLoot,
    weaponInputs,
} from "./skills.ts";

export type ScriptedPolicyName = "chaser" | "idle" | "racer";

/** The racer breaks off toward an enemy inside this distance and otherwise runs for the point. */
export const racerEngageDist = 25;
/** A downed teammate is only picked up when no enemy is this close. */
export const reviveSafeDist = 25;

export { fireRange };

export interface ScriptedOptions extends SkillOptions, VisionOptions {
    /** racer only: it breaks off toward an enemy inside this distance; default `racerEngageDist` */
    engageDist?: number;
}

export interface ScriptedContext extends SkillContext {
    options?: ScriptedOptions;
    /** the shared race point, when the episode has one (the racer goes for it) */
    objective?: { pos: Vec2; radius: number };
}

/** One selected skill, ready for `runSkill`. */
export type SkillChoice = { [K in SkillName]: { skill: K; params: SkillParams[K] } }[SkillName];

/**
 * The priority order. Returns the skill to run, or `undefined` when nothing applies — the agent
 * then only equips and reloads (the plan's `idle_look` will fill that slot).
 */
export function selectSkill(ctx: ScriptedContext, me: Player, engageDist: number): SkillChoice | undefined {
    const enemies = ctx.players.filter((p) => p.groupId !== me.groupId && alive(p));
    // What the bot may act on. `omniscient` is the pre-2026-09-14 behaviour, kept so old baselines
    // can be reproduced: it chases enemies it cannot see, which made withdrawing impossible -- the
    // nearest-enemy distance and the closing rate came out identical whether the controller was told
    // to engage or to retreat.
    let visible = enemies;
    let trail: Sighting | undefined;
    if (ctx.options?.vision !== "omniscient") {
        if (!ctx.sightMemory) {
            throw new Error("line-of-sight vision needs ctx.sightMemory (per-episode state)");
        }
        visible = rememberSightings(
            ctx.sightMemory,
            ctx.game,
            me,
            enemies,
            ctx.t,
            ctx.options?.sightRange ?? defaultSightRange,
        );
        if (visible.length === 0) {
            trail = lastKnown(
                ctx.sightMemory,
                me,
                enemies,
                ctx.t,
                ctx.options?.pursuitMemory ?? defaultPursuitMemory,
            );
        }
    }
    const enemy = nearest(me.pos, visible, (p) => p.pos);
    // the contact clock is read before anything else so it also counts time spent looting, which is
    // what makes `reactionDelay` a delay on *seeing* an enemy rather than on choosing to fight
    trackContact(ctx, me, enemy);

    // shopping outranks everything: an unarmed agent has nothing to contribute to a fight
    if (wantsLoot(ctx, me)) return { skill: "loot", params: {} };

    const teammate = ctx.players.find((p) => p !== me && p.groupId === me.groupId && alive(p));
    if (teammate?.downed && (!enemy || enemy.dist > reviveSafeDist)) {
        return { skill: "revive", params: { target: teammate } };
    }
    if (enemy && enemy.dist <= engageDist) {
        return { skill: "engage", params: { target: enemy.item } };
    }
    // it watched someone step behind a wall: walk to where they were, then give up. This is what
    // makes breaking the line an actual escape rather than a cosmetic one.
    if (!enemy && trail) {
        return { skill: "move_to", params: { pos: trail.pos, arrive: 2 } };
    }
    if (ctx.objective) {
        return {
            skill: "move_to",
            params: {
                pos: ctx.objective.pos,
                arrive: ctx.objective.radius * 0.5,
                // keep the gun pointed at the threat while running the race
                face: enemy ? v2.sub(enemy.item.pos, me.pos) : undefined,
            },
        };
    }
    if (enemy) {
        return { skill: "engage", params: { target: enemy.item } };
    }
    // Nothing seen and no trail left: walk to the middle of the play area. Without this a bot that
    // has never had line of sight -- at spawn behind cover, or after someone successfully broke away
    // -- would stand still, which deadlocks the scenario instead of restarting the fight.
    const centre = ctx.game.gas?.currentPos;
    if (centre) {
        return { skill: "move_to", params: { pos: centre, arrive: 6 } };
    }
    return undefined;
}

function act(ctx: ScriptedContext, me: Player, engageDist: number): CpcAction {
    if (me.dead || me.downed) return {};

    const choice = selectSkill(ctx, me, engageDist);
    if (!choice) return { inputs: weaponInputs(me) };
    return runSkill(choice.skill, choice.params, ctx, me).action;
}

export function chaserAction(ctx: ScriptedContext, me: Player): CpcAction {
    // the chaser never races: drop the objective so it always closes on the enemy
    return act({ ...ctx, objective: undefined }, me, Number.POSITIVE_INFINITY);
}

export function racerAction(ctx: ScriptedContext, me: Player): CpcAction {
    const engageDist = ctx.options?.engageDist ?? racerEngageDist;
    return act(ctx, me, ctx.objective ? engageDist : Number.POSITIVE_INFINITY);
}

export function scriptedAction(policy: ScriptedPolicyName, ctx: ScriptedContext, me: Player): CpcAction {
    switch (policy) {
        case "chaser":
            return chaserAction(ctx, me);
        case "racer":
            return racerAction(ctx, me);
        default:
            return {};
    }
}
