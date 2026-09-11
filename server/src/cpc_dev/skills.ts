/**
 * System 1: the skills the CPC executes every tick.
 *
 * A skill is one intent plus its parameters, and it is what System 2 (the SLM planner) emits — it
 * never sends per-tick inputs, because a model that takes 0.3 s per decision cannot be on the path
 * of aiming and dodging. So the vocabulary here is the interface between the two systems: the
 * planner picks `{skill, params}` and commits to it for a while, and `runSkill` turns that into a
 * `CpcAction` on every one of the 100 ticks a second, reporting when the skill is done or cannot
 * run so the planner can be called again.
 *
 * The seven are the week-2 subset of the plan's eleven: `move_to`, `follow`, `loot`, `heal`,
 * `engage`, `retreat`, `revive`. `hold`, `peek`, `rotate_zone` and `idle_look` come with cover and
 * the gas schedule; `take_cover` is not implementable while the field scenario has no obstacles.
 *
 * The bodies are the scripted opponents' phases, extracted rather than rewritten: `loot` and
 * `engage` are `lootAction` and `combatAction` verbatim, and `revive` and `move_to` are the two
 * branches of `opponentAction`. That is deliberate — the chaser and the racer are rebuilt on top of
 * these skills in `scriptedPolicy.ts`, so the existing behaviour tests are the regression test for
 * this refactor, and the K-run baselines stay comparable.
 */

import { GameConfig } from "../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
import type { Player } from "../game/objects/player.ts";
import type { CpcAction } from "./applyCpcAction.ts";

/** Distance at which a bot opens fire; also the range at which an enemy counts as a threat. */
export const fireRange = 30;

const guns = new Set(["ak47", "mp5"]);
const ammoOf: Record<string, string> = { ak47: "762mm", mp5: "9mm" };
const healItems = ["healthkit", "bandage"] as const;

/**
 * Motor-level constraints, sampled per agent. These are the two axes the scripted opponents already
 * had (`scriptedOptions`) plus path jitter; a human's reaction time and aim error live here, not in
 * the planner. Zero means "perfect", which is what a benchmark opponent wants and what a teammate
 * meant to pass for a person does not.
 */
export interface SkillOptions {
    /** std-dev in degrees of the Gaussian error added to combat aim on every decision */
    aimNoiseDeg?: number;
    /** seconds an enemy must stay inside `fireRange` before this agent opens fire */
    reactionDelay?: number;
    /** std-dev in degrees of the error added to movement direction, so paths are not straight lines */
    pathJitterDeg?: number;
    /**
     * Seconds a noise sample is held before a new one is drawn; defaults to the 0.1 s decision
     * cadence. Noise is a property of a *decision*, not of a tick: skills re-run 100 times a
     * second, and redrawing that often reads as a tremor rather than as a human's aim wobble,
     * whose error is correlated over a few hundred ms (it drifts, then corrects).
     */
    noiseHoldSeconds?: number;
}

export interface SkillContext {
    game: Game;
    /** every scenario player, used to find teammates and enemies */
    players: Player[];
    /** game time in seconds */
    t: number;
    options?: SkillOptions;
    /** uniform [0, 1) source for the noise (seeded per episode); `Math.random` when absent */
    rand?: () => number;
    /** game time at which each agent's current fire-range contact began, by player id */
    contactSince?: Map<number, number>;
    /** held noise samples per agent, so aim and path wobble at decision rate and not at tick rate */
    noise?: Map<number, HeldNoise>;
}

export interface HeldNoise {
    until: number;
    aim: number;
    path: number;
}

export type SkillName = "move_to" | "follow" | "loot" | "heal" | "engage" | "retreat" | "revive";

/** Engine-facing parameters: targets are `Player`s, resolved from agent ids at the wire boundary. */
export interface SkillParams {
    /** `face` overrides where to look while walking — e.g. keep the gun on a threat */
    move_to: { pos: Vec2; arrive?: number; face?: Vec2 };
    follow: { target: Player; distance?: number };
    /** no `type` means "whatever I need next": a gun, then ammo for it */
    loot: { type?: string };
    heal: { item?: string };
    engage: { target: Player; style?: "push" | "hold_angle" | "trade" };
    retreat: { awayFrom?: Player; distance?: number };
    revive: { target: Player };
}

export interface SkillStatus {
    /** what to feed the engine this tick */
    action: CpcAction;
    /** the completion condition is met; the planner should pick something else */
    done: boolean;
    /** the skill cannot run at all (target gone, nothing to loot, no item) */
    failed?: string;
}

// --------------------------------------------------------------------------------------
// shared helpers (moved here from scriptedPolicy so the skills own them)

export function alive(p: Player): boolean {
    return !p.dead;
}

export function hasGun(p: Player): boolean {
    return !!p.weapons[GameConfig.WeaponSlot.Primary].type || !!p.weapons[GameConfig.WeaponSlot.Secondary].type;
}

export function gunSlot(p: Player): number {
    return p.weapons[GameConfig.WeaponSlot.Primary].type
        ? GameConfig.WeaponSlot.Primary
        : GameConfig.WeaponSlot.Secondary;
}

export function nearest<T>(from: Vec2, items: T[], pos: (item: T) => Vec2): { item: T; dist: number } | undefined {
    let best: { item: T; dist: number } | undefined;
    for (const item of items) {
        const dist = v2.distance(from, pos(item));
        if (!best || dist < best.dist) best = { item, dist };
    }
    return best;
}

/** Equip the gun and reload it when dry — the inputs every skill that might shoot needs. */
export function weaponInputs(me: Player): number[] {
    const inputs: number[] = [];
    const slot = gunSlot(me);
    if (me.curWeapIdx !== slot) {
        inputs.push(
            slot === GameConfig.WeaponSlot.Primary ? GameConfig.Input.EquipPrimary : GameConfig.Input.EquipSecondary,
        );
    }
    if (me.weapons[slot].ammo === 0) inputs.push(GameConfig.Input.Reload);
    return inputs;
}

/** standard normal via Box-Muller from a uniform [0, 1) source */
function gaussian(rand: () => number): number {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * The standard-normal pair this agent is currently using. Without `ctx.noise` every call draws its
 * own, which is the old per-decision behaviour of the scripted opponents; with it, a sample is kept
 * for `noiseHoldSeconds` so a skill running every tick does not shake.
 */
function heldNoise(ctx: SkillContext, me: Player): { aim: number; path: number } {
    const source = ctx.rand ?? Math.random;
    if (!ctx.noise) return { aim: gaussian(source), path: gaussian(source) };
    const hold = ctx.options?.noiseHoldSeconds ?? 0.1;
    const current = ctx.noise.get(me.__id);
    if (current && ctx.t < current.until) return current;
    const fresh: HeldNoise = { until: ctx.t + hold, aim: gaussian(source), path: gaussian(source) };
    ctx.noise.set(me.__id, fresh);
    return fresh;
}

function rotateBy(vec: Vec2, normal: number, sigmaDeg: number): Vec2 {
    if (sigmaDeg <= 0) return vec;
    return v2.rotate(vec, (normal * sigmaDeg * Math.PI) / 180);
}

export function withAimNoise(ctx: SkillContext, me: Player, aim: Vec2): Vec2 {
    const sigma = ctx.options?.aimNoiseDeg ?? 0;
    if (sigma <= 0) return aim;
    return rotateBy(aim, heldNoise(ctx, me).aim, sigma);
}

/** Movement is jittered too, so a path is not a straight line to its destination. */
export function withPathJitter(ctx: SkillContext, me: Player, move: Vec2): Vec2 {
    const sigma = ctx.options?.pathJitterDeg ?? 0;
    if (sigma <= 0) return move;
    return rotateBy(move, heldNoise(ctx, me).path, sigma);
}

/** Tracks when this agent's fire-range contact started; false until the reaction delay has passed. */
export function trackContact(ctx: SkillContext, me: Player, enemy: { dist: number } | undefined): boolean {
    const delay = ctx.options?.reactionDelay ?? 0;
    if (delay <= 0) return true;
    if (!ctx.contactSince) throw new Error("reactionDelay needs ctx.contactSince (per-episode state)");
    if (!enemy || enemy.dist >= fireRange) {
        ctx.contactSince.delete(me.__id);
        return false;
    }
    const since = ctx.contactSince.get(me.__id) ?? ctx.t;
    ctx.contactSince.set(me.__id, since);
    return ctx.t - since >= delay;
}

// --------------------------------------------------------------------------------------
// the skills

/** Walk to a point, gun ready. Done on arrival. */
function moveTo(ctx: SkillContext, me: Player, params: SkillParams["move_to"]): SkillStatus {
    const arrive = params.arrive ?? 2;
    const toPoint = v2.sub(params.pos, me.pos);
    const action: CpcAction = { aim: params.face ?? toPoint, inputs: weaponInputs(me) };
    if (v2.length(toPoint) <= arrive) return { action, done: true };
    action.move = withPathJitter(ctx, me, toPoint);
    return { action, done: false };
}

/** Stay within `distance` of a teammate. Never completes; fails when the teammate is dead. */
function follow(ctx: SkillContext, me: Player, params: SkillParams["follow"]): SkillStatus {
    const { target } = params;
    if (!alive(target)) return { action: {}, done: true, failed: "teammate is dead" };
    const distance = params.distance ?? 6;
    const toMate = v2.sub(target.pos, me.pos);
    const gap = v2.length(toMate);
    const action: CpcAction = { aim: toMate, inputs: weaponInputs(me) };
    if (gap > distance) action.move = withPathJitter(ctx, me, toMate);
    else if (gap < distance * 0.5) action.move = v2.mul(toMate, -1);
    return { action, done: false };
}

/** What the agent is shopping for: a gun, then ammo for it. `undefined` = nothing. */
function wantedLoot(me: Player, type?: string): Set<string> | undefined {
    if (type) return new Set([type]);
    if (!hasGun(me)) return guns;
    const weapon = me.weapons[gunSlot(me)];
    const ammoType = ammoOf[weapon.type];
    const reserve = (me.inventory as Readonly<Record<string, number>>)[ammoType] ?? 0;
    return weapon.ammo === 0 && reserve === 0 ? new Set([ammoType]) : undefined;
}

/**
 * Whether `loot` is worth selecting, without running it. A selector needs this: asking for the
 * skill when there is nothing to fetch would leave the agent standing still instead of moving on
 * to the next priority. An agent with no gun at all is the exception — it waits for one to exist.
 */
export function wantsLoot(ctx: SkillContext, me: Player, type?: string): boolean {
    const wanted = wantedLoot(me, type);
    if (!wanted) return false;
    if (!hasGun(me) && !type) return true;
    return ctx.game.lootBarn.loots.some((l) => !l.destroyed && wanted.has(l.type));
}

/** Pick up what the agent needs next: a gun, then ammo for it. `lootAction`, unchanged. */
function loot(ctx: SkillContext, me: Player, params: SkillParams["loot"]): SkillStatus {
    const wanted = wantedLoot(me, params.type);
    if (!wanted) return { action: {}, done: true };

    const piles = ctx.game.lootBarn.loots.filter((l) => !l.destroyed && wanted.has(l.type));
    const target = nearest(me.pos, piles, (l) => l.pos);
    if (!target) {
        // nothing of that kind is on the ground; only a gunless agent has to keep waiting for one
        return hasGun(me) || params.type
            ? { action: {}, done: true, failed: "no such loot in the world" }
            : { action: {}, done: false };
    }
    const action: CpcAction = { aim: v2.sub(target.item.pos, me.pos) };
    if (target.dist > 0.6) action.move = withPathJitter(ctx, me, v2.sub(target.item.pos, me.pos));
    if (target.dist < 2.2) action.inputs = [GameConfig.Input.Interact];
    return { action, done: false };
}

/** Use a healing item. Done once HP is full or the item is gone; fails when there is none. */
function heal(_ctx: SkillContext, me: Player, params: SkillParams["heal"]): SkillStatus {
    const inventory = me.inventory as Readonly<Record<string, number>>;
    const item = params.item ?? healItems.find((candidate) => (inventory[candidate] ?? 0) > 0);
    if (!item) return { action: {}, done: true, failed: "no healing item" };
    if ((inventory[item] ?? 0) <= 0) return { action: {}, done: true, failed: `no ${item} left` };
    if (me.health >= GameConfig.player.health) return { action: {}, done: true };
    // the engine runs the use as a timed action; repeating useItem while it runs is a no-op
    return { action: { useItem: item }, done: false };
}

/** Fight a target: close, strafe, back off, shoot. `combatAction`, unchanged. */
function engage(ctx: SkillContext, me: Player, params: SkillParams["engage"]): SkillStatus {
    const { target } = params;
    if (!alive(target)) return { action: {}, done: true };
    const slot = gunSlot(me);
    const toEnemy = v2.sub(target.pos, me.pos);
    const dist = v2.length(toEnemy);
    const inputs = weaponInputs(me);
    const action: CpcAction = { aim: withAimNoise(ctx, me, toEnemy), inputs };
    if (dist > 22) {
        action.move = withPathJitter(ctx, me, toEnemy);
    } else if (dist < 10) {
        action.move = withPathJitter(ctx, me, v2.mul(toEnemy, -1));
    } else {
        // strafe, flipping direction every second
        const side = Math.floor(ctx.t) % 2 === 0 ? 1 : -1;
        action.move = withPathJitter(ctx, me, v2.mul(v2.perp(toEnemy), side));
    }
    const reacted = trackContact(ctx, me, { dist });
    if (dist < fireRange && reacted && me.weapons[slot].ammo > 0 && me.curWeapIdx === slot) {
        action.fire = { hold: true };
    }
    return { action, done: false };
}

/** Break contact. Done once `distance` is open, or immediately when there is nothing to flee. */
function retreat(ctx: SkillContext, me: Player, params: SkillParams["retreat"]): SkillStatus {
    const distance = params.distance ?? fireRange;
    const from = params.awayFrom;
    if (!from || !alive(from)) return { action: {}, done: true };
    const away = v2.sub(me.pos, from.pos);
    if (v2.length(away) >= distance) return { action: { aim: v2.mul(away, -1) }, done: true };
    // keep facing the threat while backing off
    return {
        action: { move: withPathJitter(ctx, me, away), aim: v2.mul(away, -1), inputs: weaponInputs(me) },
        done: false,
    };
}

/** Get a downed teammate back up. Done when it is standing; fails when it died first. */
function revive(ctx: SkillContext, me: Player, params: SkillParams["revive"]): SkillStatus {
    const { target } = params;
    if (target.dead) return { action: {}, done: true, failed: "teammate died" };
    if (!target.downed) return { action: {}, done: true };
    const toMate = v2.sub(target.pos, me.pos);
    const inputs = weaponInputs(me);
    if (v2.length(toMate) > 2.5) {
        return { action: { move: withPathJitter(ctx, me, toMate), aim: toMate, inputs }, done: false };
    }
    return { action: { aim: toMate, inputs: [...inputs, GameConfig.Input.Revive] }, done: false };
}

/**
 * Runs one skill for one tick. A dead or downed agent has no inputs, so every skill reports done —
 * the planner has nothing to decide until it is revived.
 */
export function runSkill<K extends SkillName>(
    name: K,
    params: SkillParams[K],
    ctx: SkillContext,
    me: Player,
): SkillStatus {
    if (me.dead || me.downed) return { action: {}, done: true, failed: me.dead ? "dead" : "downed" };
    switch (name) {
        case "move_to":
            return moveTo(ctx, me, params as SkillParams["move_to"]);
        case "follow":
            return follow(ctx, me, params as SkillParams["follow"]);
        case "loot":
            return loot(ctx, me, params as SkillParams["loot"]);
        case "heal":
            return heal(ctx, me, params as SkillParams["heal"]);
        case "engage":
            return engage(ctx, me, params as SkillParams["engage"]);
        case "retreat":
            return retreat(ctx, me, params as SkillParams["retreat"]);
        case "revive":
            return revive(ctx, me, params as SkillParams["revive"]);
        default: {
            const exhaustive: never = name;
            throw new Error(`unknown skill ${exhaustive}`);
        }
    }
}
