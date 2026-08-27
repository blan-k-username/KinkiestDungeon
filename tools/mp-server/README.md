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
| `kd-journey-choice.js` | KDM-263 — the routed journey choice, as source text for both runtimes: a `KDRenderJourneyMap` wrap that reverts KD's inline `JourneyTarget` write and re-emits it as `KDSendInput('KDCoopJourney', {x,y})`, plus the `KDInputTypes` entry that dispatches it server-side. Served to the client at `/mp/kd-journey-choice.js`. |
| `kd-shop-buy.js` | KDM-264 — buying by identity: a client wrap that tags a routed `shrineBuy` with the item that browser was showing, and a server-side `KDInputTypes.shrineBuy` wrap that re-finds it in the shared stock (or refuses). Served at `/mp/kd-shop-buy.js`. |
| `transport/` | Transport boundary (KD-081): `protocol.js` (commands + `dispatch`), `in-process.js`, `worker-thread.js` (+`worker-entry.js`), `socket.js` (+`child-entry.js`), `index.js` (registry). |
| `mod-sync.js` | KDM-249 — reconciling two mod sets: `diffDeclarations` (pure) + an in-memory, content-addressed `ModStore` for the payloads. No socket, no world, no game globals. |
| `client/coop-mods.js` | KDM-249 — the browser half of mod sync: latches `KDGetMods` before the first frame, declares/publishes/fetches, then drives `KDExecuteMods`. See "Mod sync" below. |
| `client/coop-chat.js` | KDM-246/247 — **the co-op talk surface**: every way a player sends a chat message. `Y` opens a text field, `U` opens a quick-emoji picker whose digits `1`–`8` send a reaction (recents first, seeded on a first run, remembered in `localStorage`). Both build the same `{mp:'chat.say', text}`; the server renders it into every player's log under the `Chat` filter. ⚠️ Its keys come from **`KDKeyCheckers`**, not from the buttons' `hotkeyPress` — see "Client hotkeys" below. |
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

- **Saves work in BOTH directions, and neither is a limitation any more.** This entry used to say
  headless save *generation* was unsupported; that was wrong from KDM-160 onwards and it made KDM-244
  look far harder than it was, so the correction is recorded rather than quietly deleted.
  - **Loading** (SP → MP, KDM-243): `HeadlessHost.loadSave(str)` drives KD's own
    `KinkyDungeonLoadGame` on the compressed-base64 string the browser keeps in
    `localStorage.KinkyDungeonSave`, restoring floor, map, entities, gear and inventory intact. A host
    can continue an existing single-player run in co-op; the guest brings only a character.
  - **Generating** (MP → SP, KDM-244): `HeadlessHost.exportSave(excludeIds)` calls
    `KinkyDungeonGenerateSaveData()` and hands back the same compressed-base64 form. `saveOf()` has
    done the same thing since KDM-160 and three unit specs depend on it.
  - Both have the **same single precondition**, `_seedHeadlessModel()`: KD reads and writes
    `KDCurrentModels.get(KinkyDungeonPlayer).Poses` with no null guard, through a paper-doll container
    `_neuterRendering` deliberately never builds.
  - ⚠️ **An export MUST strip the peer avatars, or the save cannot be opened.** Not tidiness:
    `KDUnPackEnemies` re-resolves entity defs by name, the `RemotePlayer_*` defs are created at
    runtime and are not in the save, and the first reader of the resulting `undefined` throws (see
    `UPSTREAM_ISSUES.md` → `KinkyDungeonVision.ts:158`). `exportSave` does this; anything else
    generating a save for a player to keep must too.
  - **The run saves itself, on KD's own cadence** (KDM-275). The export no longer fires only at the
    two explicit moments KDM-244 built (the context-menu entry, and "go on alone") — because none of
    those happen when the server process stops, which is what actually destroys a co-op run. The
    trigger now mirrors what the stock game promises the player on its own settings screen:

    | Host's save mode | On every floor transition | On a timer |
    |---|---|---|
    | **Save Codes** (KD's default) | yes | no |
    | **Roguelike** | yes | yes, every `exportEveryTurns` turns (default 50, from KD's own `wt`) |

    `SwapSession._onMapChanged` arms the flag and `_advanceTurn` hands it back; `WSBridge._turnResolved`
    does the sending, to `gate.host` and nobody else. The session **arms, never sends** — the detector
    runs mid-iteration over the party with another player in the slot, and `exportRun` swaps the slot.
    `saveMode` is read from the world, where `game-modes.js` already classifies it as a world key.
    An export measures **~55 ms**, i.e. less than one lockstep turn, so the floor trigger disappears
    inside the map-generation stall.
  - Automatic saves are **quiet on success and loud on failure**; the host reads "saved N min ago" off
    the context-menu entry rather than being toasted every floor. `KDSaveQueue`'s replication
    blacklist and `_neuterAutosave` are untouched by all of this — the export is an explicit, one-shot
    transfer on its own channel, never generic replication of save state.
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

## Hosting and joining (KDM-233)

Entry is no longer only `#coop=<id>`. The main menu has a **Multiplayer** entry, and a friend joins by
typing the host's LAN address — there is no join code and no account: **the host approves each join**.

```
node tools/mp-server/demo-server.js    # game + co-op gateway on one port (PORT=… to move it)
./run-kd-game.sh --mp                  # the same, in docker, for UAT — from the kd-mods-src sibling
```

There is exactly one launcher script, and it lives in the `kd-mods-src` sibling repo (KDM-255). A
second one here (`tools/coop-demo.sh`) used to do the same job with a different image, a different
build step and a different set of forwarded environment variables — which is how `KD_PVP=1` came to
start a session with PvP off and say nothing. `./run-kd-game.sh --mp` forwards every variable this
server reads, and `tools/check-launcher-env.sh` over there fails a commit that adds one without it.
For this checkout on its own, the `node` line above is the whole thing.

Co-op is opt-in: run the plain static server (`npm run serve`) and nothing listens for co-op at all.

**The pieces**

| File | What it owns |
|---|---|
| `join-gate.js` | Membership: two seats (host = slot 0, guest = slot 1) and the one unanswered question. Pure — no socket, no world. Unit-tested in ms (`tests/unit/mp-join-gate.spec.ts`). |
| `ws-bridge.js` | Carries answers between the gate and the sockets: `join{role}` → `join_pending` → `join_answer` → `joined`. |
| `client/coop-lobby.js` | The menu entry, the host/join screens and the name field, as a wrap of `KinkyDungeonRun`. |
| `client/coop-bootstrap.js` | The socket and the storage: `__coopConnect({role, address, name})`, `__coopAnswerJoin(accept)`, `__coopDisconnect()`, `__coopLastAddress()`. |

**Rules worth not re-deriving**

- **A pending requester holds no seat.** `guest` is only written by `accept()`, so a declined or
  dropped requester cannot block the next friend.
- **One question at a time.** A second requester is refused `busy`, never queued — queueing would let
  the host answer a dialogue about Ada and admit Bob.
- **Refuse in words, after the upgrade.** A browser cannot read an HTTP upgrade rejection (it surfaces
  only as close 1006, no status or body), so `_reject()` accepts the upgrade, sends
  `{type:'reject', reason}`, then closes. Rejecting pre-upgrade leaves the join screen with nothing to
  show. (Lesson carried from `origin/feature/multiplayer`'s `tools/mp-server.js:286-293`.)
- **Build skew is refused before the host is prompted.** The guest runs its own bundle copy, so a
  differing `KDVersionStr` would desync. The **host's** build defines the session — `claimHost` adopts
  it — so nothing has to be configured. A *missing* build counts as a mismatch, not a wildcard; if
  nobody knows the build the check stands down, and `buildCheckActive()` makes that visible.
- **Connecting is not entering the game.** `enterGame()` waits for asset loading; the handshake does
  not. Putting that wait in front of the socket makes the guest's join never leave the page.
- **The menu entry needs no game-tree edit** — see `client/coop-lobby.js`'s header for why
  (`KDButtonsCache` is per-frame data; `_prev` must be called first).

### Client hotkeys: use `KDKeyCheckers`, never a button's `hotkeyPress` (KDM-247)

A drawn button carrying `{hotkey, hotkeyPress}` earns a keyboard shortcut **for KD's own buttons**.
It does **not** work for a button one of our injected client files draws, and the reason is timing,
not correctness of the declaration:

- `KDCheckCustomKeypress` (`KinkyDungeonGame.ts:2258`) matches the pressed key against
  **`KDButtonsCache`**, and that cache is wiped and refilled every frame
  (`KinkyDungeon.ts:1668-1669`).
- Our draw hangs off `KinkyDungeonDrawGame`, which runs **later in the frame than the key pump**. So
  our buttons are reliably absent from the cache at the moment it is read.

Measured on a live co-op page by probing inside `KDCheckCustomKeypress` itself, with the picker open
and all ten of its buttons present in the cache when read between frames:

```
{ seenKeys: ["1"], customKeypress: 1, oursAtMatch: [], hotkeysAtMatch: [ …KD's own… ] }
```

**This shipped broken once already:** chat's `Y` hotkey (KDM-246) never worked, and no test saw it
because the e2e opened the field through `KDCoopChat.open()` instead of pressing the key.

Use **`KDKeyCheckers`** (`KinkyDungeonGame.ts:4183`) instead — KD's own registry of `() => boolean`
checkers, run by `KDCheckCustomKeypress` *after* the button loop:

- no draw-order dependency, so this defect cannot recur;
- running after the button loop means we can never steal a key from one of the game's own buttons;
- it is a plain object, so registering is an **idempotent property assignment** — safe across the
  reconnect re-eval, with no `addOnce` needed;
- returning falsy falls through to KD's normal handling, so a key is only ours while we want it.

Gate the checker on `KinkyDungeonState`/`KinkyDungeonDrawState` being `Game` (as KD's own checkers
do) and wrap it in its own try/catch: it runs on **every keypress in the game**, so a throw there
takes the player's movement with it. Keep `hotkey`/`hotkeyPress` on the button — it still labels the
key and is still the mouse route — but never rely on it for the keyboard.

**And test the key by pressing it.** Asserting that a button carries the right `hotkeyPress` in the
right positional slot is not evidence that the key does anything; only an e2e that presses it is.

### One thing for the human eye: emoji glyphs (KDM-247)

The quick-emoji picker's oracles read **log data and call counts, never pixels** — deliberately. KD
renders text as `PIXI.Text` through the browser's font stack (`KinkyDungeonDraw.ts:3428-3450`), and
the Docker test images may carry no colour-emoji font, so a glyph assertion would red on the
harness's fonts rather than on the feature. **Whether the emoji actually render is therefore a UAT
question, not a suite question** — check it once under `./run-kd-game.sh --mp`. If they come out as
tofu boxes on a real player's machine, the fix is the seed set (swap to glyphs with wider coverage),
not the pipeline.
- **The bootstrap owns the socket and the storage; the lobby only asks.** `coop-lobby.js` draws
  screens and calls `__coopConnect` / `__coopAnswerJoin` / `__coopDisconnect` / `__coopLastAddress`;
  `lobbySay()` is the single channel back. A key string or a socket decision placed in the lobby
  immediately exists in two files.
- **A join can hang with neither `open` nor `error`.** A peer that accepts the TCP connection and
  never finishes the WebSocket handshake leaves the socket in `readyState 0` indefinitely — a browser
  reports nothing, and no layer below can see it. Hence `armConnectDeadline`
  (`window.__coopConnectTimeoutMs`, default 10 s), armed **only while `!coop.started`**: a live
  session that drops belongs to `scheduleReconnect`, and a deadline there would turn a recoverable
  outage into an error screen.
- **`ws !== myWs` is the whole stale-reply guard.** `connect()` captures its own socket and every
  handler returns early if it is no longer the current one. That covers both a socket the player
  walked away from (`__coopDisconnect` nulls `ws`) and one a reconnect superseded. Without it, a
  host's late Accept drags a guest who already left the lobby into the game.
- **An address is remembered on `onopen`, never on submit.** That is the only moment proving the far
  end was listening; remembering at send time offers the player their own typo back forever.
  `localStorage` (per machine) — deliberately unlike the per-tab `sessionStorage` holding
  `kdcoop.clientId`, which must differ between two tabs because two tabs are two players.
- **Every way out of the lobby goes through `lobby.leave()`**, including the root Back — which is
  reachable with a host socket still open, via Host → Cancel → Back.

- **A player's NAME lives on the SEAT, and only a chosen one is written.** `JoinGate.names` is keyed
  by clientId and survives `releasePending` but not `release` — the same asymmetry that holds a seat
  across a drop (KDM-252 E4), which is what makes a reconnecting player come back as themselves.
  `sanitizeName()` (exported, char-code scan not a regex) is the single N4 enforcement point.
  `SwapSession.displayNameOf()` is the single fallback, and it answers in three tiers (KDM-282):
  the chosen name, else the **seat** (`Player 1` for the host, `Player 2` for the guest, via the
  `KD_SEAT_LABEL` table), else the legacy `Player <clientId>`. The third tier is reached only by a
  session nobody told a role — every direct-constructed `SwapSession` in the unit suite — which is
  what keeps NF2's byte-identical promise where it was ever load-bearing. Ids are opaque random
  strings (KDM-280), so before the seat tier an unnamed player read as `Player kd-x8f2q1`.
  ⚠️ `setSeatRole` **clears** on any role not in the table, so an unrecognised protocol token
  degrades to the legacy label instead of being painted onto an avatar.
  ⚠️ The avatar LABEL falls back; the player's own `KDGameData.PlayerName` does **not** — an unnamed
  player keeps KD's default `'Ada'`. Stamping `'Player A'` there made a 1-player session diverge from
  a reference single-player run (`mp-parity-oracle` caught it). The two fields answer different
  questions: one is what your partner sees over your head, the other is your character's own name.
- **`presence.seat()` must run BEFORE `_carrySeat()`, at every seating site.** `_carrySeat` reads
  `presence.roleOf` (KDM-282), so a site that carries first hands the session a seatless player. The
  accept path did exactly that and it cost nothing for two tasks — right up until `_carrySeat` grew a
  second source. The symptom was asymmetric and quiet: the host read `Player 1` and the approved
  guest read `Player <raw-id>`. ⚠️ The fix is to make the sites **agree**, never to pass the role in
  as an argument — that would put the source-of-truth lookup back at each call site, which is the
  duplication `_carrySeat` exists to remove.
- **`setPlayerName` must sit BETWEEN the template restore and the capture** in `_seatPlayer`.
  `capturePlayer()` snapshots `KDGameData`, and `PlayerName` is deliberately absent from
  `KDGAMEDATA_WORLD_KEYS`, so that ordering is the entire per-player replication story. Set it after
  and the name lands on whoever is restored into the slot next.
- **The lobby caches the name field rather than reading the DOM on demand.** `KDCullTempElements`
  destroys any field not drawn this frame, and `KDMPHost` connects from the ROOT view — so a read at
  press time finds nothing. `lobby.name` is what lets one `drawNameField()` serve both views. The
  seed field (KDM-259) is the same widget for the same reason — both go through `drawField()`.
- **The host names the run's SEED in the lobby** (KDM-259), beside their own name and on the same
  root view, because `KDMPHost` connects straight from there and the world declaration is read at ask
  time. It rides `__coopConnect({role:'host', seed})` → `worldSeed()` → `join.world.seed`, and the
  server prefers it over its own (`swap-session.js`: `hostWorld.seed || this.seed`). ⚠️ **Empty means
  "the server's own seed", not "an empty seed"** — never substitute a default in the client, which
  does not know what the server was configured with.
- **KD answers a missing text key with `"[NotFound] <key>"`, not with nothing.** `coop-lobby.js`
  guarded its fallback with `t !== key`, which that marker passes, so every lobby label painted the
  marker at the player until KDM-259. One `kdText()` now owns the "does KD have a word for this?"
  question; `tests/e2e/mp-lobby-seed.spec.ts` asserts no marker ever reaches the screen.

**Not done here:** per-player character CREATION — appearance, outfit, class, pronouns (KDM-256);
names themselves landed in KDM-237. The legacy `#coop=` path still joins directly, bypassing the
gate, so two entry paths exist until **KDM-255** converges them — that path is also what keeps the MP
e2e suite green, which is why retiring it is its own task.

## Mod sync (KDM-249)

**The host is the source of truth for mods.** Gameplay-only mods already worked by construction — the
host's headless world runs the simulation and the guest never simulates. Presentation mods (art, text
keys, draw wraps, names) did not: the guest renders locally from snapshots, so a modded entity arriving
in a snapshot is drawn by the *guest's* bundle, and a guest without the mod sees missing sprites.

### The thing to know before touching this

KD executes mods from exactly **one** place — `KDExecuteModsAndStart()` on the main-menu buttons
(`KinkyDungeon.ts:1891`) — plus a per-frame auto-load gated on `KDToggles.AutoLoadMods`, which
**defaults to `false`** (`KinkyDungeonVibe.ts:145`). The co-op client reaches neither: it calls
`KinkyDungeonStartNewGame(false)` directly. Before KDM-249, a co-op player on default settings got
**none of their own mods**.

`KDExecuted` is also a **one-shot latch** (`KDMods.ts:350-351`), so mods can be executed at most once
per page load. The fix does not fight that; it borrows KD's *other* flag:

1. `client/coop-mods.js` is injected before `out/main.js` has had a frame, and sets **`KDGetMods = true`**
   (`KDMods.ts:9`) — KD's own "the auto-loader has been handled" flag. KD stands down, `KDExecuted`
   stays `false`, and the timing is ours.
2. At session start (`enterGame()`, the co-op Play button) it loads, optionally fetches, and executes —
   guest mods and host mods together in **one priority-ordered pass**.

`KDGetMods = true` is a **bare assignment**: bundle `let`-globals are not on `globalThis`, so
`globalThis.KDGetMods = true` would latch nothing. That makes the `INJECT` order load-bearing (the tag
must come after `out/main.js`, or it is a TDZ throw); pinned by `tests/unit/mp-mod-inject-order.spec.ts`.

### The wire

| Where | Carries |
|---|---|
| `join` | `mods` — this client's declaration: `{name, modname, modbuild, priority, hash}` per zip |
| `mods_declare` | a host re-stating its set after publishing (mods picked *just before* hosting) |
| `awaiting_approval` / `join_pending` | `modDiff` — `{hostOnly, guestOnly, conflict}`, to both sides |
| `POST /mp/mods/<hash>` | host uploads a zip |
| `GET /mp/mods/<hash>` | guest fetches one |
| `GET /mp/mods/manifest` | the session (= host's) declaration |

**Identity is the content hash, never the filename.** Two players may hold one mod under two names, or
two builds under one name. `conflict` is a strict *subset* of `hostOnly` — the host's copy wins, and a
caller iterating `hostOnly` to decide what to download needs no second loop.

**A mod difference never refuses a join.** A build mismatch cannot work and is refused (KDM-233 N1); a
mod difference only degrades presentation, and the remedy is to *ship the files* — unreachable if the
join was refused. Mutation-tested, because breaking this makes the whole feature unreachable.

### Rules that are easy to break

- **Absent is not satisfied.** A peer declaring no mods needs *everything*. Reading absence as "nothing
  to do" is how a guest ends up silently mod-less.
- **The mod routes must be matched before the static handler.** `serveStatic` maps leftovers onto the
  repo via `safeJoin`, and `/mp/mods/../../package.json` normalises back *inside* the root — so a mod
  fetch would be answered with a repo file.
- **Nothing on this path may call `batchSaveMods`** (`KDModsUtils.ts:13`). It is the file picker's alone,
  and it is what keeps session mods out of the guest's own library.
- **Payloads are in memory only.** A restarted gateway holds nothing and re-asks the host, which is the
  right answer to "whose mods are these".
- **The host's declaration is not memoised.** A player picks mods from the Mods menu and *then* hosts;
  a set computed once at page load would silently mean "this session has no mods".
- **Every path must reach a terminal status.** `KDExecuteMods` swallows per-file errors into
  `console.log`, so a watchdog settles the status without awaiting the game's async — otherwise a hung
  mod loader wedges the session.

### Testing

`tests/unit/mp-mod-{sync,gate,routes,inject-order}.spec.ts` (fast, no browser) and
`tests/e2e/mp-mod-{local-exec,sync-guest}.spec.ts`.

⚠️ **Any e2e that needs the session to actually START must pass `{preload: true}`** to
`openLobby`/`guestAsks`. Two boot-sequence traps make the alternative look like a product bug — see the
comments in `tests/helpers/mp-lobby.ts`.

## Game modes and the start ritual (KDM-239)

### The one thing to know before touching this

**`KinkyDungeonStatsChoice` does two jobs, and only one of them is perks.**

KD's Diff screen funnels every game-mode toggle through `KDUpdatePlugSettings`
(`Game/src/base/KinkyDungeon.ts:6114`) into that same Map — 22 keys, from `randomMode` to `classMode`.
None of them is in `KinkyDungeonStatsPresets`, so KD's perk table answers "no" for every one.

That matters because `HeadlessHost.applyPerks` rebuilds the Map from scratch and re-adds a key only
`if (KinkyDungeonStatsPresets[k])`. So:

- handing a mode key to `applyPerks` **drops it silently** — no error, just KD's defaults; and
- every mode the world was built with is **wiped from the slot by the first `_seatPlayer`**.

Hence a separate applier. `statsChoiceSnapshot()` captures the whole Map right after `init()`, split
into the half `applyPerks` preserves and the half it destroys; `_seatPlayer` applies the base perks
UNION the player's own, then restores the mode half with `applyModes`.

### ⚠️ Modes keep their value, including `undefined`

`KDUpdatePlugSettings` writes `set(key, undefined)` for every mode that is **off**. The key is
therefore PRESENT in the Map with an undefined value — 20 of the 24 entries in a default new game —
and the save serialiser sees it. Capturing only truthy entries leaves a seat holding 4 keys against a
single-player run's 24. `null` encodes `undefined` across the eval boundary, because
`JSON.stringify` drops the property otherwise.

**`mp-parity-oracle` is what enforces all of this**, and it rejected three successive wrong versions
of the restore before the right one. If you change `_seatPlayer`, that spec is your oracle — do not
"fix" it.

### World vs player

`game-modes.js` classifies all 22 keys. World keys come from the HOST once (on its `join`, validated
by `sanitizeWorld`) and are re-applied to every seat; player keys ride KDM-238's per-player channel.
A guest's world declaration is **dropped at the gate** — one host, no silent blending.

`MODE_SOURCE` maps each world key to the source global `KDUpdatePlugSettings` derives it from, and is
served to the browser as `GAME_MODES_BROWSER` on the `kd-delta.js` precedent, so the client's read
and the server's write cannot drift.

**Write those globals with BARE assignments.** They are bundle-scope `let`s, so
`globalThis[name] = value` creates a shadow property and KD's own bare-name reads never see it.

### The start ritual

`init()` runs what the stock start buttons run around `KinkyDungeonStartNewGame`
(`KinkyDungeon.ts:2553`, `:2875`): `KDLose = false` and `KDUpdatePlugSettings` before,
`KDAddListener("SpeciesChecker")` after.

**The tutorial is suppressed for both players, on purpose** (owner, 2026-08-24) — it is a blocking
dialogue in a lockstep session, and the guest cannot dismiss the host's copy. This is the one place
co-op knowingly diverges from the stock start; the reason is recorded at the call site.

### The screen is the session's, not the client's

`pinGameScreen` no longer stamps `KinkyDungeonState = 'Game'`. It adopts `coop.screen`, read in
`resolveState` (the single funnel every state frame passes through) and carried on the snapshot.

**KDM-258's guard stays**: `KinkyDungeonContext` is null until `KDInitCanvas()`, and pinning a screen
before that stops the render loop for good — one frozen frame for the rest of the session. The draw's
own `if (KinkyDungeonCanvas)` test does not protect you; that value is a module-scope
`createElement("canvas")` and is always truthy.

## Adding a field to the join handshake (KDM-260)

**Add it to a shape in `ws-bridge.js`. Do not add it to a call site.**

```js
const HOST_JOIN_FIELDS  = Object.freeze(['name', 'build', 'mods', 'perks', 'world']);
const GUEST_JOIN_FIELDS = Object.freeze(['name', 'build', 'mods', 'perks']);
```

Both `join` branches forward with `pickFields(msg, <shape>)`, so the shape IS the forwarding.

### Why this is not a hand-written literal any more

It used to be `{ name: msg.name, build: msg.build, mods: msg.mods, perks: msg.perks }` at each site.
KDM-239 added `world` to the handshake and did not add it there, and **nothing caught it**: the gate
held an empty declaration, the session was built on KD's defaults, and all 605 unit tests stayed
green — because every one of them calls `claimHost`/`requestJoin` directly and never crosses the
bridge. Only an e2e asserting what reached the guest's *screen* found it.

`tests/unit/mp-join-fields.spec.ts` now reads the client's own `join.<field> =` assignments and fails
when one is not covered by a shape. It is mutation-tested, and its failure message names both
remedies (add to a shape, or to `ROUTING_FIELDS` if it is not a seat declaration).

### Three rules that are easy to break here

1. **The two shapes differ on purpose.** `world` is the host's alone (KDM-239 A5). "The gate is never
   even told" is stronger than "the gate drops it" — do not unify them with a runtime exception.
2. **`mods_declare` stays PARTIAL.** The third `claimHost` call site passes `{mods}` alone, because
   `claimHost` guards every field on `!== undefined` and a partial object must leave a seated host's
   name/perks/world untouched. Widening it to the host shape would let a post-publish message blank a
   declaration. There is a test asserting its keys are exactly `['mods']`.
3. **`pickFields` copies only keys that are PRESENT** (`in`, not `!== undefined`). Materialising every
   key as `undefined` collapses the gate's "said nothing" vs "said none" distinction — which the old
   literal actually did.

## Each player's own character (KDM-256)

A player picks a class and an outfit on **KD's own screens**, from the lobby's `Character` button.
What travels is a small `join.character` package — `{class, outfit, style}` — and it is applied to
that seat and no other.

### It is a per-seat MUTATION, not a template

`_seatPlayer` is a **restore → mutate → capture** window, and `applyCharacter` goes in it beside
`setPlayerName` (KDM-237) and `applyPerks` (KDM-238):

```js
if (template) this._restorePlayer(clientId, template);
if (!imported) { this.world.applyPerks(…); this.world.applyModes(…); }
if (chosen) this.world.setPlayerName(chosen);
if (!imported) { const pkg = this.characterOf(clientId); if (pkg) this.world.applyCharacter(pkg); }
this.bundles.set(clientId, this.world.capturePlayer());     // <- what makes it THIS player's
```

**⚠️ Do NOT put a character package in `_templateOf`.** That container is KDM-243's and answers a
different question — "this seat resumes an entire saved run". Its `imported` flag does DOUBLE DUTY:
it also means *skip every new-game operation*, because a character resumed at floor 9 must not be
handed a second starting collar by `KDInitPerks()`. Route a package through it and that player
silently loses their perks, their modes and their name, while still looking perfectly seated. If a
package ever genuinely needs its own template, split `imported` into `hasTemplate` and `isResumedRun`
first.

**⚠️ Order inside the window matters in exactly one place.** `applyPerks` runs KD's `KDInitPerks()`,
which rebuilds the slot's restraints, weapons and spell points — so it stays first, and anything
dressing the character comes after it.

### Who validates what

| Layer | Judges | Never judges |
|---|---|---|
| `join-gate.js` `sanitizeCharacter` | shape, type, length; refuses oversize outright | whether a value EXISTS |
| `headless-host.js` `applyCharacter` | `KDClassStart[class]`, `KDGetDressList()[outfit]` | — |

A list of outfit, style or class names in `tools/mp-server/**` is a gameplay table in the gateway —
epic AC2, and `mp-i6-no-gameplay-constants.spec.ts` fails the build on one. KD's own tables are the
whitelist, consulted in the layer that has a world to ask. An unknown value is carried politely and
applied never, **per field**: a typo in the class must not cost the player their outfit.

`KDGetDressList()[outfit]` is checked BEFORE calling `KinkyDungeonSetDress`, not caught after:
SetDress iterates that list unguarded (`KinkyDungeonDress.ts:109`), so an unknown name throws midway
and leaves the slot half-dressed.

### The peer's avatar

`style` and `outfit` were **already** in `ENT_FIELDS`, so the look crosses the wire for free. KD draws
an entity carrying `CustomName` and (`style` or `outfit`) as a full paper-doll NPC rather than a flat
sprite (`KinkyDungeonEnemies.ts:1042`), building the model from `KDModelStyles[style]` and dressing
it from `outfit` (`:11211-11237`). Per-player-safe because `spawnAvatar` already gives every avatar
its own `RemotePlayer_<label>` def clone. `'BlueHair'` remains the fallback, so an undeclared player
looks exactly as they always did.

### Borrowing a KD screen

`borrowButtons(active, names, commit)` in `coop-lobby.js` is the ONE implementation, shared by the
perk pick (`'Stats'`) and the character pick (`'Diff'`).

- It is **conditional**. Without the pick flag the stock buttons are left completely alone, or a solo
  player's start screen stops starting games. Both specs assert that pair from both sides.
- It is **all-or-nothing**. A half-borrowed screen is one where some buttons return to the lobby and
  others start a solo game.
- `'Diff'` needs **three** buttons taken back, not two — `startQuick`, `startGameKinky`, `startGame`
  all start a solo game. The Wardrobe beyond it needs none: its own back button returns to `'Diff'`.

### The testing lesson, stated once

A unit test that calls a collaborator **directly** cannot see a caller that forgets to forward a
field. When you add anything to the wire, add a test that crosses the dispatch — `_handle` with a
stubbed gate is cheap (no socket, no session, no boot) and is the layer where this class of bug lives.

## Asserting that a co-op player can SEE something (KDM-285 / KDM-286)

A co-op client is a real KD page, so "the state is right" and "the player can see it" are different
questions — and the gap between them hid a defect for a very long time. KDM-285's cause was ours:
`coop-bootstrap.js` → `ensureQuickBind()` armed `KinkyDungeonTargetingSpell` and no non-simulating
client ever clears one, so every co-op client sat in permanent spell-targeting mode from boot. Stock
KD deliberately suppresses a long list of HUD while you aim, so **ten** things were invisible to co-op
players on an otherwise stock build. Years of specs asserting `KinkyDungeonMessageLog` CONTENTS were
green throughout.

**The rule.** When a co-op feature is about something the player looks at, assert what was PAINTED,
not what is in a variable — and never assert a predicate that is derived from the same gate:
`KDDrawResourcesQuick()` is literally `return !KinkyDungeonTargetingSpell`, so asserting it and
asserting the gate are one assertion written twice.

**The two recorders**, both in `tests/e2e/helpers/coop.ts`, both wrapping the one choke point their
kind of drawing funnels into:

| what | wrap | probe (recorder-is-live control) |
|---|---|---|
| text | `recordDrawnText` → `DrawTextVisKD` | `paintMissingTextKey` |
| sprites | `recordDrawnSprites` → `KDDraw` | `drawProbeSprite` |

Three things to know before using the sprite one:

- **`calls` is the liveness control, and absence assertions are meaningless without it.** A dead
  wrap, a page that stopped painting and a genuinely-hidden icon all leave `sprites` empty.
- **`match` filters what is KEPT, never what is COUNTED.** `KDDraw` runs per tile per frame, so an
  unfiltered distinct-log truncates on map sprites before it reaches the HUD — and a silently
  truncated log is a green for the wrong reason.
- **`resetDrawnSprites` clears `seen` too**, because a HUD sprite is drawn in every frame of every
  window; a reset that kept it would report the gold readout missing in window two.

**And mutate the gate inside the spec.** `mp-coop-hud-visible.spec.ts` re-arms the targeting spell in
its own last phases and requires the icons to vanish. Without that, the positive assertions would be
green on the broken build too — which is exactly how the original defect survived.

⚠️ **Not everything KD hides while aiming is a paint.** The move helper (`KDToggles.Helper`) draws
nothing: it reaches the game as the argument of `KinkyDungeonSetTargetLocation(!KinkyDungeonTargetingSpell
&& KDToggles.Helper)` (`KinkyDungeonHUD.ts:276`) and snaps the aim off a wall. Its oracle is the
resulting `KinkyDungeonTargetX/Y`, driven through `KinkyDungeonHandleHUD()` — KD's own input entry
point, because the gate expression lives at the CALL SITE and a direct call steps over it.

## Adding an OUTBOUND message or field (KDM-274)

**Add it to `OUTBOUND_MESSAGES` in `ws-bridge.js`.** That table is the server→client half of the
same idea: one declaration per message kind, naming its `required` and `optional` fields and — where
it matters — who it may be addressed to.

```js
save_export: Object.freeze({ required: Object.freeze(['save', 'version', 'reason']), to: 'host' }),
```

`tests/unit/mp-outbound-fields.spec.ts` then holds you to four things, each of which fails on a drift
the others cannot see:

1. **SOURCE** — every `{ type: '…' }` the bridge puts on a socket is declared, with every key on it.
2. **LIVE** — every declared kind is actually *exercised* against a real `WSBridge` (stubbed session,
   recording sockets, no world boot), and each `required` field is on the **decoded wire object**.
   `JSON.stringify` drops a key whose value is `undefined`, so "the call site names it" and "it
   arrives" are genuinely different claims.
3. **CLIENT** — every `m.<field>` `coop-bootstrap.js` reads for a kind is declared for that kind:
   KDM-239 in reverse, a receiver depending on a field the sender quietly stopped sending.
4. **ADDRESSING** — `to: 'host'` is checked over *every* frame *every* socket received. A host-only
   payload reaching everybody is what a broadcast-written-where-a-unicast-was-meant looks like, and
   for `save_export` — the entire world as a save string — that is a disclosure bug.

### Why this exists at all

Until KDM-274, nothing watched this direction. A payload composed correctly and then **not sent**, or
sent to the wrong socket, left the whole suite green while the feature did nothing — because a
session-level test asserts on what a method *returned*, not on what left the socket. `save_export`
was guarded only by its own per-feature spec, which is exactly the pattern KDM-260 replaced on the
way in: it protects the field whose author thought of it and nothing else.

The COVERAGE assertion is the load-bearing one. A declaration nothing produces is a promise nobody
keeps, so a new kind must come with a way to reach it in the rig — and deleting a send turns red.

## Changing floor (KDM-240)

The party shares ONE world, one `KDMapData` and one `MiniGameKinkyDungeonLevel`, so any map change
moves everybody. Three things follow, all implemented rather than assumed:

- **The level goal is CO-LOCATED.** The stairs do not fire until every other seated player is on or
  adjacent to the stair tile, and never while a member is in `defeated`. Enforced through KD's own
  cancellation path — a `beforeStairCancel` handler that sets `data.cancelevent` plus a matching
  `KDCancelEvents` entry (`HeadlessHost.setPartyGate`) — never by intercepting `KinkyDungeonMove`, so
  walking *across* a stair tile is unaffected. It abstains on `data.force` (a leash-drag or the jail
  flow is not the party's choice), on an already-set `cancelevent`, and on an empty peer list, so a
  one-player session behaves exactly as it always did.
- **A map change is detected by the MAP, not by the level number.** `HeadlessHost.mapId()` is
  `level | RoomType | mapX | mapY`. A capture regenerates the map at an unchanged level and a hub→floor
  move changes only `RoomType`; a `getLevel()` comparison sees neither.
- **Everybody lands together.** On a detected change every seated player is re-placed on distinct free
  tiles around where KD put the arriving player (`landingTiles`), each is guaranteed a live avatar
  (`_ensureAvatar` — `moveAvatar` returns `null` for an entity a map regeneration destroyed), and the
  move is announced once to everyone.

**`setPartyGate` must be called inside each player's swap window**, after `restorePlayer`.
`KDEventMapGeneric` and `KDCancelEvents` are per-player bundle state, so a swap wipes the
registration; the "already installed?" sentinel therefore lives on those registries and not on
`globalThis`, which would survive the wipe and suppress re-installation forever.

**KD's own autosave is stubbed** (`_neuterAutosave`) — both `KinkyDungeonSaveGame` and
`KDPostStairSave`. `KinkyDungeonGenerateSaveData` reads model `Poses` off the paper doll
`_neuterRendering` deliberately never builds, so every automatic save threw: on *every* headless
floor change (after the new map was generated but before `KDGenMapCallback = null`), and on *every*
capture — `KinkyDungeonSaveGame()` is the last statement of `KinkyDungeonDefeat`, so a grabbed player
had the rest of their own input discarded and the session reported a normal turn (KDM-267).

Stubbing the save covers all 12 call sites; `KDPostStairSave` keeps its own stub because it does more
than save (on the PerkRoom floor it sets `KinkyDungeonState = "Save"` and builds a DOM textarea).
`KinkyDungeonGenerateSaveData` itself is untouched, so `saveOf()` and `_seedHeadlessModel` still work
as the test instruments they are — `saveOf` never went through `KinkyDungeonSaveGame` in the first
place, which is why stubbing it is free.

**A capture jails the party only when nobody is free** (KDM-261). While any partner is still up, the
capture resolves as `KinkyDungeonDefeat(PutInJail = false)` — KD's own branch, which binds the player
where they stand and never regenerates the map, so nobody is relocated. Once every player is down the
jail move fires unchanged and the whole party lands together. See `kd-coop-capture.js`.

### Drop reports — four ways a real action produces nothing

From the player's side a cancelled move and an ignored input look identical, so every way an action
can vanish is RECORDED and put in the snapshot rather than left as a silent no-op. There are four,
and they are deliberately separate fields — the causes are different and so are the fixes:

| field | cause | added |
|---|---|---|
| `unknownInputs` | the world's own registry (`KDInputTypes`) has no handler for the type | KDM-163 |
| `replacedInputs` | a second turn-consuming input displaced the first out of the lockstep slot | KDM-163 |
| `cancelledMoves` | a peer reached the contested tile earlier in the same turn | KDM-208 |
| `failedInputs` | the dispatch **threw** inside the world | KDM-268 |

The last one was missing for a long time and was the worst of the four to diagnose:
`applyInputObserved` catches the exception and returns it as `obs.error`, but on the turn path that
field was read only by `_learnInputKind` (as *"do not learn from this one"*). Nothing logged it,
nothing sent it — so an action truncated half-way reported a perfectly normal turn. That is how
KDM-267's capture bug stayed invisible.

All four are recorded on **both** apply paths, bounded to `maxLog` through the single `_recordDrop`
helper, and exposed on `KDRenderClient` (`unhandledInputs()`, `failedInputs()`) so a browser test can
assert the player's client actually heard about it — a `console.warn` alone is not readable by
anything.

**Adding a fifth is one entry in `DROP_CHANNELS`** (`swap-session.js`, above the class), plus the
`_recordDrop` call and its `_dbg` at the site. The registry is what the constructor, the `*Report()`
accessors and the `snap.*` lines are all generated from, so a channel cannot exist without being
reported (KDM-269). It used to be four hand-written places, and the dangerous one was the `snap.*`
line: forgetting it is **silent** — the recording works, the accessor answers, and nothing reaches
the browser, which is the very bug KDM-268 existed to fix. `tests/unit/mp-drop-channels.spec.ts`
iterates the registry and fails on a declared-but-unsent channel; it is mutation-tested against
exactly that omission.

Two notes for whoever adds the fifth:

- **Keep the wire fields separate and additive.** An older client ignores a field it does not know,
  which is why KDM-268 could ship `failedInputs` without touching compatibility at all. Collapsing
  them into one `drops: {reason -> []}` is a client-breaking change (`render-client.js` reads two by
  name) and needs its own decision.
- **Do not add them to `VERBATIM_CHANNELS`** in `ws-bridge.js`. `kdDiff` treats arrays as opaque and
  replaces them whole, so every channel already arrives intact; listing these cumulative,
  `maxLog`-bounded arrays there would force them onto every frame and work against the delta
  encoding. Only `unknownInputs`/`replacedInputs` are listed, for historical reasons rather than
  necessity.

**Recording is not handling.** None of the four changes what the turn does; they make a failure
visible. Whether an errored input should be retried, refunded, or excluded from `applied` is an open
behaviour question that no drop report answers.

## Agreeing the route out of the hub (KDM-263)

Between floors the party stands in a `PerkRoom` and must pick a journey slot before the stairs will
fire — KD's own `KDCancelFilters.JourneyChoice` refuses them while `JourneyTarget`/`UseJourneyTarget`
are unset. Two things had to change for two players.

- **The choice is now a routed input.** `KDRenderJourneyMap` writes `KDGameData.JourneyTarget` INLINE
  from the mouse and from the keyboard (`KDJourney.ts:388-395`, `:434-452`) — inside the DRAW
  function, never through `KDSendInput`. A render-only client therefore moved its own target and
  nothing else, and the party could not leave the hub at all. `kd-journey-choice.js` wraps that draw
  call (`_prev` first, so KD keeps owning what a legal slot is), REVERTS whatever it wrote and emits
  `KDSendInput('KDCoopJourney', {x,y})` instead. The client is now structurally incapable of
  committing a route; the only target it displays is the one the world sent it.
  A write of `null` is reverted but not routed — KD nulls the target to REFUSE (an unconnected slot,
  the Cancel button), and KD's own `JourneyChoice` cancellation stays the one refusal path.
- **The party has to agree.** `SwapSession._journey = {pending, proposer}` — in the gateway, NOT in
  `KDGameData`, because "wait for your partner to agree" cannot exist in a one-player game. The first
  player's pick is a proposal announced to both; the same slot from the OTHER player commits it; a
  different slot replaces it and makes that player the proposer, so a disagreement re-opens the
  question instead of deadlocking. **One seat commits immediately**, so a solo player cannot tell
  co-op from stock KD. A slot that is not a connection of the party's current slot is dropped.

`JourneyMap`, `JourneyTarget` and `UseJourneyTarget` are `KDGAMEDATA_WORLD_KEYS` entries now, with
`JourneyX`/`JourneyY` from KDM-265. `KDStairActions.ts:45` reads `JourneyMap[JourneyTarget]` for the
next floor's `MapMod`/`Faction`/`EscapeMethod`/`RoomType`, and `KDAdvanceLevel` PRUNES `JourneyMap` on
every descent — per-player copies made both of those "whoever was swapped in".

### The world half of `KDGameData` crosses the wire in one piece

`_clientBundle` strips every declared world key from the per-player bundle, so each key the list gains
is a key the client stops receiving and must be sent another way. That used to be a hand-written
`roomType`/`mapMod` pair mirrored in FOUR places (`serializeRenderState`, `applyRenderState`, and
render-client's `serialize`/`apply`); it is now one generic `worldGameData` object built from the
declared list. **Adding a world key needs no wire change at all.**

The browser gets the list at `/mp/kd-world-keys.js`, generated from `KDGAMEDATA_WORLD_KEYS` itself.
A page that injects `render-client.js` bare (as `mp-thin-client-spike.spec.ts` does) must supply it —
`serialize()` says so loudly on the console rather than quietly shipping an empty world half, which
is KDM-222's wrong-alt-type bug re-created.

### ⚠️ This wrap is text-coupled to an upstream DRAW function

If upstream moves the journey click out of `KDRenderJourneyMap`, the wrap silently stops routing and
the feature reverts to the bug it fixes, with every arbitration test still green. So it counts what it
sees (`__KDCoopJourneyStats.observed`) and `tests/unit/mp-journey-agreement.spec.ts` drives a real write
through KD's own code path with a CONTROL that calls the UNWRAPPED original and demands it still
writes. That control failing IS the drift alarm — read its message before assuming the wrap is wrong.

## Hub merchants, two players (KDM-264)

Most of this already worked by construction, and it is worth knowing which half: the stock is
`KDMapData.ShopItems` — world state, generated at `KDMapGen.ts:191-192` and spliced on purchase at
`KinkyDungeonShrine.ts:423` — while the purse is `KinkyDungeonGold`, an ordinary small global and so
per-player. **Two purses, one stock, no duplication and no double-sale come free.**

**What did not work is the cursor.** `KinkyDungeonShopIndex` is a per-player index INTO that shared
array, and the buy is a routed input carrying that index (`KinkyDungeonInput.ts:613-620`:
`KinkyDungeonShopIndex = data.shopIndex; KinkyDungeonPayShrine(...)`). So if A bought row 0 while B was
pointing at row 2, B's next click bought row 2 of a now-shorter array — a different item. Money spent,
wrong goods.

`kd-shop-buy.js` resolves the purchase by IDENTITY instead: the buyer's browser tags the routed payload
with `shopItemId` (name + shop type) read from its OWN `KDMapData.ShopItems` at click time, and a
server-side wrap of `KDInputTypes.shrineBuy` re-finds that id in the current shared stock, re-points
the index and delegates to `_prev` — so KD still does the whole purchase. If the item is gone it
refuses with a message rather than buying the neighbour. An UNTAGGED buy is passed through untouched,
so a stock client is unaffected.

### ⚠️ A gateway global needs the `__KD` prefix or it becomes player state

`_candidateGlobals` (`headless-host.js`) unions the bundle's own bindings with
`Object.keys(globalThis)` and skips only names starting with `__KD`. **A plain `globalThis.X` created
by a mod is therefore a per-player state candidate**: the server captures it, ships it in the bundle,
and the client's copy is overwritten by the server's on the next snapshot.

This cost a long hunt. Named `KDCoopShopStats`, the browser's counters read back as the *server's* —
the client-side counter it had just incremented was gone, and a server-side counter the browser never
touches had appeared, which reads exactly like "the client wrap never ran". The feature was fine; only
the evidence for it was being silently replaced. Both `__KDCoopShopStats` and `__KDCoopJourneyStats`
carry the prefix for this reason, and it is not cosmetic.

### Known gap: the highlight does not follow its item (KDM-266)

R14 also asks that a selection left open while the stock changes keep DENOTING the same item. It does
not. The PURCHASE is correct either way — the tag records the row the browser was showing at click
time — so what is missing is the display between the other player's purchase and yours.
`tests/e2e/mp-shop-identity.spec.ts` pins the current (wrong) behaviour explicitly rather than staying
silent, with a note to invert the expectation when it is fixed. Two failed approaches and their causes
are recorded in the `kd-shop-buy.js` header; read them before trying a third.

## The transition-write audit — a standing guard over one recurring bug

Four separate times, a global written by map generation or a floor transition turned out to be WORLD
state that the swap layer was replicating per-player, and each time it was found by a feature that
happened to make two players' copies diverge:

| | keys | found by |
|---|---|---|
| KDM-228 | `KDGameData.RoomType` / `.MapMod` | a side-room visit |
| KDM-265 | `MiniGameKinkyDungeonLevel` / `.Checkpoint`, `JourneyX`/`JourneyY`, `HighestLevelCurrent` | ten real descents |
| KDM-243 | `KinkyDungeonSeed` / `KDGameData.LastMapSeed` | a save import, after a bisect with a `KDsetSeed` recorder |

The cost is consistently "invisible until a specific feature exposes it, then expensive to diagnose".
`tests/unit/mp-transition-write-audit.spec.ts` (KDM-273) is the attempt to catch the fifth when
upstream introduces it instead.

**It does not decide classifications — it enforces that a decision was made.** The obvious rule is
wrong in both directions, which is the whole reason the guard has the shape it does:

- *"written by a transition ⇒ world"* over-fires: `KinkyDungeonFastMovePath` and
  `KinkyDungeonTargetTile` are written by `KDInitTempValues` and are plainly per-player. Being RESET
  by a transition is not the same as being DERIVED from the world by one.
- *"derived from the world ⇒ world"* under-fires: `KDGameData.ChestsGenerated = []` is a literal reset
  and is correctly world state anyway, because its semantics are floor population.

So the guard scans the four transition sites (`KinkyDungeonCreateMap`, `KDGoThruTile`,
`KinkyDungeonHandleStairs`, `KDInitTempValues`) and requires every key they write to be either
declared world in `GLOBAL_BLACKLIST` / `KDGAMEDATA_WORLD_KEYS`, or recorded in the spec's
`PER_PLAYER_BY_DECISION` register with a reason. Its failure mode is "a human must look at key #55",
not "state leaks" — which is what keeps the register from being the maintained whitelist this epic
exists to delete. The register is checked for rot in BOTH directions: an entry naming a key no site
writes any more fails, and so does a key that is in the register *and* declared world.

### ⚠️ Text-coupled to the game source

Same hazard as the journey draw-wrap above. Sites are located by function NAME, never by line number;
each must match exactly once, each extracted body is size-checked, and the total write counts are
asserted as lower bounds and logged on every run. A regex that quietly stops matching would otherwise
report a clean audit — the most expensive possible false green. When an upstream fast-forward turns
one of those checks red, update `SITES` / the bounds deliberately; do not delete the check.

Running it for the first time produced a backlog of keys that are per-player **by default rather than
by decision** — `KDGameData.PersistentItems` (keyed by `RoomType + KDCurrentWorldSlot`),
`KDCommanderRoles` (`Map<number,…>`, i.e. entity-keyed), `KDStageBossGenerated`, `KinkyDungeonPOI`,
and three render dirty flags that belong in a category `GLOBAL_BLACKLIST` already has. They are
recorded as `flagged`, and KDM-277 decides them one at a time, each with its own divergence test.

### Outcome of the first audit run (KDM-277)

The backlog it produced is closed: **17 flagged → 0**. Eleven keys moved, six are recorded as
deliberately per-player. What moved, and on which criterion:

| moved to | keys | why |
|---|---|---|
| `GLOBAL_BLACKLIST` (render) | `KinkyDungeonUpdateLightGrid`, `KDRedrawFog`, `KDTileModes` | every read is on the draw path; the server has no draw loop, so they never returned to baseline (the `KDDamageQueue` argument) |
| `GLOBAL_BLACKLIST` (world) | `KDCommanderRoles`, `KDStageBossGenerated`, `KinkyDungeonPOI` | entity-id-keyed `Map` (a); generation state read *by* generation (b); generator-emitted map POIs (b) |
| `KDGAMEDATA_WORLD_KEYS` | `PersistentItems`, `AlreadyOpened`, `KeyringLocations`, `Journey`, `PreferredJailPointTick` | keyed by world slot or map coordinates; `Journey` is the input that builds the already-world `JourneyMap`; the jail tick is denominated in the already-world `KinkyDungeonCurrentTick` |

**Six negative decisions, each now pinned by a test** so nobody later "completes the set":

- `KinkyDungeonGrid_Last` and `KDRestraintsCache` — written and reset, but **read nowhere** in
  `Game/src`. Vestigial; blacklisting them would be speculative.
- `MiniGameVictory` and `KinkyDungeonRep` — BondageClub integration, not KD state. Both live in
  `Scripts/Patch.ts`, the standalone shim that stubs BC's API (`ReputationGet` returns 0,
  `DialogSetReputation` does nothing). `KinkyDungeonRep` is each human's own account progression.
- `KDGameData.PrisonerState` and `.PriorJailbreaksDecay` — the deciding read is
  `KinkyDungeonAggressive(enemy, player)`, whose `PrisonerState` branches sit inside its own
  `// Player mode` guard. Under the swap model, per-player is what you want: each turn installs the
  acting player's bundle, so enemy AI judges aggression against *that* player's jail status. Making it
  world would force both players into one jail state — a co-op **design** change, not a fix. The
  jail's furniture stays world (`JailGuard`), where it already was.

Three of those six **reverse the audit's own flag**, which is the register working as intended: the
flag says "a human must look", not "this is wrong".
