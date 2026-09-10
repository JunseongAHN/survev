/**
 * M9: what a scenario seed does and does not fix.
 *
 * The engine is not ours and is not fully deterministic; the phase-0 requirement is the boundary,
 * not full determinism. These tests pin it from both sides so a future change cannot quietly move
 * it: the seed fixes the map and the whole scenario layout, and it does *not* fix combat, because
 * bullet spread and headshot rolls go through unseeded `Math.random`. The list of sources and what
 * each one perturbs is in `server/src/cpc_dev/README.md`.
 */

import { expect, test } from "vitest";
import { applyCpcAction } from "../../../server/src/cpc_dev/applyCpcAction.ts";
import { createScenarioGame, normalizeSeed } from "../../../server/src/cpc_dev/createScenarioGame.ts";
import { buildDuo2v2FieldScenario, type FieldLayout } from "../../../server/src/cpc_dev/scenarios/duo2v2Field.ts";
import { stepGame } from "../../../server/src/cpc_dev/stepGame.ts";
import { Config } from "../../../server/src/config.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import { v2 } from "../../../shared/utils/v2.ts";

const ticksPerSecond = Config.gameTps;

interface Layout {
    mapSeed: number | undefined;
    spawns: string[];
    loot: string[];
}

function build(seed: string, layout: FieldLayout = "fixed"): { layout: Layout; close: () => void } {
    const { game, seed: applied, mapSize } = createScenarioGame({ seed });
    const scenario = buildDuo2v2FieldScenario(game, { seed: applied, mapSize, layout });
    const round = (n: number) => n.toFixed(4);
    return {
        layout: {
            mapSeed: game.map.seed,
            spawns: scenario.players.map((p) => `${p.agentId}@${round(p.player.pos.x)},${round(p.player.pos.y)}`),
            loot: scenario.loot
                .map((l) => `${l.type}x${l.count}@${round(l.pos.x)},${round(l.pos.y)}`)
                .sort(),
        },
        close: () => game.stop(),
    };
}

test("the same seed fixes the map seed, the spawn positions and the loot layout", () => {
    for (const layout of ["fixed", "random"] as FieldLayout[]) {
        const a = build("cpc-determinism", layout);
        const b = build("cpc-determinism", layout);
        expect(a.layout.mapSeed).toBe(normalizeSeed("cpc-determinism"));
        expect(b.layout).toEqual(a.layout);
        expect(a.layout.loot.length).toBeGreaterThan(0);
        a.close();
        b.close();
    }
});

test("a different seed moves the loot, and with layout random the spawns too", () => {
    const a = build("cpc-determinism", "random");
    const b = build("cpc-determinism-other", "random");
    expect(b.layout.mapSeed).not.toBe(a.layout.mapSeed);
    expect(b.layout.loot).not.toEqual(a.layout.loot);
    expect(b.layout.spawns).not.toEqual(a.layout.spawns);
    a.close();
    b.close();

    // the fixed layout keeps the spawns by definition, but the loot still moves with the seed
    const c = build("cpc-determinism", "fixed");
    const d = build("cpc-determinism-other", "fixed");
    expect(d.layout.spawns).toEqual(c.layout.spawns);
    expect(d.layout.loot).not.toEqual(c.layout.loot);
    c.close();
    d.close();
});

/**
 * The seed does not reach combat: `WeaponManager.fireWeapon` perturbs each bullet by
 * `util.random(-0.5, 0.5) * spread` (unseeded), so bullet directions are continuous random values
 * and two runs of the same scripted exchange diverge. Comparing directions rather than damage
 * keeps the test exact — a continuous value cannot coincide across runs.
 */
function bulletDirections(seed: string, shots: number): string[] {
    const { game, seed: applied, mapSize } = createScenarioGame({ seed });
    const scenario = buildDuo2v2FieldScenario(game, { seed: applied, mapSize, layout: "fixed" });
    const shooter = scenario.players[0].player;
    shooter.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "ak47", 30);
    shooter.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    stepGame(game, ticksPerSecond);

    // Bullets are pooled and carry no id, so shots are counted by their direction: the spread is a
    // continuous perturbation, so two distinct shots practically never share a direction.
    const seen = new Set<string>();
    applyCpcAction(shooter, { aim: v2.create(1, 0), fire: { hold: true } });
    for (let tick = 0; tick < 3 * ticksPerSecond && seen.size < shots; tick++) {
        stepGame(game, 1);
        for (const bullet of game.bulletBarn.bullets) {
            if (!bullet.active) continue;
            seen.add(`${bullet.dir.x.toFixed(9)},${bullet.dir.y.toFixed(9)}`);
        }
    }
    game.stop();
    return [...seen].sort();
}

test("the seed does not fix combat: bullet spread varies between runs on the same seed", () => {
    const first = bulletDirections("cpc-determinism", 10);
    const second = bulletDirections("cpc-determinism", 10);
    expect(first.length).toBeGreaterThanOrEqual(5);
    expect(second.length).toBe(first.length);
    expect(second).not.toEqual(first);
    // and the spread is real: an ak47 fired straight east does not send every bullet at exactly (1, 0)
    expect(new Set(first).size).toBeGreaterThan(1);
});
