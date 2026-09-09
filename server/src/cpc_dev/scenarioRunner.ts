import { createScenarioGame } from "./createScenarioGame.ts";
import { type BattleSnapshotLike, extractBattleSnapshot } from "./extractSnapshot.ts";
import { buildDuo2v2Scenario, type CpcAgentId, type CpcTeamId, type Duo2v2ScenarioPlayer } from "./scenarios/duo2v2.ts";

export interface RunDuo2v2SnapshotScenarioOptions {
    steps?: number;
    seed?: string | number;
    mapSize?: number;
}

export interface Duo2v2SnapshotScenarioResult {
    game: ReturnType<typeof createScenarioGame>["game"];
    players: Duo2v2ScenarioPlayer[];
    cpcAgentIds: CpcAgentId[];
    cpcAgentTeamMap: Record<CpcAgentId, CpcTeamId>;
    snapshot: BattleSnapshotLike;
}

export function runDuo2v2SnapshotScenario(
    options: RunDuo2v2SnapshotScenarioOptions = {},
): Duo2v2SnapshotScenarioResult {
    const steps = options.steps ?? 5;
    const { game, seed, mapSize } = createScenarioGame({
        seed: options.seed,
        mapSize: options.mapSize,
    });
    const scenario = buildDuo2v2Scenario(game, { seed, mapSize });

    for (let i = 0; i < steps; i++) {
        game.update(0.1);
    }

    const snapshot = extractBattleSnapshot(game, {
        episodeId: "cpc-dev-duo2v2",
        step: steps,
        players: scenario.players,
        seed: scenario.seed,
        scenarioRegion: scenario.scenarioRegion,
        nativeMapSize: scenario.nativeMapSize,
    });

    return {
        game,
        players: scenario.players,
        cpcAgentIds: scenario.cpcAgentIds,
        cpcAgentTeamMap: scenario.agentTeamMap,
        snapshot,
    };
}
