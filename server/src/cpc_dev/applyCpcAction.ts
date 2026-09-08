import type { Input } from "../../../shared/gameConfig.ts";
import { InputMsg } from "../../../shared/net/inputMsg.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Player } from "../game/objects/player.ts";

export interface CpcAction {
    /** World-space move direction. Length is ignored; zero or undefined means stand still. */
    move?: Vec2;
    /** World-space aim direction. */
    aim?: Vec2;
    /** `start` is edge-triggered (send it on the tick the trigger is pulled), `hold` is level-triggered. */
    fire?: { start?: boolean; hold?: boolean };
    inputs?: Input[];
    useItem?: string;
}

/** `keys` quantizes `move` to the 8 directions WASD can express, `touch` sends it as a continuous vector. */
export type CpcMoveMode = "keys" | "touch";

// sin(22.5deg): a normalized component beyond this presses that key, which yields 45deg sectors
const keyThreshold = 0.383;

export function buildInputMsg(action: CpcAction, moveMode: CpcMoveMode = "keys"): InputMsg {
    const msg = new InputMsg();

    const move = action.move && v2.length(action.move) > 0 ? v2.normalizeSafe(action.move) : undefined;
    if (move && moveMode === "touch") {
        msg.touchMoveActive = true;
        msg.touchMoveDir = move;
    } else if (move) {
        msg.moveLeft = move.x < -keyThreshold;
        msg.moveRight = move.x > keyThreshold;
        msg.moveUp = move.y > keyThreshold;
        msg.moveDown = move.y < -keyThreshold;
    }

    if (action.aim) {
        msg.toMouseDir = v2.normalizeSafe(action.aim);
    }
    msg.shootStart = action.fire?.start ?? false;
    msg.shootHold = action.fire?.hold ?? false;
    for (const input of action.inputs ?? []) {
        msg.addInput(input);
    }
    msg.useItem = action.useItem ?? "";

    return msg;
}

/** Applies a CPC action to a player exactly like a client input packet would. */
export function applyCpcAction(player: Player, action: CpcAction, moveMode: CpcMoveMode = "keys"): InputMsg {
    const msg = buildInputMsg(action, moveMode);
    player.handleInput(msg);
    return msg;
}
