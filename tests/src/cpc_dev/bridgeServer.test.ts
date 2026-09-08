import { afterAll, beforeAll, expect, test } from "vitest";
import { type BridgeServer, startBridgeServer } from "../../../server/src/cpc_dev/bridgeServer.ts";

let server: BridgeServer;
const port = 18765 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
    server = await startBridgeServer(port);
});

afterAll(() => {
    server.close();
});

function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.addEventListener("open", () => resolve(ws));
        ws.addEventListener("error", (e) => reject(e));
    });
}

function request(ws: WebSocket, msg: object): Promise<any> {
    return new Promise((resolve) => {
        ws.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
        ws.send(JSON.stringify(msg));
    });
}

test("reset / step / batched step / close over the websocket", async () => {
    const ws = await connect();

    const reset = await request(ws, {
        type: "reset",
        env_id: 0,
        scenario: "duo2v2_field",
        seed: "cpc-bridge-test",
        options: { controlled: ["team-a-0"], scripted: "idle", timeLimit: 30 },
    });
    expect(reset.type).toBe("obs");
    expect(reset.env_id).toBe(0);
    expect(reset.agent_ids).toHaveLength(4);
    const start = reset.obs["team-a-0"].self.pos;

    const step = await request(ws, {
        type: "step",
        env_id: 0,
        ticks: 10,
        actions: { "team-a-0": { move: { x: 1, y: 0 }, aim: { x: 0, y: 1 }, inputs: ["Interact"] } },
    });
    expect(step.type).toBe("obs");
    expect(step.tick).toBe(10);
    expect(step.obs["team-a-0"].self.pos.x).toBeGreaterThan(start.x);

    const reset1 = await request(ws, {
        type: "reset",
        env_id: 1,
        seed: "cpc-bridge-test-2",
        options: { controlled: [], scripted: "chaser" },
    });
    expect(reset1.type).toBe("obs");
    const batch = await request(ws, {
        type: "step",
        envs: { "0": { ticks: 3 }, "1": { ticks: 3 }, "7": { ticks: 1 } },
    });
    expect(batch.type).toBe("obs_batch");
    expect(batch.envs["0"].tick).toBe(13);
    expect(batch.envs["1"].tick).toBe(3);
    expect(batch.envs["7"].type).toBe("error");

    const bad = await request(ws, { type: "step", env_id: 0, actions: { "team-b-0": {} } });
    expect(bad.type).toBe("error");
    expect(bad.message).toMatch(/not a controlled agent/);

    const closed = await request(ws, { type: "close", env_id: 0 });
    expect(closed).toEqual({ type: "closed", env_id: 0 });
    const gone = await request(ws, { type: "step", env_id: 0 });
    expect(gone.type).toBe("error");

    ws.close();
});
