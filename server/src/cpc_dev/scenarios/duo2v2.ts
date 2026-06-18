import { v2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../../game/game.ts";
import type { Group } from "../../game/group.ts";
import type { Player } from "../../game/objects/player.ts";

export type CpcAgentId = "team-a-0" | "team-a-1" | "team-b-0" | "team-b-1";
export type CpcTeamId = "team-a" | "team-b";

export interface Duo2v2ScenarioPlayer {
    agentId: CpcAgentId;
    teamId: CpcTeamId;
    player: Player;
    group: Group;
}

export interface Duo2v2Scenario {
    players: Duo2v2ScenarioPlayer[];
    cpcAgentIds: CpcAgentId[];
    agentTeamMap: Record<CpcAgentId, CpcTeamId>;
    seed: string | number;
    scenarioRegion: ScenarioRegion;
    nativeMapSize: {
        width: number;
        height: number;
    };
}

export interface ScenarioRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Duo2v2ScenarioOptions {
    seed: string | number;
    mapSize: number;
}

const cpcTeams = {
    "team-a-0": "team-a",
    "team-a-1": "team-a",
    "team-b-0": "team-b",
    "team-b-1": "team-b",
} as const satisfies Record<CpcAgentId, CpcTeamId>;

function createScenarioRegion(game: Game, requestedMapSize: number): ScenarioRegion {
    const size = Math.min(requestedMapSize, game.map.width, game.map.height);

    return {
        x: (game.map.width - size) / 2,
        y: (game.map.height - size) / 2,
        width: size,
        height: size,
    };
}

export function buildDuo2v2Scenario(
    game: Game,
    options: Duo2v2ScenarioOptions,
): Duo2v2Scenario {
    const groupA = game.playerBarn.addGroup(false);
    const groupB = game.playerBarn.addGroup(false);
    const scenarioRegion = createScenarioRegion(game, options.mapSize);
    const centerY = scenarioRegion.y + scenarioRegion.height / 2;
    const leftX = scenarioRegion.x + scenarioRegion.width * 0.25;
    const rightX = scenarioRegion.x + scenarioRegion.width * 0.75;
    const teammateOffset = scenarioRegion.height * 0.05;

    const players: Duo2v2ScenarioPlayer[] = [
        {
            agentId: "team-a-0",
            teamId: "team-a",
            group: groupA,
            player: game.playerBarn.addTestPlayer({
                group: groupA,
                name: "team-a-0",
                pos: v2.create(leftX, centerY - teammateOffset),
            }),
        },
        {
            agentId: "team-a-1",
            teamId: "team-a",
            group: groupA,
            player: game.playerBarn.addTestPlayer({
                group: groupA,
                name: "team-a-1",
                pos: v2.create(leftX, centerY + teammateOffset),
            }),
        },
        {
            agentId: "team-b-0",
            teamId: "team-b",
            group: groupB,
            player: game.playerBarn.addTestPlayer({
                group: groupB,
                name: "team-b-0",
                pos: v2.create(rightX, centerY - teammateOffset),
            }),
        },
        {
            agentId: "team-b-1",
            teamId: "team-b",
            group: groupB,
            player: game.playerBarn.addTestPlayer({
                group: groupB,
                name: "team-b-1",
                pos: v2.create(rightX, centerY + teammateOffset),
            }),
        },
    ];

    return {
        players,
        cpcAgentIds: players.map((p) => p.agentId),
        agentTeamMap: { ...cpcTeams },
        seed: options.seed,
        scenarioRegion,
        nativeMapSize: {
            width: game.map.width,
            height: game.map.height,
        },
    };
}
