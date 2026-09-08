import type { DamageType } from "../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { DamageParams } from "../game/objects/gameObject.ts";
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

export type CpcEvent = FireEvent | DamageEvent | DownEvent | KillEvent;

export interface EventTaps {
    events: CpcEvent[];
    detach(): void;
}

function sourceIdOf(params: DamageParams): number | null {
    return params.source?.__id ?? null;
}

/**
 * Records fire / damage / down / kill events for `players` by wrapping the engine methods on those instances.
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

        restores.push(() => {
            weaponManager.fireWeapon = fireWeapon;
            player.damage = damage;
            player.down = down;
            player.kill = kill;
        });
    }

    return {
        events,
        detach() {
            for (const restore of restores) restore();
        },
    };
}
