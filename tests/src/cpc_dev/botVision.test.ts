/**
 * A bot may only act on what it has seen.
 *
 * The point of these is the pursuit, not the geometry: `canSee` delegates the blocking test to
 * `firstBlocker`, which `lineOfSight.test.ts` already pins against the engine's bullet rule. What is
 * new here is that losing sight ends a chase, which is what makes withdrawing possible at all.
 */

import { expect, test } from "vitest";
import {
    canSee,
    defaultPursuitMemory,
    lastKnown,
    rememberSightings,
    type SightMemory,
} from "../../../server/src/cpc_dev/botVision.ts";

/** A game whose grid holds nothing, so only range decides what is visible. */
const emptyGame = { grid: { intersectLineSegment: () => [] } } as never;

let nextId = 1;
function player(x: number, y: number) {
    return { __id: nextId++, pos: { x, y }, layer: 0 } as never;
}

test("sight is limited by range", () => {
    const me = player(0, 0);
    expect(canSee(emptyGame, me, player(10, 0), 60)).toBe(true);
    expect(canSee(emptyGame, me, player(59, 0), 60)).toBe(true);
    expect(canSee(emptyGame, me, player(61, 0), 60)).toBe(false);
});

test("what is seen is remembered where it was, not where it went", () => {
    const memory: SightMemory = new Map();
    const me = player(0, 0);
    const enemy = player(10, 0);

    expect(rememberSightings(memory, emptyGame, me, [enemy], 1.0)).toEqual([enemy]);
    // the enemy walks out of sight; the bot still knows the spot it last stood on
    (enemy as { pos: { x: number; y: number } }).pos = { x: 200, y: 0 };
    expect(rememberSightings(memory, emptyGame, me, [enemy], 1.5)).toEqual([]);

    const trail = lastKnown(memory, me, [enemy], 1.5);
    expect(trail?.pos).toEqual({ x: 10, y: 0 });
});

test("the trail goes cold", () => {
    const memory: SightMemory = new Map();
    const me = player(0, 0);
    const enemy = player(10, 0);
    rememberSightings(memory, emptyGame, me, [enemy], 1.0);

    expect(lastKnown(memory, me, [enemy], 1.0 + defaultPursuitMemory - 0.1)).toBeDefined();
    expect(lastKnown(memory, me, [enemy], 1.0 + defaultPursuitMemory + 0.1)).toBeUndefined();
});

test("a bot with no memory of an enemy has no trail to follow", () => {
    const memory: SightMemory = new Map();
    expect(lastKnown(memory, player(0, 0), [player(10, 0)], 1.0)).toBeUndefined();
});

test("the freshest sighting wins", () => {
    const memory: SightMemory = new Map();
    const me = player(0, 0);
    const older = player(10, 0);
    const newer = player(20, 0);
    rememberSightings(memory, emptyGame, me, [older], 1.0);
    rememberSightings(memory, emptyGame, me, [newer], 2.0);
    expect(lastKnown(memory, me, [older, newer], 2.5)?.pos).toEqual({ x: 20, y: 0 });
});

test("memory is per bot", () => {
    const memory: SightMemory = new Map();
    const watcher = player(0, 0);
    const blind = player(0, 0);
    const enemy = player(10, 0);
    rememberSightings(memory, emptyGame, watcher, [enemy], 1.0);
    expect(lastKnown(memory, watcher, [enemy], 1.2)).toBeDefined();
    expect(lastKnown(memory, blind, [enemy], 1.2)).toBeUndefined();
});

// --- the same thing, through the real engine ---------------------------------------------------
// The tests above run on a stub grid, so they say nothing about whether a real wall ends a real
// pursuit. These drive a real episode. They avoid asserting "the bot sometimes loses track", which
// would be flaky -- the engine rolls headshots and spread with bare Math.random (see the README's
// "Reproducibility" section) -- and instead pin the mechanism: vision gates engagement at all.

import { GameConfig } from "../../../shared/gameConfig.ts";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";
import { selectSkill } from "../../../server/src/cpc_dev/scriptedPolicy.ts";
import type { AgentObservation } from "../../../server/src/cpc_dev/observation.ts";

// 20 s, not 8: the duos start 64 u apart and a bot has to cross that before anything it does
// is observable at all
function runEpisode(scriptedOptions: Record<string, unknown>, seconds = 20) {
    const episode = new CpcEpisode({
        seed: "cpc-bot-vision",
        scripted: "chaser",
        loadout: "armed",
        cover: "default",
        controlled: ["team-a-0"], // driven by us, and we send nothing: it stands still
        scriptedOptions: scriptedOptions as never,
    });
    let msg = episode.reset();
    const enemyDist = (m: typeof msg) =>
        Math.min(
            ...(m.obs["team-a-0"]?.players ?? [])
                .filter((p) => p.id.startsWith("team-b"))
                .map((p) => p.dist),
            Number.POSITIVE_INFINITY,
        );
    let closest = enemyDist(msg);
    while (!msg.done && msg.t < seconds) {
        msg = episode.step({}, 10);
        closest = Math.min(closest, enemyDist(msg));
    }
    const metrics = msg.info.metrics ?? {};
    episode.close();
    let dealtByB = 0;
    for (const [id, m] of Object.entries(metrics)) {
        if (id.startsWith("team-b")) dealtByB += m.damage_dealt;
    }
    return { dealtByB, closest };
}

test("a bot that cannot see anyone never opens fire", () => {
    // sightRange 1 is 'blind': nothing is ever visible, so no enemy is ever selected
    expect(runEpisode({ vision: "line_of_sight", sightRange: 1 }).dealtByB).toBe(0);
    // the same seed with the old omniscient behaviour: it finds and shoots the agent through anything
    expect(runEpisode({ vision: "omniscient" }).dealtByB).toBeGreaterThan(0);
});

test("with nothing seen and nothing to loot, a bot heads for the middle", () => {
    // The branch this covers cannot be reached through a real episode: `wantsLoot` outranks it, and
    // the loot skill stops moving once it is standing on a pile it cannot use, so a blind bot in a
    // real scenario freezes inside `loot` long before the search would run. A gun with ammo makes
    // `wantedLoot` return nothing, which is what lets the call fall through to the search.
    const centre = { x: 132, y: 132 };
    const game = {
        grid: { intersectLineSegment: () => [] },
        gas: { currentPos: centre },
        lootBarn: { loots: [] },
    };
    const armed = (id: number, groupId: number, x: number) => ({
        __id: id,
        groupId,
        pos: { x, y: 0 },
        layer: 0,
        dead: false,
        downed: false,
        inventory: { "9mm": 60 },
        curWeapIdx: GameConfig.WeaponSlot.Primary,
        weapons: [
            { type: "m9", ammo: 15 },
            { type: "", ammo: 0 },
            { type: "", ammo: 0 },
            { type: "", ammo: 0 },
        ],
    });
    const me = armed(1, 1, 0);
    const enemy = armed(2, 2, 500); // far outside any sight range
    const ctx = {
        game,
        players: [me, enemy],
        t: 1,
        sightMemory: new Map(),
        options: { vision: "line_of_sight" as const },
    };

    const choice = selectSkill(ctx as never, me as never, Number.POSITIVE_INFINITY);
    expect(choice?.skill).toBe("move_to");
    expect((choice?.params as { pos: { x: number; y: number } }).pos).toEqual(centre);

    // and with no gas circle to head for there is simply nothing to do, rather than a crash
    const noGas = { ...ctx, game: { ...game, gas: undefined } };
    expect(selectSkill(noGas as never, me as never, Number.POSITIVE_INFINITY)).toBeUndefined();
});
