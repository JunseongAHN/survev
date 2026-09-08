import type { MapDefKey } from "../../../shared/defs/mapDefs.ts";
import { TeamMode } from "../../../shared/gameConfig.ts";
import { Config } from "../config.ts";
import { Game } from "../game/game.ts";

export interface ScenarioGameOptions {
    mapName?: MapDefKey;
    seed?: string | number;
    mapSize?: number;
}

export interface ScenarioGame {
    game: Game;
    seed: string | number;
    mapSize: number;
    seedApplied: boolean;
}

export const defaultScenarioSeed = "cpc-duo2v2-seed-0";
export const defaultScenarioMapSize = 128;

export function normalizeSeed(seed: string | number | undefined): number | undefined {
    if (seed === undefined) return undefined;
    if (typeof seed === "number") return Number.isFinite(seed) ? seed : undefined;

    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = Math.imul(31, hash) + seed.charCodeAt(i) | 0;
    }
    return hash >>> 0;
}

export function createScenarioGame(options: ScenarioGameOptions = {}): ScenarioGame {
    Config.logging.logDate = false;
    Config.logging.debugLogs = false;
    Config.logging.infoLogs = false;
    Config.logging.warnLogs = true;
    Config.logging.errorLogs = true;

    const game = new Game("cpc-dev", {
        mapName: options.mapName ?? "test_normal",
        teamMode: TeamMode.Duo,
    });

    const seed = options.seed ?? defaultScenarioSeed;
    const mapSize = options.mapSize ?? defaultScenarioMapSize;

    game.map.regenerate(normalizeSeed(seed));

    return {
        game,
        seed,
        mapSize,
        seedApplied: true,
    };
}
