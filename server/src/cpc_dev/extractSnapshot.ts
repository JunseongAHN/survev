import type { Game } from "../game/game.ts";
import type { Obstacle } from "../game/objects/obstacle.ts";
import type { CpcAgentId, CpcTeamId, Duo2v2ScenarioPlayer, ScenarioRegion } from "./scenarios/duo2v2.ts";

export interface BattleSnapshotLike {
    schema_version: "cpc-common-v0";
    episode_id: string;
    step: number;
    mode: "duo";
    agent_ids: CpcAgentId[];
    team_ids: CpcTeamId[];
    agent_team_map: Record<CpcAgentId, CpcTeamId>;
    map: {
        width: number;
        height: number;
        seed?: string | number;
        scenario_region?: ScenarioRegion;
        native_map_size?: {
            width: number;
            height: number;
        };
        obstacles?: Array<{
            obstacle_id: string;
            position: { x: number; y: number };
            width?: number;
            height?: number;
            blocks_movement?: boolean;
            blocks_line_of_sight?: boolean;
        }>;
    };
    agents: Record<
        CpcAgentId,
        {
            agent_id: CpcAgentId;
            team_id: CpcTeamId;
            position: { x: number; y: number };
            hp: number;
            alive: boolean;
            facing?: { x: number; y: number };
            aim?: { x: number; y: number };
            native?: {
                playerId?: string | number;
                groupId?: string | number;
                teamId?: string | number;
            };
        }
    >;
    events: [];
}

export interface ExtractSnapshotOptions {
    episodeId: string;
    step: number;
    players: Duo2v2ScenarioPlayer[];
    seed: string | number;
    scenarioRegion: ScenarioRegion;
    nativeMapSize: {
        width: number;
        height: number;
    };
}

function extractObstacle(obstacle: Obstacle, index: number) {
    const bounds = obstacle.obstacleAABB ?? obstacle.bounds;
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;

    return {
        obstacle_id: `obstacle-${index}`,
        position: {
            x: obstacle.pos.x,
            y: obstacle.pos.y,
        },
        width,
        height,
        blocks_movement: obstacle.collidable,
        blocks_line_of_sight: obstacle.height > 0,
    };
}

export function extractBattleSnapshot(
    game: Game,
    options: ExtractSnapshotOptions,
): BattleSnapshotLike {
    const agentIds = options.players.map((p) => p.agentId);
    const teamIds = Array.from(new Set(options.players.map((p) => p.teamId)));
    const agentTeamMap = Object.fromEntries(
        options.players.map((p) => [p.agentId, p.teamId]),
    ) as Record<CpcAgentId, CpcTeamId>;

    const agents = Object.fromEntries(
        options.players.map(({ agentId, teamId, player }) => [
            agentId,
            {
                agent_id: agentId,
                team_id: teamId,
                position: {
                    x: player.pos.x,
                    y: player.pos.y,
                },
                hp: player.health,
                alive: !player.dead && !player.disconnected,
                facing: {
                    x: player.dir.x,
                    y: player.dir.y,
                },
                aim: {
                    x: player.dir.x,
                    y: player.dir.y,
                },
                native: {
                    playerId: player.playerId,
                    groupId: player.groupId,
                    teamId: player.teamId,
                },
            },
        ]),
    ) as BattleSnapshotLike["agents"];

    return {
        schema_version: "cpc-common-v0",
        episode_id: options.episodeId,
        step: options.step,
        mode: "duo",
        agent_ids: agentIds,
        team_ids: teamIds,
        agent_team_map: agentTeamMap,
        map: {
            width: options.scenarioRegion.width,
            height: options.scenarioRegion.height,
            seed: options.seed,
            scenario_region: options.scenarioRegion,
            native_map_size: options.nativeMapSize,
            obstacles: game.map.obstacles.map(extractObstacle),
        },
        agents,
        events: [],
    };
}
