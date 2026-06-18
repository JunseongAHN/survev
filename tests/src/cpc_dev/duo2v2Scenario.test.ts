import { expect, test } from "vitest";
import { snapshotToHtml, snapshotToJson } from "../../../server/src/cpc_dev/dumpSnapshot.ts";
import { runDuo2v2SnapshotScenario } from "../../../server/src/cpc_dev/scenarioRunner.ts";

function expectInsideScenarioRegion(position: { x: number; y: number }, region: {
    x: number;
    y: number;
    width: number;
    height: number;
}) {
    expect(position.x).toBeGreaterThanOrEqual(region.x);
    expect(position.x).toBeLessThanOrEqual(region.x + region.width);
    expect(position.y).toBeGreaterThanOrEqual(region.y);
    expect(position.y).toBeLessThanOrEqual(region.y + region.height);
}

test("runs a local duo 2v2 scenario and extracts a snapshot", () => {
    const seed = "cpc-pr-s1";
    const mapSize = 128;
    const oneStepResult = runDuo2v2SnapshotScenario({ steps: 1, seed, mapSize });
    expect(oneStepResult.snapshot.step).toBe(1);

    const initialA = runDuo2v2SnapshotScenario({ steps: 0, seed, mapSize }).snapshot;
    const initialB = runDuo2v2SnapshotScenario({ steps: 0, seed, mapSize }).snapshot;
    expect(initialB.agent_ids.map((agentId) => initialB.agents[agentId].position)).toEqual(
        initialA.agent_ids.map((agentId) => initialA.agents[agentId].position),
    );

    const { snapshot } = runDuo2v2SnapshotScenario({ steps: 10, seed, mapSize });

    expect(snapshot.agent_ids).toHaveLength(4);
    expect(Object.keys(snapshot.agents)).toEqual(snapshot.agent_ids);
    expect(snapshot.mode).toBe("duo");
    expect(snapshot.team_ids).toHaveLength(2);
    expect(Object.values(snapshot.agent_team_map).every((teamId) => snapshot.team_ids.includes(teamId))).toBe(true);

    const teamSizes = snapshot.team_ids.map((teamId) =>
        snapshot.agent_ids.filter((agentId) => snapshot.agent_team_map[agentId] === teamId)
            .length
    );
    expect(teamSizes).toEqual([2, 2]);

    for (const agentId of snapshot.agent_ids) {
        const agent = snapshot.agents[agentId];
        expect(agent.hp).toEqual(expect.any(Number));
        expect(agent.alive).toEqual(expect.any(Boolean));
        expect(agent.position.x).toEqual(expect.any(Number));
        expect(agent.position.y).toEqual(expect.any(Number));
        expect(agent.team_id).toBe(snapshot.agent_team_map[agentId]);
        expectInsideScenarioRegion(agent.position, snapshot.map.scenario_region!);
    }

    expect(snapshot.map.width).toEqual(expect.any(Number));
    expect(snapshot.map.height).toEqual(expect.any(Number));
    expect(snapshot.map.seed).toBe(seed);
    expect(snapshot.map.scenario_region).toBeDefined();
    expect(snapshot.map.scenario_region!.width).toBe(snapshot.map.scenario_region!.height);
    expect(snapshot.map.native_map_size).toBeDefined();
    expect(snapshot.agent_team_map).toBeDefined();
    expect(snapshot.events).toEqual([]);
    expect(() => JSON.parse(snapshotToJson(snapshot))).not.toThrow();
    expect(snapshotToHtml(snapshot)).toContain("CPC Duo 2v2 Snapshot");
    expect(snapshotToHtml(snapshot)).toContain("team-a-0");
});
