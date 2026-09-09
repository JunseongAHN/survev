import { expect, test } from "vitest";
import { applyCpcAction } from "../../../server/src/cpc_dev/applyCpcAction.ts";
import {
    attachEventTaps,
    type DamageEvent,
    type HealEvent,
    type LootEvent,
    type ReviveEvent,
} from "../../../server/src/cpc_dev/eventTaps.ts";
import { stepGame } from "../../../server/src/cpc_dev/stepGame.ts";
import { Config } from "../../../server/src/config.ts";
import { GameConfig, TeamMode } from "../../../shared/gameConfig.ts";
import { v2 } from "../../../shared/utils/v2.ts";
import { createGame } from "../gameTestHelpers.ts";

const ticksPerSecond = Config.gameTps;

test("taps record fire, damage and kill with the right attribution and HP bookkeeping", () => {
    const game = createGame(TeamMode.Duo, "test_normal");
    const center = v2.create(game.map.width / 2, game.map.height / 2);
    const shooter = game.playerBarn.addTestPlayer({ group: game.playerBarn.addGroup(false), pos: center });
    const target = game.playerBarn.addTestPlayer({
        group: game.playerBarn.addGroup(false),
        pos: v2.add(center, v2.create(6, 0)),
    });
    shooter.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "ak47", 30);
    shooter.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    stepGame(game, ticksPerSecond);

    let tick = 0;
    const taps = attachEventTaps([shooter, target], () => tick / ticksPerSecond);

    applyCpcAction(shooter, { aim: v2.create(1, 0), fire: { hold: true } });
    while (!target.dead && tick < 3 * ticksPerSecond) {
        stepGame(game, 1);
        tick++;
    }
    expect(target.dead).toBe(true);

    const fires = taps.events.filter((e) => e.type === "fire");
    const hits = taps.events.filter((e): e is DamageEvent => e.type === "damage");
    const kills = taps.events.filter((e) => e.type === "kill");

    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((e) => e.playerId === shooter.__id && e.weapon === "ak47")).toBe(true);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(fires.length);
    expect(hits.every((e) => e.playerId === target.__id && e.sourceId === shooter.__id && e.weapon === "ak47"))
        .toBe(true);
    // every hit's bookkeeping is consistent and the hits add up to the full health bar
    for (const hit of hits) {
        expect(hit.amount).toBeGreaterThan(0);
        expect(hit.hpAfter).toBeLessThanOrEqual(hit.hpBefore);
    }
    expect(hits.reduce((sum, hit) => sum + hit.amount, 0)).toBeCloseTo(GameConfig.player.health, 5);
    expect(hits[hits.length - 1].dead).toBe(true);

    // a lone duo member is killed outright: one kill, credited to the shooter, right after the last hit
    expect(kills).toHaveLength(1);
    expect(kills[0].sourceId).toBe(shooter.__id);
    expect(taps.events.indexOf(kills[0])).toBe(taps.events.indexOf(hits[hits.length - 1]) + 1);
    expect(taps.events.filter((e) => e.type === "down")).toHaveLength(0);

    // nothing is recorded after detach
    const recorded = taps.events.length;
    taps.detach();
    stepGame(game, ticksPerSecond);
    expect(taps.events).toHaveLength(recorded);
});

test("a duo member with a living teammate is downed, not killed", () => {
    const game = createGame(TeamMode.Duo, "test_normal");
    const center = v2.create(game.map.width / 2, game.map.height / 2);
    const enemy = game.playerBarn.addTestPlayer({ group: game.playerBarn.addGroup(false), pos: center });
    const duo = game.playerBarn.addGroup(false);
    const victim = game.playerBarn.addTestPlayer({ group: duo, pos: v2.add(center, v2.create(6, 0)) });
    game.playerBarn.addTestPlayer({ group: duo, pos: v2.add(center, v2.create(0, 40)) });

    let tick = 0;
    const taps = attachEventTaps([enemy, victim], () => tick / ticksPerSecond);
    victim.damage({ amount: 999, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0), source: enemy });

    const hit = taps.events[0] as DamageEvent;
    expect(hit.type).toBe("damage");
    expect(hit.amount).toBe(GameConfig.player.health);
    expect(hit.downed).toBe(true);
    expect(hit.dead).toBe(false);
    expect(taps.events[1]).toMatchObject({ type: "down", playerId: victim.__id, sourceId: enemy.__id });
    expect(taps.events).toHaveLength(2);
});

function createDuo() {
    const game = createGame(TeamMode.Duo, "test_normal");
    const group = game.playerBarn.addGroup(false);
    const pos = v2.create(game.map.width / 2, game.map.height / 2);
    const player = game.playerBarn.addTestPlayer({ group, pos });
    const teammate = game.playerBarn.addTestPlayer({ group, pos: v2.add(pos, v2.create(1, 0)) });
    return { game, group, player, teammate };
}

/** Steps one tick at a time so the taps' clock advances with the game. */
function clock(game: ReturnType<typeof createGame>) {
    let tick = 0;
    return {
        now: () => tick / ticksPerSecond,
        advance(ticks: number) {
            for (let i = 0; i < ticks; i++) {
                stepGame(game, 1);
                tick++;
            }
        },
    };
}

test("loot events record a pickup that changed the player's holdings, and nothing else", () => {
    const { game, player } = createDuo();
    game.lootBarn.addLoot("bandage", v2.add(player.pos, v2.create(1, 0)), 0, 4, { source: "map" });
    stepGame(game, 3);

    const time = clock(game);
    const taps = attachEventTaps([player], time.now);

    applyCpcAction(player, { inputs: [GameConfig.Input.Interact] });
    time.advance(3);

    const loot = taps.events.filter((e): e is LootEvent => e.type === "loot");
    expect(loot).toHaveLength(1);
    expect(loot[0]).toMatchObject({ playerId: player.__id, item: "bandage", count: 4 });
    expect(player.inventory["bandage"]).toBe(4);

    // the pile is gone; pressing Interact again changes nothing and emits nothing
    applyCpcAction(player, { inputs: [GameConfig.Input.Interact] });
    time.advance(3);
    expect(taps.events.filter((e) => e.type === "loot")).toHaveLength(1);
});

test("heal events fire when the item is consumed, not when the action starts", () => {
    const { game, player } = createDuo();
    player.health = 50;
    player.invManager.set("bandage", 1);

    const time = clock(game);
    const taps = attachEventTaps([player], time.now);

    applyCpcAction(player, { useItem: "bandage" });
    // bandage useTime is 3 s: nothing yet after 1 s
    time.advance(ticksPerSecond);
    expect(taps.events.filter((e) => e.type === "heal")).toHaveLength(0);

    time.advance(Math.ceil(2.2 * ticksPerSecond));

    const heals = taps.events.filter((e): e is HealEvent => e.type === "heal");
    expect(heals).toHaveLength(1);
    expect(heals[0]).toMatchObject({ playerId: player.__id, item: "bandage", hpBefore: 50, hpAfter: 65 });
    expect(heals[0].t).toBeGreaterThan(2.9);
    expect(player.health).toBe(65);
});

test("revive events name the revived teammate as the agent and the reviver as the source", () => {
    const { game, player, teammate } = createDuo();
    teammate.damage({ amount: 999, damageType: GameConfig.DamageType.Airdrop, dir: v2.create(1, 0) });
    expect(teammate.downed).toBe(true);

    const time = clock(game);
    const taps = attachEventTaps([player, teammate], time.now);

    applyCpcAction(player, { inputs: [GameConfig.Input.Revive] });
    time.advance(Math.ceil((GameConfig.player.reviveDuration + 0.1) * ticksPerSecond));

    const revives = taps.events.filter((e): e is ReviveEvent => e.type === "revive");
    expect(revives).toHaveLength(1);
    expect(revives[0]).toMatchObject({ playerId: teammate.__id, sourceId: player.__id });
    expect(revives[0].t).toBeGreaterThan(GameConfig.player.reviveDuration - 0.1);
    expect(teammate.downed).toBe(false);
});
