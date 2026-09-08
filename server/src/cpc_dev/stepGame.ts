import { Config } from "../config.ts";
import type { Game } from "../game/game.ts";

/** Advance the offline game the way the live server does: gameTps updates with a netSync every few ticks. */
export function stepGame(
    game: Game,
    ticks: number,
    tickDt = 1 / Config.gameTps,
    netSyncEvery = Math.round(Config.gameTps / Config.netSyncTps),
): void {
    for (let i = 1; i <= ticks; i++) {
        game.update(tickDt);
        if (i % netSyncEvery === 0) game.netSync();
    }
}
