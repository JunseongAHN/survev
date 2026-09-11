/**
 * System 1 skills: the parameters, the completion condition and the failure condition of each.
 *
 * The chaser and the racer are rebuilt on these skills, so `episode.test.ts` is the regression test
 * for their behaviour. What this file covers is the part the opponents never used: `move_to`'s
 * arrival, `follow`'s standoff distance, `heal`, `retreat`, and the `done` / `failed` reporting the
 * planner will drive its commit/interrupt loop with.
 */

import { expect, test } from "vitest";
import { Config } from "../../../server/src/config.ts";
import { applyCpcAction } from "../../../server/src/cpc_dev/applyCpcAction.ts";
import { runSkill, type SkillContext } from "../../../server/src/cpc_dev/skills.ts";
import { stepGame } from "../../../server/src/cpc_dev/stepGame.ts";
import { GameConfig, TeamMode } from "../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import { createGame } from "../gameTestHelpers.ts";

const ticksPerSecond = Config.gameTps;

function scene() {
    const game = createGame(TeamMode.Duo, "test_normal");
    const center = v2.create(game.map.width / 2, game.map.height / 2);
    const ours = game.playerBarn.addGroup(false);
    const me = game.playerBarn.addTestPlayer({ group: ours, pos: center });
    const mate = game.playerBarn.addTestPlayer({ group: ours, pos: v2.add(center, v2.create(20, 0)) });
    const foe = game.playerBarn.addTestPlayer({
        group: game.playerBarn.addGroup(false),
        pos: v2.add(center, v2.create(0, 40)),
    });
    stepGame(game, 3);
    const ctx: SkillContext = { game, players: [me, mate, foe], t: 0 };
    return { game, ctx, me, mate, foe, center };
}

/** Runs one skill for `seconds` of game time, advancing the context clock like the episode does. */
function drive(
    game: ReturnType<typeof createGame>,
    ctx: SkillContext,
    me: Parameters<typeof applyCpcAction>[0],
    seconds: number,
    step: () => ReturnType<typeof runSkill>,
): ReturnType<typeof runSkill> {
    let status = step();
    for (let tick = 0; tick < seconds * ticksPerSecond; tick++) {
        status = step();
        applyCpcAction(me, status.action);
        stepGame(game, 1);
        ctx.t = (tick + 1) / ticksPerSecond;
        if (status.done) break;
    }
    return status;
}

test("move_to walks to the point and reports done on arrival", () => {
    const { game, ctx, me, center } = scene();
    const target: Vec2 = v2.add(center, v2.create(0, 15));

    const first = runSkill("move_to", { pos: target }, ctx, me);
    expect(first.done).toBe(false);
    expect(v2.length(first.action.move!)).toBeGreaterThan(0);

    const status = drive(game, ctx, me, 4, () => runSkill("move_to", { pos: target }, ctx, me));
    expect(status.done).toBe(true);
    expect(v2.distance(me.pos, target)).toBeLessThanOrEqual(2);
});

test("move_to keeps facing `face` while it walks somewhere else", () => {
    const { ctx, me, center } = scene();
    const status = runSkill(
        "move_to",
        { pos: v2.add(center, v2.create(0, 15)), face: v2.create(1, 0) },
        ctx,
        me,
    );
    expect(status.action.aim).toEqual(v2.create(1, 0));
    expect(status.action.move!.y).toBeGreaterThan(0);
});

test("follow closes to the standoff distance and holds there", () => {
    const { game, ctx, me, mate } = scene();
    expect(v2.distance(me.pos, mate.pos)).toBeCloseTo(20, 1);

    // never completes by design, so drive it for a fixed time and look at the gap
    drive(game, ctx, me, 3, () => runSkill("follow", { target: mate, distance: 6 }, ctx, me));
    const gap = v2.distance(me.pos, mate.pos);
    expect(gap).toBeGreaterThan(1);
    expect(gap).toBeLessThan(10);
    expect(runSkill("follow", { target: mate, distance: 6 }, ctx, me).done).toBe(false);
});

test("follow fails once the teammate is dead", () => {
    const { ctx, me, mate } = scene();
    mate.kill({ damageType: GameConfig.DamageType.Airdrop, dir: v2.create(1, 0), source: undefined });
    const status = runSkill("follow", { target: mate, distance: 6 }, ctx, me);
    expect(status.done).toBe(true);
    expect(status.failed).toMatch(/dead/);
});

test("heal uses an item until HP is full, then reports done", () => {
    const { game, ctx, me } = scene();
    me.health = 50;
    me.invManager.set("bandage", 2);

    const first = runSkill("heal", {}, ctx, me);
    expect(first.done).toBe(false);
    expect(first.action.useItem).toBe("bandage");

    // bandage useTime is 3 s and heals 15
    drive(game, ctx, me, 4, () => runSkill("heal", {}, ctx, me));
    expect(me.health).toBe(65);
    expect(me.inventory["bandage"]).toBe(1);
});

test("heal fails when there is nothing to use", () => {
    const { ctx, me } = scene();
    me.health = 50;
    const status = runSkill("heal", {}, ctx, me);
    expect(status.done).toBe(true);
    expect(status.failed).toMatch(/no healing item/);
});

test("heal is done at full HP without consuming anything", () => {
    const { ctx, me } = scene();
    me.invManager.set("bandage", 1);
    const status = runSkill("heal", {}, ctx, me);
    expect(status.done).toBe(true);
    expect(status.failed).toBeUndefined();
    expect(status.action.useItem).toBeUndefined();
});

test("retreat opens the requested distance and then reports done", () => {
    const { game, ctx, me, foe } = scene();
    const start = v2.distance(me.pos, foe.pos);
    expect(start).toBeCloseTo(40, 1);

    const first = runSkill("retreat", { awayFrom: foe, distance: 55 }, ctx, me);
    expect(first.done).toBe(false);
    // backing off means moving away while still facing the threat
    expect(v2.length(first.action.move!)).toBeGreaterThan(0);
    expect(first.action.aim!.y).toBeGreaterThan(0);
    expect(first.action.move!.y).toBeLessThan(0);

    const status = drive(game, ctx, me, 4, () => runSkill("retreat", { awayFrom: foe, distance: 55 }, ctx, me));
    expect(status.done).toBe(true);
    expect(v2.distance(me.pos, foe.pos)).toBeGreaterThanOrEqual(55);
});

test("retreat with nothing to flee is done immediately", () => {
    const { ctx, me } = scene();
    expect(runSkill("retreat", {}, ctx, me).done).toBe(true);
});

test("loot walks to a pile, presses Interact in reach, and is done once nothing is wanted", () => {
    const { game, ctx, me, center } = scene();
    game.lootBarn.addLoot("ak47", v2.add(center, v2.create(6, 0)), 0, 1, { source: "map" });
    stepGame(game, 3);

    const status = drive(game, ctx, me, 4, () => runSkill("loot", {}, ctx, me));
    expect(me.weapons[GameConfig.WeaponSlot.Primary].type).toBe("ak47");
    // armed and stocked: the skill has nothing left to want
    expect(status.done).toBe(true);
    expect(runSkill("loot", {}, ctx, me).done).toBe(true);
});

test("loot for a specific type fails when none exists", () => {
    const { ctx, me } = scene();
    const status = runSkill("loot", { type: "4xscope" }, ctx, me);
    expect(status.done).toBe(true);
    expect(status.failed).toMatch(/no such loot/);
});

test("engage shoots a target in range and is done when it dies", () => {
    const { game, ctx, me, foe } = scene();
    me.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "ak47", 30);
    me.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    stepGame(game, ticksPerSecond);

    const status = drive(game, ctx, me, 8, () => runSkill("engage", { target: foe }, ctx, me));
    expect(foe.dead).toBe(true);
    expect(status.done).toBe(true);
});

test("revive brings a downed teammate up and reports done, or fails if it dies first", () => {
    const { game, ctx, me, mate } = scene();
    mate.damage({ amount: 999, damageType: GameConfig.DamageType.Airdrop, dir: v2.create(1, 0) });
    expect(mate.downed).toBe(true);

    const status = drive(
        game,
        ctx,
        me,
        GameConfig.player.reviveDuration + 4,
        () => runSkill("revive", { target: mate }, ctx, me),
    );
    expect(mate.downed).toBe(false);
    expect(status.done).toBe(true);

    mate.kill({ damageType: GameConfig.DamageType.Airdrop, dir: v2.create(1, 0), source: undefined });
    const failed = runSkill("revive", { target: mate }, ctx, me);
    expect(failed.done).toBe(true);
    expect(failed.failed).toMatch(/died/);
});

test("a downed or dead agent runs no skill", () => {
    const { ctx, me, mate } = scene();
    me.damage({ amount: 999, damageType: GameConfig.DamageType.Airdrop, dir: v2.create(1, 0) });
    expect(me.downed).toBe(true);
    const status = runSkill("follow", { target: mate }, ctx, me);
    expect(status).toEqual({ action: {}, done: true, failed: "downed" });
});

test("pathJitterDeg bends movement without changing the destination", () => {
    const { ctx, me, center } = scene();
    const target = v2.add(center, v2.create(0, 15));
    const straight = runSkill("move_to", { pos: target }, ctx, me).action.move!;

    // a fixed uniform source makes the jitter deterministic for the test
    let calls = 0;
    const jittered = runSkill(
        "move_to",
        { pos: target },
        { ...ctx, options: { pathJitterDeg: 20 }, rand: () => (calls++ % 2 === 0 ? 0.3 : 0.7) },
        me,
    ).action.move!;

    expect(v2.length(jittered)).toBeCloseTo(v2.length(straight), 6);
    const angle = Math.abs(Math.atan2(jittered.y, jittered.x) - Math.atan2(straight.y, straight.x));
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeLessThan(Math.PI / 2);
});

// A playtest finding: the CPC visibly shook. Skills re-run 100 times a second, and the noise was
// redrawn on every call, so the aim and the path wobbled at tick rate instead of decision rate.
test("held noise wobbles at decision rate, not tick rate", () => {
    const { ctx, me, foe } = scene();
    me.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "ak47", 30);
    me.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);

    const options = { aimNoiseDeg: 10, pathJitterDeg: 10, noiseHoldSeconds: 0.1 };
    const held: SkillContext = { ...ctx, options, rand: Math.random, noise: new Map() };
    const perCall: SkillContext = { ...ctx, options, rand: Math.random };

    const angles = (c: SkillContext) => {
        const out: number[] = [];
        for (let tick = 0; tick < 30; tick++) {
            c.t = tick / ticksPerSecond; // 0.30 s = three decision windows
            const aim = runSkill("engage", { target: foe }, c, me).action.aim!;
            out.push(Math.atan2(aim.y, aim.x));
        }
        return out;
    };
    const distinct = (xs: number[]) => new Set(xs.map((x) => x.toFixed(9))).size;

    // with a held sample the aim changes once per window, not once per tick
    expect(distinct(angles(held))).toBeLessThanOrEqual(4);
    // without one it is a new draw every tick, which is what the tremor was
    expect(distinct(angles(perCall))).toBeGreaterThan(20);
});
