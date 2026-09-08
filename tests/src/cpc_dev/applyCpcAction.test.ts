import { expect, test, vi } from "vitest";
import { applyCpcAction, buildInputMsg } from "../../../server/src/cpc_dev/applyCpcAction.ts";
import { stepGame } from "../../../server/src/cpc_dev/stepGame.ts";
import { Config } from "../../../server/src/config.ts";
import { GameConfig, TeamMode } from "../../../shared/gameConfig.ts";
import { InputMsg } from "../../../shared/net/inputMsg.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import { createGame } from "../gameTestHelpers.ts";

const ticksPerSecond = Config.gameTps;

function createPlayer() {
    const game = createGame(TeamMode.Duo, "test_normal");
    const group = game.playerBarn.addGroup(false);
    const pos = v2.create(game.map.width / 2, game.map.height / 2);
    const player = game.playerBarn.addTestPlayer({ group, pos });
    return { game, group, player };
}

function expectDisplacement(
    player: { pos: Vec2; speed: number },
    start: Vec2,
    dir: Vec2,
    seconds: number,
) {
    const moved = v2.sub(player.pos, start);
    const expected = v2.mul(v2.normalizeSafe(dir), player.speed * seconds);
    // M2: within 2% of the server's effective speed
    expect(v2.distance(moved, expected)).toBeLessThan(player.speed * seconds * 0.02);
}

test("adapter builds the same InputMsg a client would send", () => {
    const expected = new InputMsg();
    expected.moveRight = true;
    expected.moveUp = true;
    expected.toMouseDir = v2.create(0, 1);
    expected.shootHold = true;
    expected.addInput(GameConfig.Input.Reload);
    expected.useItem = "bandage";

    const msg = buildInputMsg({
        move: v2.create(1, 1),
        aim: v2.create(0, 5),
        fire: { hold: true },
        inputs: [GameConfig.Input.Reload],
        useItem: "bandage",
    });

    expect(msg).toEqual(expected);
});

test("keys mode moves at the server speed and quantizes to 8 directions", () => {
    const { game, player } = createPlayer();

    let start = v2.copy(player.pos);
    applyCpcAction(player, { move: v2.create(1, 0) });
    stepGame(game, ticksPerSecond);
    // speed is only known after the first update (base moveSpeed + equipped weapon bonus)
    expect(player.speed).toBeGreaterThanOrEqual(GameConfig.player.moveSpeed);
    expectDisplacement(player, start, v2.create(1, 0), 1);

    // 11deg off the axis still maps to a single key
    start = v2.copy(player.pos);
    applyCpcAction(player, { move: v2.create(1, 0.2) });
    stepGame(game, ticksPerSecond);
    expectDisplacement(player, start, v2.create(1, 0), 1);

    // diagonal presses two keys, the server normalizes the resulting vector
    start = v2.copy(player.pos);
    applyCpcAction(player, { move: v2.create(-1, -1) });
    stepGame(game, ticksPerSecond);
    expectDisplacement(player, start, v2.create(-1, -1), 1);

    start = v2.copy(player.pos);
    applyCpcAction(player, {});
    stepGame(game, ticksPerSecond);
    expect(v2.distance(player.pos, start)).toBe(0);
});

test("touch mode moves along a continuous direction", () => {
    const { game, player } = createPlayer();

    const start = v2.copy(player.pos);
    applyCpcAction(player, { move: v2.create(2, 1) }, "touch");
    stepGame(game, ticksPerSecond);
    expectDisplacement(player, start, v2.create(2, 1), 1);
});

test("aim sets the player direction", () => {
    const { game, player } = createPlayer();

    applyCpcAction(player, { aim: v2.create(0, 3) });
    stepGame(game, 1);

    expect(player.dir.x).toBeCloseTo(0, 6);
    expect(player.dir.y).toBeCloseTo(1, 6);
});

test("fire.start fires a single-fire gun exactly once", () => {
    const { game, player } = createPlayer();
    player.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, "m9", 15);
    player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
    stepGame(game, ticksPerSecond); // clear the switch delay

    const fireBullet = vi.spyOn(game.bulletBarn, "fireBullet");
    applyCpcAction(player, { aim: v2.create(1, 0), fire: { start: true } });
    stepGame(game, ticksPerSecond);

    expect(fireBullet).toHaveBeenCalledTimes(1);
});

test("fire.hold fires an auto gun at its fire delay until released", () => {
    const { game, player } = createPlayer();
    player.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "ak47", 30);
    player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    stepGame(game, ticksPerSecond); // clear the switch delay

    const fireBullet = vi.spyOn(game.bulletBarn, "fireBullet");
    applyCpcAction(player, { aim: v2.create(1, 0), fire: { hold: true } });
    stepGame(game, ticksPerSecond);

    // ak47 fireDelay is 0.1s: 10 shots per second, +-1 for tick alignment
    const shotsWhileHeld = fireBullet.mock.calls.length;
    expect(shotsWhileHeld).toBeGreaterThanOrEqual(9);
    expect(shotsWhileHeld).toBeLessThanOrEqual(11);

    applyCpcAction(player, { aim: v2.create(1, 0), fire: { hold: false } });
    stepGame(game, ticksPerSecond);
    expect(fireBullet).toHaveBeenCalledTimes(shotsWhileHeld);
});

test("Interact picks up loot in reach", () => {
    const { game, player } = createPlayer();
    game.lootBarn.addLoot("bandage", v2.add(player.pos, v2.create(1, 0)), 0, 1, { source: "map" });
    stepGame(game, 3);

    applyCpcAction(player, { inputs: [GameConfig.Input.Interact] });
    stepGame(game, 3);

    expect(player.inventory["bandage"]).toBe(1);
});

test("useItem heals after the item use time", () => {
    const { game, player } = createPlayer();
    player.health = 50;
    player.invManager.set("bandage", 1);

    applyCpcAction(player, { useItem: "bandage" });
    stepGame(game, Math.ceil(3.2 * ticksPerSecond)); // bandage useTime is 3s

    expect(player.health).toBe(65);
    expect(player.inventory["bandage"]).toBe(0);
});

test("Revive brings a downed teammate back up after reviveDuration", () => {
    const { game, group, player } = createPlayer();
    const teammate = game.playerBarn.addTestPlayer({ group, pos: v2.add(player.pos, v2.create(1, 0)) });

    teammate.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Airdrop,
        dir: v2.create(1, 0),
    });
    expect(teammate.downed).toBe(true);

    applyCpcAction(player, { inputs: [GameConfig.Input.Revive] });
    expect(player.playerBeingRevived).toBe(teammate);

    stepGame(game, Math.ceil((GameConfig.player.reviveDuration + 0.1) * ticksPerSecond));

    expect(teammate.downed).toBe(false);
    expect(teammate.dead).toBe(false);
});
