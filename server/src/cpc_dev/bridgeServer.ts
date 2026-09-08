import { App, type TemplatedApp, us_listen_socket_close, type us_listen_socket, type WebSocket } from "uWebSockets.js";
import type { CpcAction } from "./applyCpcAction.ts";
import { CpcEpisode, type EpisodeOptions, type ObsMessage } from "./episode.ts";

interface ResetRequest {
    type: "reset";
    env_id: number;
    scenario?: EpisodeOptions["scenario"];
    seed?: string | number;
    options?: Omit<EpisodeOptions, "scenario" | "seed">;
}

interface StepRequest {
    type: "step";
    env_id?: number;
    ticks?: number;
    actions?: Record<string, CpcAction>;
    /** batched form: env id -> { ticks, actions } */
    envs?: Record<string, { ticks?: number; actions?: Record<string, CpcAction> }>;
}

interface CloseRequest {
    type: "close";
    env_id: number;
}

type Request = ResetRequest | StepRequest | CloseRequest;

interface SocketData {
    envs: Map<number, CpcEpisode>;
}

export interface BridgeServer {
    port: number;
    close(): void;
}

const defaultTicks = 10;
const decoder = new TextDecoder();

function errorMessage(envId: number | undefined, message: string) {
    return { type: "error", env_id: envId ?? null, message };
}

function stepEnv(
    envs: Map<number, CpcEpisode>,
    envId: number,
    req: { ticks?: number; actions?: Record<string, CpcAction> },
): ObsMessage | ReturnType<typeof errorMessage> {
    const episode = envs.get(envId);
    if (!episode) return errorMessage(envId, `unknown env ${envId}, call reset first`);
    try {
        const msg = episode.step(req.actions ?? {}, req.ticks ?? defaultTicks);
        msg.env_id = envId;
        return msg;
    } catch (err) {
        return errorMessage(envId, err instanceof Error ? err.message : String(err));
    }
}

export function handleRequest(envs: Map<number, CpcEpisode>, req: Request): object {
    switch (req.type) {
        case "reset": {
            if (typeof req.env_id !== "number") return errorMessage(undefined, "reset requires a numeric env_id");
            envs.get(req.env_id)?.close();
            try {
                const episode = new CpcEpisode({ scenario: req.scenario, seed: req.seed, ...req.options });
                envs.set(req.env_id, episode);
                const msg = episode.reset();
                msg.env_id = req.env_id;
                return msg;
            } catch (err) {
                envs.delete(req.env_id);
                return errorMessage(req.env_id, err instanceof Error ? err.message : String(err));
            }
        }
        case "step": {
            if (req.envs) {
                const out: Record<string, object> = {};
                for (const [key, sub] of Object.entries(req.envs)) out[key] = stepEnv(envs, Number(key), sub);
                return { type: "obs_batch", envs: out };
            }
            if (typeof req.env_id !== "number") return errorMessage(undefined, "step requires env_id or envs");
            return stepEnv(envs, req.env_id, req);
        }
        case "close": {
            envs.get(req.env_id)?.close();
            envs.delete(req.env_id);
            return { type: "closed", env_id: req.env_id };
        }
        default:
            return errorMessage(undefined, `unknown message type ${(req as { type?: string }).type}`);
    }
}

/** WebSocket bridge: one connection hosts any number of independent offline episodes ("envs"). */
export function startBridgeServer(port: number, host = "127.0.0.1"): Promise<BridgeServer> {
    return new Promise((resolve, reject) => {
        let listenSocket: us_listen_socket | null = null;
        const app: TemplatedApp = App();
        app.ws<SocketData>("/*", {
            idleTimeout: 0,
            maxPayloadLength: 16 * 1024 * 1024,
            upgrade(res, req, context) {
                res.upgrade<SocketData>(
                    { envs: new Map() },
                    req.getHeader("sec-websocket-key"),
                    req.getHeader("sec-websocket-protocol"),
                    req.getHeader("sec-websocket-extensions"),
                    context,
                );
            },
            message(ws: WebSocket<SocketData>, message: ArrayBuffer) {
                let req: Request;
                try {
                    req = JSON.parse(decoder.decode(message));
                } catch {
                    ws.send(JSON.stringify(errorMessage(undefined, "invalid JSON")));
                    return;
                }
                ws.send(JSON.stringify(handleRequest(ws.getUserData().envs, req)));
            },
            close(ws: WebSocket<SocketData>) {
                for (const episode of ws.getUserData().envs.values()) episode.close();
                ws.getUserData().envs.clear();
            },
        });
        app.listen(host, port, (socket) => {
            if (!socket) {
                reject(new Error(`bridge could not listen on ${host}:${port}`));
                return;
            }
            listenSocket = socket;
            resolve({
                port,
                close() {
                    if (listenSocket) us_listen_socket_close(listenSocket);
                    listenSocket = null;
                },
            });
        });
    });
}
