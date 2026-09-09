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

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function formatAgentRows(snapshot: BattleSnapshotLike): string {
    return snapshot.agent_ids.map((agentId) => {
        const agent = snapshot.agents[agentId];
        return `<tr><td>${escapeHtml(agent.agent_id)}</td><td>${escapeHtml(agent.team_id)}</td><td>${
            agent.hp.toFixed(1)
        }</td><td>${agent.alive ? "alive" : "dead"}</td><td>${agent.position.x.toFixed(2)}, ${
            agent.position.y.toFixed(2)
        }</td><td>${agent.native?.playerId ?? ""}</td></tr>`;
    }).join("\n");
}

function formatAgentMarkers(snapshot: BattleSnapshotLike): string {
    const region = snapshot.map.scenario_region
        ?? { x: 0, y: 0, width: snapshot.map.width, height: snapshot.map.height };

    return snapshot.agent_ids.map((agentId) => {
        const agent = snapshot.agents[agentId];
        const left = ((agent.position.x - region.x) / region.width) * 100;
        const top = ((agent.position.y - region.y) / region.height) * 100;
        const teamClass = agent.team_id === "team-a" ? "team-a" : "team-b";
        return `<div class="agent ${teamClass}" style="left:${left}%;top:${top}%"><span>${
            escapeHtml(agent.agent_id)
        }</span></div>`;
    }).join("\n");
}

export function snapshotToHtml(snapshot: BattleSnapshotLike): string {
    const region = snapshot.map.scenario_region;
    const nativeMapSize = snapshot.map.native_map_size;
    const json = escapeHtml(snapshotToJson(snapshot));

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CPC Duo 2v2 Snapshot</title>
<style>
body{margin:0;font:14px/1.4 system-ui,Segoe UI,Arial,sans-serif;background:#f5f7fb;color:#18202f}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 16px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:16px}
.summary div,.panel{background:white;border:1px solid #d9e0eb;border-radius:8px;padding:12px}
.label{display:block;color:#5d6b82;font-size:12px;text-transform:uppercase}
.value{font-weight:700}
.map{position:relative;aspect-ratio:1;border:1px solid #9ca8ba;background:#dfe7d6;overflow:hidden;border-radius:8px}
.map:before{content:"scenario region";position:absolute;left:10px;top:8px;color:#4d5b48;font-size:12px}
.agent{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid white;box-shadow:0 1px 5px #0005}
.agent span{position:absolute;left:16px;top:-4px;white-space:nowrap;background:white;border:1px solid #d9e0eb;border-radius:4px;padding:1px 4px;font-size:12px}
.team-a{background:#2563eb}.team-b{background:#dc2626}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;border-bottom:1px solid #e3e8f0;padding:8px}
pre{white-space:pre-wrap;overflow:auto;max-height:420px}
</style>
</head>
<body>
<main>
<h1>CPC Duo 2v2 Snapshot</h1>
<section class="summary">
<div><span class="label">Schema</span><span class="value">${escapeHtml(snapshot.schema_version)}</span></div>
<div><span class="label">Episode</span><span class="value">${escapeHtml(snapshot.episode_id)}</span></div>
<div><span class="label">Step</span><span class="value">${snapshot.step}</span></div>
<div><span class="label">Mode</span><span class="value">${escapeHtml(snapshot.mode)}</span></div>
<div><span class="label">Seed</span><span class="value">${escapeHtml(String(snapshot.map.seed ?? ""))}</span></div>
<div><span class="label">Region</span><span class="value">${
        region ? `${region.width} x ${region.height}` : `${snapshot.map.width} x ${snapshot.map.height}`
    }</span></div>
<div><span class="label">Native map</span><span class="value">${
        nativeMapSize ? `${nativeMapSize.width} x ${nativeMapSize.height}` : "unknown"
    }</span></div>
<div><span class="label">Events</span><span class="value">${snapshot.events.length}</span></div>
</section>
<section class="panel">
<div class="map">${formatAgentMarkers(snapshot)}</div>
</section>
<section class="panel">
<h2>Agents</h2>
<table><thead><tr><th>Agent</th><th>Team</th><th>HP</th><th>Status</th><th>Position</th><th>Native player</th></tr></thead><tbody>
${formatAgentRows(snapshot)}
</tbody></table>
</section>
<section class="panel">
<h2>Raw Snapshot JSON</h2>
<pre>${json}</pre>
</section>
</main>
</body>
</html>
`;
}

export async function dumpSnapshotHtml(snapshot: BattleSnapshotLike, filePath: string) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, snapshotToHtml(snapshot), "utf8");
}
