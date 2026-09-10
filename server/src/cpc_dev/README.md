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
- Seed support uses the existing map regeneration path and fixed scenario-region-relative player positions. The full engine is **not** deterministic; what a seed does and does not fix is listed under "Reproducibility (M9)" below.
- PR-S1 emitted no events. Since PR-S5 the episode reports fire / damage / down / kill / loot / heal / revive (see "event taps").

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

## Reproducibility (M9)

Phase 0 asks for the *boundary*, not full determinism: the engine is upstream code and patching
every `Math.random()` is out of scope (the action plan says so explicitly, and falls back to
statistical evaluation over several episodes per seed). `determinism.test.ts` pins the boundary
from both sides, and the honest summary is: **the world is seeded, the shooting is not.**

Fixed by the scenario seed:

| what | how |
|---|---|
| map seed, rivers and lakes | `createScenarioGame` -> `map.regenerate(normalizeSeed(seed))`; `map.init` runs river/lake generation off `util.seededRand(this.seed)` |
| loot layout (team kits + the contested center kit) | `duo2v2Field.ts`, `seededRand(seed, 0)` |
| spawn geometry, including `layout: "random"`'s rotation and distance | `duo2v2Field.ts`, `seededRand(seed, 7919)` |
| race objective point positions | `objective.ts`, `seededRand(seed, 104729)` |
| the scripted opponents' aim noise | `episode.ts`, `seededRand(seed, 15485863)` |

Not fixed, ordered by how much it moves the metrics:

| source | what it perturbs |
|---|---|
| `weaponManager.ts` bullet direction: `util.random(-0.5, 0.5) * spread` | **every shot.** ak47 `shotSpread` 2.5 deg (+7.5 while moving), mp5 3 (+4) — so hit rate, `damage_dealt`, `hits_given` and `kills` all vary run to run |
| `player.ts` `Math.random() < GameConfig.player.headshotChance` (0.15) | damage per hit, hence time-to-kill |
| `util.random` / `util.randomInt` / `v2.randomUnit` / `util.randomPointInCircle` at ~90 call sites in `server/src/game` | loot scatter and push velocity on drops and refused pickups (so *where* loot ends up), throwable and explosion geometry, decal placement |
| `map.ts` object placement (`Math.random` at 5 sites, and the `randomGenerator` default of `util.random`) | terrain layout — moot on `test_normal`, which is an empty field, but it means a scenario with obstacles would not be seed-stable |
| netSync timing and float accumulation over `game.update(1/100)` | positions drift by fractions of a unit between otherwise identical runs |

Consequences for reading results: compare **means over several episodes**, never single runs; a
seed reproduces the *situation* (map, loot, spawns, opponent aim noise) but not the *exchange*.
`layout: "random"` is the training default precisely so absolute directions carry no information
across episodes.

## PR-S5: event taps

`eventTaps.ts` records `fire` / `damage` / `down` / `kill` events for a set of players by wrapping `WeaponManager.fireWeapon()`, `Player.damage()`, `Player.down()` and `Player.kill()` on those instances (`detach()` restores them). A fire event is only recorded when a bullet actually left the gun (clip ammo decreased); a damage event carries `amount` (HP removed after armor), `hpBefore/hpAfter`, the source player id and weapon, and is kept ahead of the down/kill event emitted inside `damage()`.

It also records `loot` / `heal` / `revive` the same way. `Player.pickupLoot()` always destroys the pile and re-drops whatever did not fit, so a `loot` event is emitted only when the player's own holdings (inventory, weapons, gear, scope) actually changed — a refused pickup produces nothing; `count` is the pile's count, not necessarily the amount taken. `heal` and `revive` come from `Player.applyActionFunc()`, which the engine calls when a `UseItem` / `Revive` action *completes*, so the event marks the moment the item was consumed or the teammate stood up rather than the moment the action started. `heal` covers heals (`bandage`, `healthkit`) and boosts (`soda`, `painkiller`) and carries both changes; `revive` names the revived teammate as the subject and the reviver as `sourceId`, like `down` / `kill`.

```ts
const taps = attachEventTaps(players, () => tick / Config.gameTps);
// ... step the game ...
taps.events; // [{ type: "fire", t, playerId, weapon, pos, dir }, { type: "damage", t, playerId, sourceId, amount, hpAfter, ... }, ...]
```

Teams wear distinct body skins by default so a spectator (or a rendered frame) can tell the duos apart: team-a `outfitBlueLeader` (blue), team-b `outfitRed` (red) — the 50v50 faction skins, used as plain outfits because `test_normal` is not a faction map (the client's faction patch / `GameConfig.teamColors` only render in faction mode). `teamOutfits: false` keeps the engine default; outfits are visual only and never enter the observation.

## System 1 skills (`skills.ts`)

The seven skills a controlled agent can be given instead of raw inputs: `move_to`, `follow`,
`loot`, `heal`, `engage`, `retreat`, `revive`. `runSkill` turns one `{skill, params}` into a
`CpcAction` every tick and returns `{action, done, failed?}`, which is what lets System 2 commit to
an intent and be re-called only when it completes or breaks. `hold` / `peek` / `rotate_zone` /
`idle_look` arrive with cover and the gas schedule; `take_cover` needs obstacles, and the open field
has none.

`scriptedPolicy.ts` is a *selector* over these — a hand-written priority order (loot first, then
revive a downed teammate if it is safe, engage inside `engageDist`, else run the race, else chase),
which is exactly the job the planner takes over, and the order it has to beat. The skill bodies are
the opponents' old phases extracted unchanged, so the behaviour tests in `episode.test.ts` are the
regression test for that refactor and the PPO baselines stay comparable.

`SkillOptions` holds the motor constraints per agent — `aimNoiseDeg`, `reactionDelay`,
`pathJitterDeg`. The opponents get theirs from `scriptedOptions` (a strength axis), the controlled
agents from the episode's `humanization` option (a human-likeness axis). Same three dials, opposite
purposes: a benchmark opponent wants zero, a teammate meant to pass for a person does not.

Over the wire the episode resolves agent ids to players and reports every committed skill in
`info.skills`; the protocol is in `docs/survev-bridge-v0.md`.

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

## One episode without a bridge (`episodeMain.ts`, M10)

```sh
pnpm cpc:episode -- --scenario duo2v2 --policy random --seconds 60 --out .tmp/ep.jsonl
```

Runs one episode through `CpcEpisode` in this process and writes it as JSONL — one line per step,
each line the `ObsMessage` the bridge would have sent (observations for every agent, that step's
events, and `info`, with `info.metrics` on the last line). No WebSocket, no Python: this is the
smallest way to ask "does the scenario still run", and what CI calls.

`--policy` is `random` (seeded random actions for team-a, the floor a real policy is compared
against) or `chaser` / `racer` / `idle` (the server scripts all four). `--scripted` sets the
opponent when the policy is `random`; `--seed`, `--ticks` and `--seconds` are the usual knobs.
Both `--name value` and `--name=value` are accepted. Typical output on this hardware is ~50x real
time for a 60 s limit.

Measured with the Python client on 2 vCPUs: `ticks=10` ~42x real time per env, `ticks=3` ~33x, `ticks=1` ~14x; 8 envs batched in one process ~136x aggregate.

The phase-0 acceptance sweep is on the Python side:
`python -m pytest experiment/survev_rl/tests/test_phase0_acceptance.py` in the harness repo walks
M1 / M6 / M7 / M8 and reports throughput, against a real bridge when `CPC_BRIDGE_URL` is set and
the Python mock otherwise. M2-M5, M9 and M10 stay here as vitest and as the runner above; the
test's own docstring carries that table.

Tests: `episode.test.ts` (allowlisted observations, view-rectangle parity with `visibleObjects`, held/released inputs, elimination + metrics, time limit + events, `shots_heard` earshot gating), `shotsHeard.test.ts` (compass and distance buckets, the radius as a circle), `determinism.test.ts` (M9: what the seed fixes and what it does not) and `bridgeServer.test.ts` (websocket round trip). The bridge test needs a platform where the uWebSockets.js binary loads (Windows / recent glibc).

Next PRs:

- PR-S6: EpisodeTrajectory JSONL export (harness schema) from bridge episodes
