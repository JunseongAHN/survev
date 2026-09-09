import { expect, test } from "vitest";
import { createScenarioGame } from "../../../server/src/cpc_dev/createScenarioGame.ts";
import {
    buildDuo2v2FieldScenario,
    defaultTeamOutfits,
    type FieldLayout,
    mirrorAcrossCenter,
} from "../../../server/src/cpc_dev/scenarios/duo2v2Field.ts";
import { v2 } from "../../../shared/utils/v2.ts";

function buildField(seed: string, layout: FieldLayout = "fixed") {
    const { game, mapSize } = createScenarioGame({ seed });
    const scenario = buildDuo2v2FieldScenario(game, { seed, mapSize, layout });
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

test("fixed layout keeps the base spawns and reports them", () => {
    const { scenario } = buildField("cpc-field-seed-0");
    const byId = Object.fromEntries(scenario.players.map((p) => [p.agentId, p.player.pos]));
    expect(byId["team-a-0"]).toEqual(v2.create(100, 125.6));
    expect(byId["team-a-1"]).toEqual(v2.create(100, 138.4));
    expect(byId["team-b-0"]).toEqual(v2.create(164, 125.6));
    expect(byId["team-b-1"]).toEqual(v2.create(164, 138.4));
    for (const p of scenario.players) {
        expect(v2.distance(scenario.spawnLayout.spawns[p.agentId], p.player.pos)).toBeLessThan(1e-6);
    }
});

test("random layout is seeded, mirror-symmetric, inside the region and faces the center", () => {
    const { scenario } = buildField("cpc-field-seed-0", "random");
    const same = buildField("cpc-field-seed-0", "random").scenario;
    const other = buildField("cpc-field-seed-1", "random").scenario;
    const layout = scenario.spawnLayout;

    expect(same.spawnLayout).toEqual(layout);
    expect(same.loot).toEqual(scenario.loot);
    expect(other.spawnLayout.angle).not.toBeCloseTo(layout.angle, 3);
    expect(layout.radius).toBeGreaterThanOrEqual(24);
    expect(layout.radius).toBeLessThanOrEqual(44);

    const center = layout.center;
    const region = scenario.scenarioRegion;
    expect(center).toEqual(v2.create(region.x + region.width / 2, region.y + region.height / 2));
    const pos = Object.fromEntries(scenario.players.map((p) => [p.agentId, p.player.pos]));
    // spawns are where the layout says, team-b is team-a mirrored across the center, duo spacing is 12.8 u
    for (const p of scenario.players) expect(v2.distance(layout.spawns[p.agentId], p.player.pos)).toBeLessThan(1e-6);
    expect(v2.distance(mirrorAcrossCenter(layout, pos["team-a-0"]), pos["team-b-0"])).toBeLessThan(1e-6);
    expect(v2.distance(mirrorAcrossCenter(layout, pos["team-a-1"]), pos["team-b-1"])).toBeLessThan(1e-6);
    expect(v2.distance(pos["team-a-0"], pos["team-a-1"])).toBeCloseTo(12.8, 6);
    const midA = v2.mul(v2.add(pos["team-a-0"], pos["team-a-1"]), 0.5);
    expect(v2.distance(midA, center)).toBeCloseTo(layout.radius, 6);
    expect(v2.distance(midA, center)).not.toBeCloseTo(32, 1); // this seed does not land on the fixed distance
    for (const p of scenario.players) {
        const toCenter = v2.normalizeSafe(v2.sub(center, p.player.pos));
        expect(v2.dot(p.player.dir, toCenter)).toBeGreaterThan(0.9);
        expect(p.player.pos.x).toBeGreaterThan(region.x);
        expect(p.player.pos.x).toBeLessThan(region.x + region.width);
        expect(p.player.pos.y).toBeGreaterThan(region.y);
        expect(p.player.pos.y).toBeLessThan(region.y + region.height);
    }

    // team kits: 10 u (+- scatter) from each duo toward the center, mirrored like the spawns; center kit unchanged
    expect(scenario.loot).toHaveLength(17);
    for (let i = 0; i < 14; i += 2) {
        const a = scenario.loot[i];
        const b = scenario.loot[i + 1];
        expect(a.type).toBe(b.type);
        expect(v2.distance(mirrorAcrossCenter(layout, a.pos), b.pos)).toBeLessThan(1e-6);
        expect(v2.distance(a.pos, midA)).toBeLessThan(10 + 4 * Math.SQRT2 + 1e-6);
        expect(v2.distance(a.pos, center)).toBeLessThan(v2.distance(midA, center));
    }
    for (const item of scenario.loot.slice(14)) expect(v2.distance(item.pos, center)).toBeLessThan(4 * Math.SQRT2 + 1e-6);
});

test("random layouts differ across seeds in angle and distance", () => {
    const angles = new Set<number>();
    const radii = new Set<number>();
    for (let i = 0; i < 8; i++) {
        const layout = buildField(`cpc-field-seed-${i}`, "random").scenario.spawnLayout;
        angles.add(Math.round(layout.angle * 100));
        radii.add(Math.round(layout.radius * 10));
    }
    expect(angles.size).toBeGreaterThanOrEqual(6);
    expect(radii.size).toBeGreaterThanOrEqual(6);
});

test("teams wear distinct body skins by default (blue vs red), optional", () => {
    const { scenario } = buildField("cpc-field-seed-0");
    for (const p of scenario.players) expect(p.player.outfit).toBe(defaultTeamOutfits[p.teamId]);
    expect(defaultTeamOutfits["team-a"]).not.toBe(defaultTeamOutfits["team-b"]);

    const { game, mapSize } = createScenarioGame({ seed: "cpc-field-seed-0" });
    const plain = buildDuo2v2FieldScenario(game, { seed: "cpc-field-seed-0", mapSize, teamOutfits: false });
    for (const p of plain.players) expect(p.player.outfit).toBe("outfitBase");
});
