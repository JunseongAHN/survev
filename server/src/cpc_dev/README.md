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

`layout: "random"` (default `"fixed"`) rotates the spawn axis by a seeded angle and draws the duo-to-center distance from [24, 44] u; team-b is team-a mirrored across the center, everyone faces the center and the team kits move with the spawns (`scenario.spawnLayout` reports angle, radius, spawns and facing). It exists because a PPO agent trained on the fixed layout learned to aim at the constant spawn direction instead of at enemies. Seeds are mixed (xorshift-multiply) before Park-Miller because its first draws are nearly linear in the seed and string seeds like `run-0`/`run-1` hash to neighbours; this also changed the fixed layout's scatter for a given seed compared with builds before 2026-09-09.

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

`inputs` accepts `Input` enum numbers or their names (`"Interact"`), which is what the bridge sends; unknown values throw so a bad payload surfaces as a bridge `error` instead of a silently ignored key press (this was a real bug: named inputs were dropped, so bridge agents could not pick up, equip or reload until the fix).

Tests: `tests/src/cpc_dev/applyCpcAction.test.ts` covers movement speed and quantization, single/auto fire counts, loot pickup, healing and reviving; `duo2v2FieldScenario.test.ts` covers loot determinism, mirroring and spawning.

## PR-S5 (partial): event taps

`eventTaps.ts` records `fire` / `damage` / `down` / `kill` events for a set of players by wrapping `WeaponManager.fireWeapon()`, `Player.damage()`, `Player.down()` and `Player.kill()` on those instances (`detach()` restores them). A fire event is only recorded when a bullet actually left the gun (clip ammo decreased); a damage event carries `amount` (HP removed after armor), `hpBefore/hpAfter`, the source player id and weapon, and is kept ahead of the down/kill event emitted inside `damage()`.

It also records `loot` / `heal` / `revive` the same way. `Player.pickupLoot()` always destroys the pile and re-drops whatever did not fit, so a `loot` event is emitted only when the player's own holdings (inventory, weapons, gear, scope) actually changed — a refused pickup produces nothing; `count` is the pile's count, not necessarily the amount taken. `heal` and `revive` come from `Player.applyActionFunc()`, which the engine calls when a `UseItem` / `Revive` action *completes*, so the event marks the moment the item was consumed or the teammate stood up rather than the moment the action started. `heal` covers heals (`bandage`, `healthkit`) and boosts (`soda`, `painkiller`) and carries both changes; `revive` names the revived teammate as the subject and the reviver as `sourceId`, like `down` / `kill`.

```ts
const taps = attachEventTaps(players, () => tick / Config.gameTps);
// ... step the game ...
taps.events; // [{ type: "fire", t, playerId, weapon, pos, dir }, { type: "damage", t, playerId, sourceId, amount, hpAfter, ... }, ...]
```

Teams wear distinct body skins by default so a spectator (or a rendered frame) can tell the duos apart: team-a `outfitBlueLeader` (blue), team-b `outfitRed` (red) — the 50v50 faction skins, used as plain outfits because `test_normal` is not a faction map (the client's faction patch / `GameConfig.teamColors` only render in faction mode). `teamOutfits: false` keeps the engine default; outfits are visual only and never enter the observation.

## Race objective (`objective.ts`)

`{ objective: { mode: "race" }, endOnElimination: false }` on the episode turns on a shared capture point: one seeded point at a time (`RaceObjective`, seed stream 104729), visible to every agent as `obs.objective`, captured by the first standing player within 4 u (a `capture` event credited to that player's team), then moved 30–70 u away. Points keep coming until the time limit, and with `endOnElimination: false` a team that wipes the other keeps collecting them — which is the intended reason to fight, instead of an explicit death penalty. `info.objective` carries the point and the captures per team; metrics gain `captures` / `team_captures`; the winner is the team with more captures. `liveHook` can reuse the same class for rendered games.

## Scripted opponents (`scriptedPolicy.ts`)

`chaser` (default) loots the nearest gun, approaches the nearest enemy to 22 u, strafes between 10 and 22 u, holds fire inside 30 u and revives a downed teammate when no enemy is within 25 u. `racer` shares the loot and combat phases but engages only inside `racerEngageDist` (25 u) and otherwise runs to the shared race point (`ctx.objective`), so it competes for captures; without an objective it behaves like the chaser. Both read game state directly (omniscient) and are benchmark opponents, not human-likeness references. `idle` does nothing.

`scriptedOptions` (episode / bridge reset option, `ScriptedOptions`) is the strength knob for a curriculum: `aimNoiseDeg` adds a seeded Gaussian error (stream 15485863) to the combat aim on every decision, `reactionDelay` makes a bot hold fire until an enemy has been inside the 30 u fire range for that many seconds (the clock keeps running while it loots), and `engageDist` moves the racer's break-off distance. Defaults reproduce the exact bots. Measured against two idle targets on one seed (30 s, chasers): time to kill both 6.1 s exact, 8.6 s at 5°, 14.3 s at 10°, 25.6 s at 20°, not within 30 s at 60°; hits per shot 0.42 → 0.38 → 0.21 → 0.17 → 0.15.

## PR-S4: agent observation

`observation.ts` builds what an agent's client would know: `player.visibleObjects` (the set the server streams, refreshed by `netSync()`) cut to the view rectangle (`zoom + 4` half-width, 16:9), split into visible players / loot / obstacles / dead bodies, plus bullets inside the same rectangle, teammates from group status, own state, gas and alive counts. Enemy HP is never included and `observationAllowlist` is enforced by a test, so nothing outside the schema can leak in.

`shots_heard` is the one channel that is not built from `visibleObjects`: the shots *other* players fired during the step, bucketed by `hearShot()` into one of 8 compass points and near / mid / far. `shotsHeardRadius` is 48 u, taken from the client's own audio — another player's shot plays on the `otherPlayers` channel whose `maxRange` is 48 with the default `rangeMult` of 1. That reaches past the view rectangle (zoom 28 -> 32 u half-width), which is the point: an agent hears fights it cannot see, exactly as a human does. Listeners beyond the radius get an empty list, nobody hears their own shots, and `dir` is **world** space with y growing upward (`"N"` = +y) — not the screen-space convention the harness `MOVE_LABELS` use. `CpcEpisode` owns the step's fire events, so it computes the per-agent lists and passes them in.

## PR-S7: episode + bridge

`episode.ts` (`CpcEpisode`) runs one offline field scenario step by step: `reset()` builds the game, scenario, loot and event taps; `step(actions, ticks)` applies `CpcAction`s of the controlled agents (held between steps like a held key), lets the built-in scripted policy (`scriptedPolicy.ts`, `chaser` or `idle`) drive the others every 0.1 s, advances `ticks` game ticks with the live netSync cadence, and returns observations for all agents, the events of the step, `done` and, at the end, per-agent metrics (survival time, HP mean/end, damage, kills, shots, team win, partner survival). `bridgeServer.ts` exposes this over a WebSocket (uWebSockets.js) with `reset` / `step` / batched `step` / `close` messages; the protocol is documented in `evolutionary-ai-battle/docs/survev-bridge-v0.md` and the Python client lives in that repo under `experiment/survev_rl/`.

```sh
pnpm cpc:bridge -- --port=8765     # ws://127.0.0.1:8765
```

Measured with the Python client on 2 vCPUs: `ticks=10` ~42x real time per env, `ticks=3` ~33x, `ticks=1` ~14x; 8 envs batched in one process ~136x aggregate.

Tests: `episode.test.ts` (allowlisted observations, view-rectangle parity with `visibleObjects`, held/released inputs, elimination + metrics, time limit + events, `shots_heard` earshot gating), `shotsHeard.test.ts` (compass and distance buckets, the radius as a circle) and `bridgeServer.test.ts` (websocket round trip). The bridge test needs a platform where the uWebSockets.js binary loads (Windows / recent glibc).

Next PRs:

- PR-S6: EpisodeTrajectory JSONL export (harness schema) from bridge episodes
