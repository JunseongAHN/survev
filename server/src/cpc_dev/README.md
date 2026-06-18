# CPC Dev Scenario Runner

PR-S1 adds a small server/test-only foundation for running CPC-style local scenarios on top of the real server simulation.

It creates an offline `Game`, spawns a fixed duo 2v2 with existing `PlayerBarn.addTestPlayer()` and native group semantics, steps the simulation, and extracts a `BattleSnapshot`-like JSON object. It does not require live clients, browser code, a network server, a database, Python, TorchRL, or training code.

The default scenario uses seed `cpc-duo2v2-seed-0` and a `128 x 128` CPC `scenario_region` centered inside the native test map. The engine does not expose a clean constructor-level map width/height override, so PR-S1 keeps the native map intact and records both `scenario_region` and `native_map_size` in the snapshot.

Run the focused test:

```sh
cd tests
pnpm test src/cpc_dev/duo2v2Scenario.test.ts
```

Generate a browser-inspectable snapshot without starting any server:

```sh
pnpm cpc:duo2v2:snapshot
```

This writes:

- `.tmp/cpc_dev/duo2v2Snapshot.json`
- `.tmp/cpc_dev/duo2v2Snapshot.html`

Open the HTML file directly in a browser to see scenario status, agent positions, HP, teams, and the raw snapshot JSON. Optional flags are supported:

```sh
pnpm cpc:duo2v2:snapshot -- --steps=10 --seed=cpc-duo2v2-seed-0 --mapSize=128
```

To inspect a snapshot from code, call `runDuo2v2SnapshotScenario()` and either use the returned `snapshot` object directly or pass it to `snapshotToJson()` / `dumpSnapshot()`. Tests do not write debug artifacts automatically.

Intentional limitations:

- CPC ids are stable scenario ids: `team-a-0`, `team-a-1`, `team-b-0`, `team-b-1`.
- Native player, group, and team ids are preserved under `agents[agent_id].native`.
- Duo teammate semantics are mapped to native groups. For duo maps, native `teamId` currently mirrors `groupId`.
- Seed support uses the existing map regeneration path and fixed scenario-region-relative player positions, but the full engine is not deterministic because other systems may still use `Math.random()` / unseeded randomness.
- `events` is always an empty array. No fire, damage, death, LOS, or CPC metric hooks are included in PR-S1.

Next PRs:

- PR-S2: solo 1v1v1v1 scenario using the same runner
- PR-S3: CPC action to native InputMsg adapter
- PR-S4: passive snapshot metrics
- PR-S5: fire/damage/death event taps
- PR-S6: EpisodeTrajectory JSONL export
