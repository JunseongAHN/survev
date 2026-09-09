import { type DamageType, GameConfig } from "../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { DamageParams } from "../game/objects/gameObject.ts";
import type { Loot } from "../game/objects/loot.ts";
import type { Player } from "../game/objects/player.ts";

export interface FireEvent {
    type: "fire";
    t: number;
    playerId: number;
    weapon: string;
    pos: Vec2;
    dir: Vec2;
}

export interface DamageEvent {
    type: "damage";
    t: number;
    playerId: number;
    sourceId: number | null;
    weapon: string | null;
    damageType: DamageType;
    /** HP actually removed (after armor). A downing or killing hit removes everything that was left. */
    amount: number;
    hpBefore: number;
    hpAfter: number;
    downed: boolean;
    dead: boolean;
    pos: Vec2;
}

export interface DownEvent {
    type: "down";
    t: number;
    playerId: number;
    sourceId: number | null;
}

export interface KillEvent {
    type: "kill";
    t: number;
    playerId: number;
    sourceId: number | null;
}

export interface LootEvent {
    type: "loot";
    t: number;
    playerId: number;
    item: string;
    /** the pile's count; when only part of it fits the engine re-drops the rest as fresh loot */
    count: number;
    pos: Vec2;
}

export interface HealEvent {
    type: "heal";
    t: number;
    playerId: number;
    /** the consumed item: a heal (bandage, healthkit) or a boost (soda, painkiller) */
    item: string;
    hpBefore: number;
    hpAfter: number;
    boostBefore: number;
    boostAfter: number;
}

export interface ReviveEvent {
    type: "revive";
    t: number;
    /** the revived teammate, as in `down` / `kill`; `sourceId` is the reviver */
    playerId: number;
    sourceId: number;
}

export type CpcEvent = FireEvent | DamageEvent | DownEvent | KillEvent | LootEvent | HealEvent | ReviveEvent;

export interface EventTaps {
    events: CpcEvent[];
    detach(): void;
}

function sourceIdOf(params: DamageParams): number | null {
    return params.source?.__id ?? null;
}

/** Everything a loot pickup can change, as one comparable string. */
function holdings(player: Player): string {
    const inventory = Object.entries(player.inventory)
        .map(([item, count]) => `${item}:${count}`)
        .sort()
        .join(",");
    const weapons = player.weapons.map((w) => `${w.type}/${w.ammo}`).join(",");
    return `${inventory}|${weapons}|${player.helmet}|${player.chest}|${player.backpack}|${player.scope}`;
}

/**
 * Records fire / damage / down / kill / loot / heal / revive events for `players` by wrapping the engine methods on those instances.
 * `now` supplies the current game time in seconds. Call `detach()` to restore the original methods.
 */
export function attachEventTaps(players: Player[], now: () => number): EventTaps {
    const events: CpcEvent[] = [];
    const restores: Array<() => void> = [];

    for (const player of players) {
        const weaponManager = player.weaponManager;
        const fireWeapon = weaponManager.fireWeapon;
        const damage = player.damage;
        const down = player.down;
        const kill = player.kill;
        const pickupLoot = player.pickupLoot;
        const applyActionFunc = player.applyActionFunc;

        weaponManager.fireWeapon = (offHand: boolean, forceFire?: boolean) => {
            const weapon = weaponManager.weapons[weaponManager.curWeapIdx];
            const ammoBefore = weapon.ammo;
            fireWeapon.call(weaponManager, offHand, forceFire);
            if (weapon.ammo < ammoBefore) {
                events.push({
                    type: "fire",
                    t: now(),
                    playerId: player.__id,
                    weapon: player.activeWeapon,
                    pos: v2.copy(player.pos),
                    dir: v2.copy(player.dir),
                });
            }
        };

        player.damage = (params: DamageParams) => {
            const hpBefore = player.health;
            const wasDowned = player.downed;
            const insertAt = events.length;
            damage.call(player, params);
            const lostEverything = player.dead || (player.downed && !wasDowned);
            // keep the damage event ahead of the down / kill events emitted inside damage()
            events.splice(insertAt, 0, {
                type: "damage",
                t: now(),
                playerId: player.__id,
                sourceId: sourceIdOf(params),
                weapon: params.gameSourceType ?? null,
                damageType: params.damageType,
                amount: lostEverything ? hpBefore : Math.max(0, hpBefore - player.health),
                hpBefore,
                hpAfter: player.health,
                downed: player.downed,
                dead: player.dead,
                pos: v2.copy(player.pos),
            });
        };

        player.down = (params: DamageParams) => {
            down.call(player, params);
            events.push({ type: "down", t: now(), playerId: player.__id, sourceId: sourceIdOf(params) });
        };

        player.kill = (params: DamageParams) => {
            kill.call(player, params);
            events.push({ type: "kill", t: now(), playerId: player.__id, sourceId: sourceIdOf(params) });
        };

        player.pickupLoot = (obj: Loot) => {
            const item = obj.type;
            const count = obj.count;
            const pos = v2.copy(obj.pos);
            const before = holdings(player);
            pickupLoot.call(player, obj);
            // pickupLoot always destroys the pile and re-drops whatever did not fit, so the
            // player's own holdings are the only signal that something was actually taken
            if (holdings(player) !== before) {
                events.push({ type: "loot", t: now(), playerId: player.__id, item, count, pos });
            }
        };

        // the engine calls applyActionFunc when a UseItem / Revive action completes
        player.applyActionFunc = (actionFunc: (target: Player) => void) => {
            const actionType = player.actionType;
            const item = player.actionItem;
            const hpBefore = player.health;
            const boostBefore = player.boost;
            const revived = player.playerBeingRevived;
            const wasDowned = revived?.downed ?? false;
            applyActionFunc.call(player, actionFunc);
            if (actionType === GameConfig.Action.UseItem) {
                events.push({
                    type: "heal",
                    t: now(),
                    playerId: player.__id,
                    item,
                    hpBefore,
                    hpAfter: player.health,
                    boostBefore,
                    boostAfter: player.boost,
                });
            } else if (actionType === GameConfig.Action.Revive && revived && wasDowned && !revived.downed) {
                events.push({ type: "revive", t: now(), playerId: revived.__id, sourceId: player.__id });
            }
        };

        restores.push(() => {
            weaponManager.fireWeapon = fireWeapon;
            player.damage = damage;
            player.down = down;
            player.kill = kill;
            player.pickupLoot = pickupLoot;
            player.applyActionFunc = applyActionFunc;
        });
    }

    return {
        events,
        detach() {
            for (const restore of restores) restore();
        },
    };
}
