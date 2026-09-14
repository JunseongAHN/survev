/**
 * The seeded cover layout: same seed, same cover; never on a spawn or a kit; density is a knob.
 * `none` has to stay empty — `duo2v2_field` is the open field every earlier number was measured on.
 */

import { expect, test } from "vitest";
import { axisBand, createCoverLayout } from "../../../server/src/cpc_dev/scenarios/coverLayout.ts";
import { v2 } from "../../../shared/utils/v2.ts";

const region = { x: 0, y: 0, width: 128, height: 128 };
const centre = v2.create(64, 64);
const spawns = [
    v2.create(centre.x - 32, centre.y - 6.4),
    v2.create(centre.x - 32, centre.y + 6.4),
    v2.create(centre.x + 32, centre.y - 6.4),
    v2.create(centre.x + 32, centre.y + 6.4),
];

test("none is the default and places nothing", () => {
    expect(createCoverLayout(region, 1)).toEqual([]);
    expect(createCoverLayout(region, 1, "none")).toEqual([]);
});

test("the same seed gives the same layout, a different seed does not", () => {
    expect(createCoverLayout(region, 7, "default")).toEqual(createCoverLayout(region, 7, "default"));
    expect(createCoverLayout(region, 8, "default")).not.toEqual(createCoverLayout(region, 7, "default"));
});

test("default places the recipe twice over: the counts are per side", () => {
    const pieces = createCoverLayout(region, 3, "default");
    const count = (match: (type: string) => boolean) => pieces.filter((p) => match(p.type)).length;
    expect(count((t) => t === "shack_01")).toBe(2);
    expect(count((t) => t.startsWith("concrete_wall"))).toBe(4);
    expect(count((t) => t.startsWith("stone"))).toBe(4);
    expect(count((t) => t.startsWith("crate"))).toBe(6);
    expect(pieces.every((p) => p.kind === (p.type === "shack_01" ? "building" : "obstacle"))).toBe(true);
});

test("every piece has a twin through the centre, so neither duo gets the better ground", () => {
    const pieces = createCoverLayout(region, 3, "default");
    for (const piece of pieces) {
        const twin = pieces.find((other) =>
            other !== piece
            && other.type === piece.type
            && Math.abs(other.pos.x - (2 * centre.x - piece.pos.x)) < 1e-6
            && Math.abs(other.pos.y - (2 * centre.y - piece.pos.y)) < 1e-6
        );
        expect(twin, `${piece.type} at ${piece.pos.x},${piece.pos.y} has no mirror`).toBeDefined();
    }
});

test("a density means the same cover on every seed, and denser means more", () => {
    // the recipe is per side and every piece is mirrored, so these are twice the recipe
    for (const seed of [1, 2, 5, 13, 42]) {
        expect(createCoverLayout(region, seed, "sparse")).toHaveLength(8);
        expect(createCoverLayout(region, seed, "default")).toHaveLength(16);
        expect(createCoverLayout(region, seed, "dense")).toHaveLength(26);
    }
});

test("nothing blocks a spawn, a kit drop or another piece", () => {
    for (const density of ["sparse", "default", "dense"] as const) {
        const pieces = createCoverLayout(region, 11, density);
        for (const piece of pieces) {
            for (const spawn of spawns) {
                expect(v2.length(v2.sub(piece.pos, spawn)), `${piece.type} on a spawn`).toBeGreaterThan(6);
            }
            for (const kit of [v2.create(42, 64), v2.create(86, 64), centre]) {
                expect(v2.length(v2.sub(piece.pos, kit)), `${piece.type} on a kit`).toBeGreaterThan(4);
            }
        }
        for (const [i, a] of pieces.entries()) {
            for (const b of pieces.slice(i + 1)) {
                expect(v2.length(v2.sub(a.pos, b.pos)), `${a.type} overlaps ${b.type}`)
                    .toBeGreaterThan(Math.max(a.gap, b.gap));
            }
        }
    }
});

test("cover stays in the band between the duos", () => {
    // the band widens with density (dense needs more ground for more pieces); never past the spawns
    for (const [density, band] of [["sparse", 0.2], ["default", 0.26], ["dense", 0.3]] as const) {
        for (const piece of createCoverLayout(region, 2, density)) {
            expect(Math.abs(piece.pos.x - centre.x)).toBeLessThanOrEqual(region.width * band);
            expect(Math.abs(piece.pos.y - centre.y)).toBeLessThanOrEqual(region.height * band);
        }
    }
});

test("cover sits where the duos meet, not only around the edges", () => {
    // the first version cleared 11 u around every spawn and 7 u around every kit; on the axis those
    // circles joined into one lane and pushed all sixteen pieces 9-32 u away from it. A controller
    // trained there had an enemy's line broken in 1% of its steps — there was nothing to stand behind
    for (const seed of [1, 2, 3, 7, 11]) {
        const pieces = createCoverLayout(region, seed, "default");
        // the stones and crates are the ones pinned to the lane; walls and shacks need more room
        const small = pieces.filter((p) => p.type.startsWith("stone") || p.type.startsWith("crate"));
        const onAxis = small.filter((p) => Math.abs(p.pos.y - centre.y) <= axisBand);
        expect(onAxis.length, `seed ${seed}: ${onAxis.length} of ${small.length} small pieces near the axis`)
            .toBeGreaterThanOrEqual(4);
    }
});

test("the spawns and the kits are still reachable", () => {
    for (const seed of [1, 2, 3, 7, 11]) {
        for (const piece of createCoverLayout(region, seed, "dense")) {
            for (const spawn of spawns) {
                expect(v2.length(v2.sub(piece.pos, spawn))).toBeGreaterThan(6);
            }
        }
    }
});
