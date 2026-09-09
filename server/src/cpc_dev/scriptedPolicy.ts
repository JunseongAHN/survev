import { GameConfig } from "../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game/game.ts";
import type { Player } from "../game/objects/player.ts";
import type { CpcAction } from "./applyCpcAction.ts";

export type ScriptedPolicyName = "chaser" | "idle" | "racer";

/**
 * Strength knobs for the scripted opponents (curriculum / benchmark strength). The defaults reproduce the
 * bots used so far: exact aim, fire as soon as an enemy is inside `fireRange`, racer engage distance 25 u.
 */
export interface ScriptedOptions {
    /** std-dev in degrees of the Gaussian error added to the aim on every combat decision; 0 = exact aim */
    aimNoiseDeg?: number;
    /** seconds an enemy has to stay inside `fireRange` before the bot opens fire; 0 = immediately */
    reactionDelay?: number;
    /** racer only: it breaks off toward an enemy inside this distance; default `racerEngageDist` */
    engageDist?: number;
}

export interface ScriptedContext {
    game: Game;
    /** every scenario player, used to find teammates and enemies */
    players: Player[];
    /** game time in seconds */
    t: number;
    /** the shared race point, when the episode has one (the racer goes for it) */
    objective?: { pos: Vec2; radius: number };
    options?: ScriptedOptions;
    /** uniform [0, 1) source for the aim noise (seeded per episode); `Math.random` when absent */
    rand?: () => number;
    /** game time at which each bot's current fire-range contact began (by player id); needed for `reactionDelay` */
    contactSince?: Map<number, number>;
}

/** the racer breaks off toward an enemy only inside this distance; farther enemies do not stop the run */
export const racerEngageDist = 25;
/** the bots hold fire only inside this distance */
export const fireRange = 30;

const guns = new Set(["ak47", "mp5"]);
const ammoOf: Record<string, string> = { ak47: "762mm", mp5: "9mm" };

function alive(p: Player) {
    return !p.dead;
}

function hasGun(p: Player) {
    return !!p.weapons[GameConfig.WeaponSlot.Primary].type || !!p.weapons[GameConfig.WeaponSlot.Secondary].type;
}

function gunSlot(p: Player) {
    return p.weapons[GameConfig.WeaponSlot.Primary].type
        ? GameConfig.WeaponSlot.Primary
        : GameConfig.WeaponSlot.Secondary;
}

function nearest<T>(from: Vec2, items: T[], pos: (item: T) => Vec2): { item: T; dist: number } | undefined {
    let best: { item: T; dist: number } | undefined;
    for (const item of items) {
        const dist = v2.distance(from, pos(item));
        if (!best || dist < best.dist) best = { item, dist };
    }
    return best;
}

/**
 * Shared phases of the scripted opponents. They read game state directly (omniscient); they are benchmark
 * opponents, not human-likeness references.
 *
 * - `chaser`: loot the nearest gun (then ammo if dry), approach the nearest enemy to 22 u, strafe between
 *   10 and 22 u, hold fire inside 30 u, revive a downed teammate when no enemy is within 25 u.
 * - `racer`: same loot and combat behaviour, but it only engages an enemy inside `racerEngageDist`;
 *   otherwise it runs to the shared race point (`ctx.objective`) so the other team's captures cost the
 *   controlled team points and killing it pays off within the episode. Without an objective it chases.
 *
 * `ctx.options` (`ScriptedOptions`) weakens them for a curriculum: `aimNoiseDeg` jitters the combat aim,
 * `reactionDelay` makes them hold fire until an enemy has been inside `fireRange` for that long, and
 * `engageDist` moves the racer's break-off distance.
 */
function lootAction(ctx: ScriptedContext, me: Player): CpcAction | undefined {
    let wanted: Set<string> | undefined;
    if (!hasGun(me)) {
        wanted = guns;
    } else {
        const weapon = me.weapons[gunSlot(me)];
        const ammoType = ammoOf[weapon.type];
        const reserve = (me.inventory as Readonly<Record<string, number>>)[ammoType] ?? 0;
        if (weapon.ammo === 0 && reserve === 0) wanted = new Set([ammoType]);
    }
    if (!wanted) return undefined;
    const loot = ctx.game.lootBarn.loots.filter((l) => !l.destroyed && wanted.has(l.type));
    const target = nearest(me.pos, loot, (l) => l.pos);
    if (target) {
        const action: CpcAction = { aim: v2.sub(target.item.pos, me.pos) };
        if (target.dist > 0.6) action.move = v2.sub(target.item.pos, me.pos);
        if (target.dist < 2.2) action.inputs = [GameConfig.Input.Interact];
        return action;
    }
    return hasGun(me) ? undefined : {};
}

function weaponInputs(me: Player): number[] {
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

function withAimNoise(ctx: ScriptedContext, aim: Vec2): Vec2 {
    const sigma = ctx.options?.aimNoiseDeg ?? 0;
    if (sigma <= 0) return aim;
    return v2.rotate(aim, (gaussian(ctx.rand ?? Math.random) * sigma * Math.PI) / 180);
}

/** Tracks when the bot's current fire-range contact started and says whether the reaction delay has passed. */
function trackContact(ctx: ScriptedContext, me: Player, enemy: { dist: number } | undefined): boolean {
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

function combatAction(
    ctx: ScriptedContext,
    me: Player,
    enemy: { item: Player; dist: number },
    inputs: number[],
    reacted: boolean,
): CpcAction {
    const slot = gunSlot(me);
    const toEnemy = v2.sub(enemy.item.pos, me.pos);
    const action: CpcAction = { aim: withAimNoise(ctx, toEnemy), inputs };
    if (enemy.dist > 22) {
        action.move = toEnemy;
    } else if (enemy.dist < 10) {
        action.move = v2.mul(toEnemy, -1);
    } else {
        // strafe, flipping direction every second
        const side = Math.floor(ctx.t) % 2 === 0 ? 1 : -1;
        action.move = v2.mul(v2.perp(toEnemy), side);
    }
    if (enemy.dist < fireRange && reacted && me.weapons[slot].ammo > 0 && me.curWeapIdx === slot) {
        action.fire = { hold: true };
    }
    return action;
}

function opponentAction(ctx: ScriptedContext, me: Player, engageDist: number): CpcAction {
    if (me.dead || me.downed) return {};
    // contact bookkeeping runs before the loot phase so the reaction clock also counts time spent looting
    const enemies = ctx.players.filter((p) => p.groupId !== me.groupId && alive(p));
    const enemy = nearest(me.pos, enemies, (p) => p.pos);
    const reacted = trackContact(ctx, me, enemy);
    const loot = lootAction(ctx, me);
    if (loot) return loot;

    const teammate = ctx.players.find((p) => p !== me && p.groupId === me.groupId && alive(p));
    const inputs = weaponInputs(me);
    if (teammate?.downed && (!enemy || enemy.dist > 25)) {
        const toMate = v2.sub(teammate.pos, me.pos);
        if (v2.length(toMate) > 2.5) return { move: toMate, aim: toMate, inputs };
        return { aim: toMate, inputs: [...inputs, GameConfig.Input.Revive] };
    }
    if (enemy && enemy.dist <= engageDist) return combatAction(ctx, me, enemy, inputs, reacted);
    if (ctx.objective) {
        const toPoint = v2.sub(ctx.objective.pos, me.pos);
        const action: CpcAction = { inputs, aim: enemy ? v2.sub(enemy.item.pos, me.pos) : toPoint };
        if (v2.length(toPoint) > ctx.objective.radius * 0.5) action.move = toPoint;
        return action;
    }
    if (!enemy) return { inputs };
    return combatAction(ctx, me, enemy, inputs, reacted);
}

export function chaserAction(ctx: ScriptedContext, me: Player): CpcAction {
    // the chaser never races: pass a context without the objective so it always closes on the enemy
    return opponentAction({ ...ctx, objective: undefined }, me, Number.POSITIVE_INFINITY);
}

export function racerAction(ctx: ScriptedContext, me: Player): CpcAction {
    const engageDist = ctx.options?.engageDist ?? racerEngageDist;
    return opponentAction(ctx, me, ctx.objective ? engageDist : Number.POSITIVE_INFINITY);
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
