import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BattleSnapshotLike } from "./extractSnapshot.ts";

export function snapshotToJson(snapshot: BattleSnapshotLike): string {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export async function dumpSnapshot(snapshot: BattleSnapshotLike, filePath: string) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, snapshotToJson(snapshot), "utf8");
}
