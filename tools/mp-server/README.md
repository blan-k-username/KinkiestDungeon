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
| `integration.js` | `IntegratedSession` (extends `Lobby`) — **real in-game integration**: players injected as real KD entities, enemy AI attacks routed to the target's instance, world-adjudicated P2P, independent params. KD-082. |
| `kd-absent-reset.js` | The "absent from the bundle ⇒ back to its default" rule, exported as source text for both runtimes. The capture only records a global while it DIFFERS from the post-init baseline, so a global returning to its default drops OUT of the bundle; the host already reset those, the browser did not. Served to the client at `/mp/kd-absent-reset.js`. |
| `transport/` | Transport boundary (KD-081): `protocol.js` (commands + `dispatch`), `in-process.js`, `worker-thread.js` (+`worker-entry.js`), `socket.js` (+`child-entry.js`), `index.js` (registry). |
| `TRANSPORTS.md` | Measured comparison of the three transports (pros/cons + game-code-change count). |
| `demo.js` | **Capstone** (KD-075) — one scripted end-to-end run touching every pillar (lobby + shared world + reacting enemy + routed PvP + server mod + independent params), printing a human-readable report. |
| `smoke-boot.js` / `bench-transports.js` | Manual smoke driver / transport benchmark. |

## How it works

- **Isolation:** each instance gets its own V8 context, so every KD `let`/`const`
  global (e.g. `KinkyDungeonCurrentTick`) is private. This is what allows three
  live instances in one Node process.
- **Bridge:** KD globals are top-level `let` (script scope, not on the global
  object). `__KDEVAL` is appended to the same script as the bundle so its closure
  can read/write them — the Node analogue of Playwright's `page.evaluate`.
- **No source edits:** rendering is neutered and `serverMode` is implemented by
  reassigning KD's globals at runtime (`DrawCharacter`, `KinkyDungeonUpdateEnemies`,
  `KinkyDungeonMove`) — the same reassignable-global mechanism the mod system uses.
- **Client script load order is GUARANTEED — never poll for a bundle global (KDM-229).**
  `index.html` loads the compiled bundle as a plain synchronous `<script src="./out/main.js">`, and
  `demo-server.js` injects everything in its `INJECT` list immediately before `</body>`. A classic
  script's top-level `let` is initialised during that synchronous evaluation and lives in the global
  *lexical* environment, so any `client/*.js` may read `KDGameData`, `KDGetContextActions`, … by bare
  name at its own top level. Ordering *within* `INJECT` is likewise synchronous and guaranteed. The
  one thing that is genuinely async is asset preloading (`KDLoadingFinished`), which is why
  `coop-bootstrap.js` `boot()` still retries — that is a wait on an event with no callback, not a
  load-order poll.
- **Contested tiles (KDM-208):** a turn applies players in random order, so two players
  aiming at the same empty tile resolve first-come. The loser does NOT get blocked by
  KD's collision — under PvP the peer is armed as a real hostile enemy, so the move
  would be promoted to a stock bump-attack. `HeadlessHost.setBumpVeto` therefore vetoes
  the move-bump against any avatar that *arrived during this turn*, keyed on where
  everyone stood at turn start. A peer who was already there stays fully attackable, so
  deliberate PvP is unchanged. Cancellations are reported via `cancelledMoveReport()`.

## Run

All commands run **inside Docker** (per project rules — no host runtimes).

```bash
# Manual smoke (one instance)
docker run --rm -v "$PWD":/usr/src/app -w /usr/src/app node:23-slim \
  node -e "setTimeout(()=>process.exit(2),120000).unref(); require('./tools/mp-server/smoke-boot.js')"

# Capstone end-to-end demo (prints the full report → '✓ CAPSTONE OK')
docker run --rm -v "$PWD":/usr/src/app -w /usr/src/app node:23-slim \
  node -e "setTimeout(()=>process.exit(2),200000).unref(); require('./tools/mp-server/demo.js')"

# Automated tests (node-layer Vitest, no Chromium)
tools/run-tests.sh unit     # includes the full mp-*.spec.ts suite (host, transport, lobby, integration, capstone)
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

## Real in-game integration (KD-082)

The earlier pillars were *synthetic* — the reconciler copied `{x,y,hp}` values, "PvP" was the harness
reaching into B, and the enemy only moved toward a coordinate. `integration.js` proves the **real**
gameplay integration, still with **zero game-source edits** (avatars use a runtime-pushed enemy def,
mod-style):

- **Players as real entities** — each player is injected into the world and into every other player's
  instance as a real KD entity (`KDAddNewEntity`, an ally-faction `RemotePlayer` avatar). The engine
  sees it for vision/targeting/collision (`KinkyDungeonEntityAt` finds it). Each player remains the
  **global player of their own instance**, where real stats/damage/restraints live.
- **Enemy AI attacks players (routed)** — the world's global player is parked off-field; the world
  enemy's own AI then **targets the nearest avatar** (`KinkyDungeonNearestPlayer` decoy targeting),
  pathfinds to it and attacks. The reconciler reads `enemy.target`, maps it to the player, and
  **routes the hit into that player's instance** (real `KinkyDungeonDealDamage`); other players are
  untouched.
- **World-adjudicated P2P** — `routedPvp(A,B,effect)` is authorized by the **world** (checks the two
  avatar entities are adjacent) and only then applied in B's instance; a non-adjacent attempt is
  rejected. A is never affected.
- **Independent params** — `getParams()` snapshots ~20 per-player globals (vitals, position, level,
  gold, inventory, perks, restraints, seed); two instances diverge where acted on and agree on the
  shared seed.

Tests: `tests/unit/mp-integration.spec.ts`. Feasibility was confirmed by a spike first (enemy
genuinely targets + damages an injected avatar; routed hit lands on the global player of a separate
instance).

## Helping a peer out of bondage

KD has two bondage models and nothing that bridges them: an NPC carries a bind LEVEL (`boundLevel`,
what `KDUntieEnemy` decrements), a player wears restraint ITEMS with `struggleProgress`. In single
player nobody ever unties the player, so the bridge never had to exist. Both directions now work
against a peer avatar:

- **Tie** (KD-101) — restraints an attacker puts on an avatar are mirrored onto the victim's own
  player via the stock `KinkyDungeonAddRestraint`.
- **Untie** — a peer's bondage is mirrored onto their avatar for **every** peer, at war or not
  (`_mirrorPeerBondage`), which is what makes the ally dialogue's `Untie` option appear at all: it is
  gated on `KDGetPlayerUntieBindAmt(enemy) > 0`, and an unmirrored avatar returned `NaN`. The untie
  is then TAKEN FROM THE CALL by `installPeerUntieRecorder` — never read as a bind-level delta, because
  a bound avatar sheds level on its own each turn and every quiet turn read as an untie — and spent by
  `untieRestraints` on the victim's real restraints through the stock `KinkyDungeonRemoveRestraint`,
  with the untier passed as `Remover`.
- **Denominated in bondage power** (`KDRestraint().power`), the one unit both models already share, so
  no third scale is invented between them.
- **Protected bondage is not an ally's to remove** — locked and cursed items are skipped, mirroring
  KD's own untie being documented "not including protected bondage".
- Mirroring bondage in co-op also switches on KD's own rules about a bound *helper*: a peer past
  `KDBoundEffects > 3` stops granting ally-help while you struggle. That is the game's answer, not ours.

Tests: `tests/unit/mp-coop-untie.spec.ts` (incl. an end-to-end pass driven through the real
`kdType: 'dialogue'` input, plus a same-shape control for each assertion) and
`tests/e2e/mp-coop-untie.spec.ts` (TWO BROWSERS: the real context menu → `Talk` → `Untie`, with the
restraint's disappearance read off the *victim's own page*).

Two things the e2e pins that are easy to get wrong if you touch this flow:

- **At war there is no dialogue to open.** Both player routes to an ally dialogue — the bump
  (`KinkyDungeonGame.ts:2699`) and the context menu (`KDContextMenu.ts:173`) — gate on
  `KDTalkToEnemy` *before* a dialogue exists, so that is the layer to assert on, not
  `KDGetPlayerUntieBindAmt`. Bondage stays mirrored at war, so the budget is non-zero either way:
  it is hostility that refuses, not an empty target.
- **"No unresolved text keys" must be asserted on what is PAINTED, not on what `TextGet` resolves.**
  `KDGetItemName` (`KinkyDungeonRestraints.ts:7118`) resolves `"KinkyDungeonInventoryItem" + name`
  and then overwrites it with the correct `"Restraint" + name` key, so every frame showing a worn
  restraint resolves a key that does not exist and throws the result away. A `TextGet` recorder reds
  on that stock noise. `recordDrawnText` (`tests/e2e/helpers/coop.ts`) wraps `DrawTextVisKD`
  (`KinkyDungeonDraw.ts:3405`) — the single choke point all KD text funnels through — so it sees only
  what a player could actually read.

## Known limitations (PoC)

- Full `KinkyDungeonGenerateSaveData()` is **not** supported headless — the save
  path reads model `Poses` produced by the (neutered) draw pipeline. Full
  save/load round-trip is production host scope (KD-067).
- The shim layer tracks the bundle's PIXI/DOM surface as of this build; it must be
  updated as the game's rendering surface changes.
- **Untying a peer wearing only locked or cursed gear spends the turn and frees nothing.** Protected
  bondage still counts toward the amount KD offers to untie. KD's own answer is `helpImmune`, which
  `KDGetPlayerUntieBindAmt` subtracts — but no stock `KDSpecialBondage` type sets it, so using it would
  mean inventing a `specialBoundLevel` key, and an invented key crashes the client outright
  (`KDSpecialBondage[key]` is indexed unguarded on the draw path — see `setAvatarBondage`). A wasted
  click is the smaller cost. The safe polish, if wanted, is a message to the untier, not a new channel.

## Bundle-patch policy (KDM-166)

`demo-server.js` rewrites the compiled bundle on the way out (`BUNDLE_PATCHES`) to guard genuine
**upstream** crashes. This is the **last resort** in the plugin rule's preference order — runtime
wrapping > stock API/data selection > serve-time text rewrite — and it is deliberately not
open-ended. A patch table with no expiry only grows.

**Before adding an entry**

1. Prove the bug is upstream's, not ours (diff the file against `upstream/<version>`; if our own code
   is what reaches the bad state, fix that instead).
2. Try the two cheaper options first. Text coupling breaks silently on an upstream bump.
3. Decide whether the bug *should* be swallowed. Guarding a genuinely-missing value can push
   `undefined` downstream and hide a real defect — that is why the 14 `sg.group` sites are **not**
   patched. Real state beats text coupling.

**Every entry must carry**

| Field | Meaning |
|---|---|
| `id` | stable handle a verdict is reported against |
| `find` / `repl` | the rewrite — `split`/`join`, so it must be **idempotent** |
| `sites` | expected match count in `out/main.js` |
| `repro` | how a human reaches the crash this entry prevents |
| `upstream` | `unfiled: tools/mp-server/UPSTREAM_ISSUES.md` — the local write-up of whose bug it is (an issue URL instead, if one was ever filed) |
| `removeWhen` | the condition under which this entry MUST be deleted |

`validateBundlePatchPolicy()` enforces the shape at boot (loud console line) and in
`tests/unit/mp-bundle-patch-policy.spec.ts` (hard assertion), so an entry cannot be added without
the metadata that makes it retirable.

**Every entry has an expiry.** `auditBundlePatches(js)` counts each entry's sites in the real bundle
and returns a verdict:

| Verdict | Meaning | What to do |
|---|---|---|
| `ok` | expected site count found | nothing |
| `stale` | some other non-zero count | our number is wrong — we may be missing a site |
| `delete-me` | **zero** sites | upstream fixed it (or the emitted text changed shape). The entry is dead code — **delete it**, along with its docs and its row in `UPSTREAM_ISSUES.md` |

Both `stale` and `delete-me` fail the policy spec and print at bundle-serve time. That failing test
*is* the expiry: it is what tells you an upstream bump retired a workaround.

**Writing the report is part of adding the patch.** Never fix the bug in the game tree — write it up in
`UPSTREAM_ISSUES.md` (repro, why it is upstream's, the one-line fix) and point the entry's `upstream:`
field at that file. The report stays **local**: publishing it on the upstream tracker is the owner's
call, not a step of this workflow. If one is ever filed, replace the `unfiled:` marker with the URL.
