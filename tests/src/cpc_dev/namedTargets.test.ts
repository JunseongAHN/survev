/**
 * Named places: `c1` is the nearest thing that stops a bullet, `b1` the nearest building, and a name
 * the agent cannot see resolves to nothing. The state block, the grammar and the resolver all read
 * these, so what the planner may say and what the server will do come from one list.
 */

import { beforeEach, expect, test } from "vitest";
import { CpcEpisode } from "../../../server/src/cpc_dev/episode.ts";
import {
    buildingTargets,
    coverTargets,
    maxCover,
    namedTargetPos,
    shortLabel,
} from "../../../server/src/cpc_dev/namedTargets.ts";
import type { AgentObservation } from "../../../server/src/cpc_dev/observation.ts";
import { namedPosition } from "../../../server/src/cpc_dev/skillWire.ts";

let withCover: AgentObservation;
let bare: AgentObservation;

beforeEach(() => {
    for (const cover of ["default", "none"] as const) {
        const episode = new CpcEpisode({
            seed: "cpc-named-targets",
            scripted: "idle",
            controlled: ["team-a-0"],
            cover,
        });
        const obs = episode.reset().obs["team-a-0"];
        episode.close();
        if (cover === "default") withCover = obs;
        else bare = obs;
    }
});

const clone = (obs: AgentObservation) => structuredClone(obs);

test("the open field names no cover: there is nothing to hide behind", () => {
    expect(bare.obstacles).toHaveLength(0);
    expect(coverTargets(bare)).toEqual([]);
    expect(buildingTargets(bare)).toEqual([]);
});

test("cover is named nearest first and resolves to where it stands", () => {
    const cover = coverTargets(withCover);
    expect(cover.length).toBeGreaterThan(0);
    expect(cover.map((c) => c.name)).toEqual(cover.map((_, i) => `c${i + 1}`));
    expect(cover.map((c) => c.dist)).toEqual([...cover.map((c) => c.dist)].sort((a, b) => a - b));
    expect(namedTargetPos(withCover, "cover:c1")).toEqual(cover[0].pos);
    expect(namedPosition(withCover, "cover:c1")).toEqual(cover[0].pos);
});

test("only what stops a bullet is cover: a bush is not, and neither is anything too low", () => {
    const obs = clone(bare);
    obs.obstacles.push(
        {
            id: 1,
            type: "bush_01",
            pos: { x: 0, y: 0 },
            dist: 5,
            collidable: false,
            height: 10,
            scale: 1,
            blocks_los: false,
            cover_score: 0,
        },
        {
            id: 2,
            type: "table_01",
            pos: { x: 0, y: 0 },
            dist: 6,
            collidable: false,
            height: 0.5,
            scale: 1,
            blocks_los: false,
            cover_score: 0,
        },
        {
            id: 3,
            type: "flat_thing",
            pos: { x: 0, y: 0 },
            dist: 7,
            collidable: true,
            height: 0.1,
            scale: 1,
            blocks_los: false,
            cover_score: 0,
        },
        {
            id: 4,
            type: "stone_01",
            pos: { x: 3, y: 4 },
            dist: 8,
            collidable: true,
            height: 0.5,
            scale: 1,
            blocks_los: false,
            cover_score: 0,
        },
    );
    expect(coverTargets(obs).map((c) => c.label)).toEqual(["stone"]);
});

test("the list is capped, so a crowded corner cannot eat the block budget", () => {
    const obs = clone(bare);
    for (let i = 0; i < maxCover + 4; i++) {
        obs.obstacles.push({
            id: i,
            type: "crate_02",
            pos: { x: i, y: 0 },
            dist: i + 1,
            collidable: true,
            height: 0.5,
            scale: 1,
            blocks_los: false,
            cover_score: 0,
        });
    }
    expect(coverTargets(obs)).toHaveLength(maxCover);
});

test("a name that is not in view resolves to nothing, and move_to refuses it", () => {
    expect(namedTargetPos(withCover, "cover:c99")).toBeUndefined();
    expect(() => namedPosition(withCover, "cover:c99")).toThrow(/not in view/);
    expect(() => namedPosition(bare, "building:b1")).toThrow(/not in view/);
});

test("labels are the short word a person would use", () => {
    expect(shortLabel("concrete_wall_ext_5")).toBe("wall");
    expect(shortLabel("stone_01")).toBe("stone");
    expect(shortLabel("shack_wall_top")).toBe("wall");
    expect(shortLabel("shack_01")).toBe("shack");
});
