import { expect, test } from "vitest";
import { hearShot, shotsHeardRadius } from "../../../server/src/cpc_dev/observation.ts";
import { v2 } from "../../../shared/utils/v2.ts";

const listener = v2.create(100, 100);

/** offsets in world space, where y grows upward — `up` on screen is +y here */
const directions = [
    { offset: v2.create(10, 0), dir: "E" },
    { offset: v2.create(10, 10), dir: "NE" },
    { offset: v2.create(0, 10), dir: "N" },
    { offset: v2.create(-10, 10), dir: "NW" },
    { offset: v2.create(-10, 0), dir: "W" },
    { offset: v2.create(-10, -10), dir: "SW" },
    { offset: v2.create(0, -10), dir: "S" },
    { offset: v2.create(10, -10), dir: "SE" },
] as const;

test("a shot is bucketed to one of the 8 world-space compass points", () => {
    for (const { offset, dir } of directions) {
        expect(hearShot(listener, v2.add(listener, offset))?.dir).toBe(dir);
    }
});

test("distance buckets split the audible radius into thirds", () => {
    const at = (dist: number) => hearShot(listener, v2.add(listener, v2.create(dist, 0)))?.range;
    expect(at(1)).toBe("near");
    expect(at(shotsHeardRadius / 3 - 0.1)).toBe("near");
    expect(at(shotsHeardRadius / 3 + 0.1)).toBe("mid");
    expect(at((2 * shotsHeardRadius) / 3 - 0.1)).toBe("mid");
    expect(at((2 * shotsHeardRadius) / 3 + 0.1)).toBe("far");
    expect(at(shotsHeardRadius - 0.1)).toBe("far");
});

// S4: a listener outside the audible radius is told nothing at all
test("shots outside the audible radius are not heard", () => {
    expect(hearShot(listener, v2.add(listener, v2.create(shotsHeardRadius, 0)))).not.toBeNull();
    expect(hearShot(listener, v2.add(listener, v2.create(shotsHeardRadius + 0.1, 0)))).toBeNull();
    expect(hearShot(listener, v2.add(listener, v2.create(shotsHeardRadius + 100, 0)))).toBeNull();
    // the radius is a circle, not a square: the diagonal corner of the bounding box is out of earshot
    const diagonal = shotsHeardRadius / Math.SQRT2 - 0.1;
    expect(hearShot(listener, v2.add(listener, v2.create(diagonal, diagonal)))).not.toBeNull();
    expect(hearShot(listener, v2.add(listener, v2.create(shotsHeardRadius, shotsHeardRadius)))).toBeNull();
});
