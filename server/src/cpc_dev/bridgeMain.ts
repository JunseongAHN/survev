import { Config } from "../config.ts";
import { startBridgeServer } from "./bridgeServer.ts";

function readOption(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

Config.logging.logDate = false;
Config.logging.debugLogs = false;
Config.logging.infoLogs = false;
Config.logging.warnLogs = true;
Config.logging.errorLogs = true;

const port = Number(readOption("port") ?? process.env.CPC_BRIDGE_PORT ?? 8765);
const host = readOption("host") ?? "127.0.0.1";

const server = await startBridgeServer(port, host);
console.log(`CPC bridge listening on ws://${host}:${server.port} (protocol v0)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.close();
        process.exit(0);
    });
}
