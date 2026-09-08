import { expect, test } from "vitest";
import { createScenarioGame } from "../../../server/src/cpc_dev/createScenarioGame.ts";
import { buildDuo2v2FieldScenario } from "../../../server/src/cpc_dev/scenarios/duo2v2Field.ts";
import { v2 } from "../../../shared/utils/v2.ts";

function buildField(seed: string) {
    const { game, mapSize } = createScenarioGame({ seed });
    const scenario = buildDuo2v2FieldScenario(game, { seed, mapSize });
    return { game, scenario };
}

test("field loot layout is deterministic per seed, mirrored, and inside the region", () => {
    const { scenario } = buildField("cpc-field-seed-0");
    const sameSeed = buildField("cpc-field-seed-0").scenario;
    const otherSeed = buildField("cpc-field-seed-1").scenario;

    expect(sameSeed.loot).toEqual(scenario.loot);
    expect(otherSeed.loot.map((item) => item.pos)).not.toEqual(scenario.loot.map((item) => item.pos));

    // 7 team kit items for each duo + 3 center kit items
    expect(scenario.loot).toHaveLength(17);

    const region = scenario.scenarioRegion;
    for (const item of scenario.loot) {
        expect(item.pos.x).toBeGreaterThanOrEqual(region.x);
        expect(item.pos.x).toBeLessThanOrEqual(region.x + region.width);
        expect(item.pos.y).toBeGreaterThanOrEqual(region.y);
        expect(item.pos.y).toBeLessThanOrEqual(region.y + region.height);
    }

    // team kits are mirrored around the region center, so neither duo is favored
    const centerX = region.x + region.width / 2;
    for (let i = 0; i < 14; i += 2) {
        const left = scenario.loot[i];
        const right = scenario.loot[i + 1];
        expect(left.type).toBe(right.type);
        expect(left.pos.x + right.pos.x).toBeCloseTo(2 * centerX, 6);
        expect(left.pos.y).toBeCloseTo(right.pos.y, 6);
    }
});

test("field loot is spawned into the game", () => {
    const { game, scenario } = buildField("cpc-field-seed-0");

    for (const item of scenario.loot) {
        const spawned = game.lootBarn.loots.find(
            (loot) => loot.type === item.type && v2.distance(loot.pos, item.pos) < 1e-6,
        );
        expect(spawned, `${item.type} at ${item.pos.x},${item.pos.y}`).toBeDefined();
    }
});
