import { resolve } from "node:path";
import { dumpSnapshot, dumpSnapshotHtml } from "./dumpSnapshot.ts";
import { runDuo2v2SnapshotScenario } from "./scenarioRunner.ts";

function readOption(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readNumberOption(name: string): number | undefined {
    const value = readOption(name);
    if (value === undefined) return undefined;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
}

const outDir = resolve(readOption("outDir") ?? ".tmp/cpc_dev");
const result = runDuo2v2SnapshotScenario({
    steps: readNumberOption("steps"),
    seed: readOption("seed"),
    mapSize: readNumberOption("mapSize"),
});

const jsonPath = resolve(outDir, "duo2v2Snapshot.json");
const htmlPath = resolve(outDir, "duo2v2Snapshot.html");

await dumpSnapshot(result.snapshot, jsonPath);
await dumpSnapshotHtml(result.snapshot, htmlPath);

console.log(`CPC duo 2v2 snapshot JSON: ${jsonPath}`);
console.log(`CPC duo 2v2 snapshot HTML: ${htmlPath}`);
