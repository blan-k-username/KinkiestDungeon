# tools/mp-server — Multiplayer server PoC (KD-079)

A **lightweight, throwaway** proof that the server-authoritative MP architecture
(epic KD-078 / KD-066) works end-to-end: the stock game bundle runs headless in
plain Node, and one *world* instance + two *player* instances step in lockstep
over one shared scenario, kept consistent each turn.

This is PoC-tier. Production hardening lives in KD-067 (host), KD-068 (serverMode),
KD-069 (orchestrator), KD-070 (reconciler).

## Files

| File | Role |
|---|---|
| `shims.js` | Headless shim layer — PIXI/DOM/WebGL/Audio/IndexedDB/`fetch` stubs so `out/main.js` boots with no browser. `fetch` is file-backed (local reads only). |
| `headless-host.js` | `HeadlessHost` — boots the bundle in an **isolated `vm.Context` per instance** and bridges into its script scope via an appended `__KDEVAL`. Exposes `init/step/getState/eval` + scenario & reconciler helpers. |
| `orchestrator.js` | `Orchestrator` — 1 world + 2 player hosts, global turn clock (`submitMove`), and the minimal reconciler. **In-process direct calls** (KD-079 baseline, no serialization). |
| `mp-session.js` | `MPSession` — async port of the orchestrator that drives instances over a **pluggable transport** (serialized messages). KD-081. |
| `lobby.js` | `Lobby` — generalized **N-player (2–4)** session over the transport: join flow, N-player turn clock + reconciler, **PvP**, and **server-side mod loading**. KD-080. |
| `transport/` | Transport boundary (KD-081): `protocol.js` (commands + `dispatch`), `in-process.js`, `worker-thread.js` (+`worker-entry.js`), `socket.js` (+`child-entry.js`), `index.js` (registry). |
| `TRANSPORTS.md` | Measured comparison of the three transports (pros/cons + game-code-change count). |
| `smoke-boot.js` / `bench-transports.js` | Manual smoke driver / transport benchmark. |

## How it works

- **Isolation:** each instance gets its own V8 context, so every KD `let`/`const`
  global (e.g. `KinkyDungeonCurrentTick`) is private. This is what allows three
  live instances in one Node process.
- **Bridge:** KD globals are top-level `let` (script scope, not on the global
  object). `__KDEVAL` is appended to the same script as the bundle so its closure
  can read/write them — the Node analogue of Playwright's `page.evaluate`.
- **No source edits:** rendering is neutered and `serverMode` is implemented by
  reassigning KD's globals at runtime (`DrawCharacter`, `KinkyDungeonUpdateEnemies`)
  — the same reassignable-global mechanism the mod system uses.

## Run

All commands run **inside Docker** (per project rules — no host runtimes).

```bash
# Manual smoke (one instance)
docker run --rm -v "$PWD":/usr/src/app -w /usr/src/app node:23-slim \
  node -e "setTimeout(()=>process.exit(2),120000).unref(); require('./tools/mp-server/smoke-boot.js')"

# Automated tests (node-layer Vitest, no Chromium)
tools/run-tests.sh unit     # includes tests/unit/mp-headless-host.spec.ts + mp-orchestrator.spec.ts
```

> Build `out/main.js` first with `npx tsc` in Docker (NOT `npm run build` — no
> python in the image). `run-tests.sh` does this for you.

## Transport boundary (KD-081)

KD-079 wired instances together with **direct in-process calls** (no serialization). KD-081 adds a
**pluggable transport** so the same `MPSession` runs the world + players over a real serialized
boundary — three adapters, each for a different goal:

| Transport | what it is | goal | game-code change |
|---|---|---|---|
| `in-process` | same process, JSON round-trip per message | MVP / localhost | **0** |
| `worker` | `worker_threads` isolate per instance | smaller scale | **0** |
| `socket` | `child_process` + TCP loopback, newline-JSON | true remote / lobby | **0** |

The headline result: **transport choice costs zero game-code change** — only the injected transport
differs; the orchestrator and game bundle are untouched. Full comparison + measurements in
`TRANSPORTS.md`. Tests: `tests/unit/mp-transport.spec.ts` (4 ACs over each transport + a
separate-OS-process assertion for `socket`).

## Feature pillars (KD-080)

`lobby.js` adds the three concept pillars on top of the host + transport, still with **zero
game-source edits**:

- **Lobby join (2–4)** — `lobby.start()` boots the world + enemy; `lobby.join(id)` assigns a fresh
  player instance to each stub client (2–4). The turn clock advances only when *all* joined clients
  submit; the reconciler injects the enemy into every player and each player's avatar into every
  other.
- **PvP** — `lobby.pvp(attacker, target, {restraint, damage})` applies the effect to the **target's
  instance only** (e.g. `addRestraint('DuctTapeHands')`, `dealDamage(3,'pain')`). The target's
  restraint count rises and `Will` drops; the attacker is byte-for-byte unchanged — proving
  per-instance state isolation.
- **Server-side mod** — `lobby.loadMod()` reads a real mod file (default `Mods/example_enemy/init.ks`)
  and evals it into the instances via the host bridge — the same path as the production loader
  (`Scripts/KDMods.ts:483`) and `tests/helpers/mod-injector.ts`. The modded enemy (`AngrySkeleton`)
  then resolves via `KinkyDungeonGetEnemyByName` in every instance (and is absent in a control).

Tests: `tests/unit/mp-lobby.spec.ts` (lobby 2/3/4, PvP isolation, mod load). Default in-process
transport; the lobby is transport-agnostic (any registered transport works).

## Known limitations (PoC)

- Full `KinkyDungeonGenerateSaveData()` is **not** supported headless — the save
  path reads model `Poses` produced by the (neutered) draw pipeline. Full
  save/load round-trip is production host scope (KD-067).
- The shim layer tracks the bundle's PIXI/DOM surface as of this build; it must be
  updated as the game's rendering surface changes.
