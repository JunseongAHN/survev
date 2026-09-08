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

## PR-S2: field scenario

`scenarios/duo2v2Field.ts` builds the same duo 2v2 on the open `test_normal` field and drops a seeded loot layout with `lootBarn.addLoot()`: an identical starter kit next to each duo spawn (mirrored around the region center) plus one contested kit at the center. The layout is a pure function of `(scenario_region, seed)` via `util.seededRand`, so the same seed always produces the same loot positions. Buildings, obstacles and a CPC map definition are intentionally deferred.

```ts
const { game, seed, mapSize } = createScenarioGame({ seed: "cpc-duo2v2-seed-0" });
const scenario = buildDuo2v2FieldScenario(game, { seed, mapSize }); // scenario.loot lists what was dropped
```

## PR-S3: action adapter

`applyCpcAction.ts` turns a `CpcAction` (`move`, `aim`, `fire.start/hold`, `inputs`, `useItem`) into a native `InputMsg` and feeds it to `player.handleInput()`, so an agent goes through exactly the same code path as a client packet. `keys` mode (default) quantizes `move` to the 8 WASD directions, `touch` mode sends the continuous vector. `stepGame.ts` advances the offline game like the live server (`Config.gameTps` updates, `netSync()` every `gameTps / netSyncTps` ticks), which also keeps `player.visibleObjects` current.

```ts
applyCpcAction(player, { move: v2.create(1, 0), aim: v2.create(0, 1), fire: { hold: true } });
stepGame(game, 100); // one game second
```

Tests: `tests/src/cpc_dev/applyCpcAction.test.ts` covers movement speed and quantization, single/auto fire counts, loot pickup, healing and reviving; `duo2v2FieldScenario.test.ts` covers loot determinism, mirroring and spawning.

## PR-S5 (partial): event taps

`eventTaps.ts` records `fire` / `damage` / `down` / `kill` events for a set of players by wrapping `WeaponManager.fireWeapon()`, `Player.damage()`, `Player.down()` and `Player.kill()` on those instances (`detach()` restores them). A fire event is only recorded when a bullet actually left the gun (clip ammo decreased); a damage event carries `amount` (HP removed after armor), `hpBefore/hpAfter`, the source player id and weapon, and is kept ahead of the down/kill event emitted inside `damage()`. Still to do for S5: loot / heal / revive taps and distance-gated `shots_heard`.

```ts
const taps = attachEventTaps(players, () => tick / Config.gameTps);
// ... step the game ...
taps.events; // [{ type: "fire", t, playerId, weapon, pos, dir }, { type: "damage", t, playerId, sourceId, amount, hpAfter, ... }, ...]
```

Next PRs:

- PR-S4: agent observation from the client-visible object set
- PR-S5 (rest): loot/heal/revive taps, shots_heard
- PR-S6: EpisodeTrajectory JSONL export
- PR-S7: Node/Python bridge (`reset` / `step`)
