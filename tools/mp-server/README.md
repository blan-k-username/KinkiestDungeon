# Co-op multiplayer for Kinky Dungeon — developer guide

This folder adds **two-player co-op** to Kinky Dungeon: two people play one run together, in one
dungeon, each with their own character, from two browsers on the same network.

It is built **without changing a single line of the game's source**. The fork is the upstream game
plus new files only; co-op works by running the stock compiled bundle (`out/main.js`) and wrapping
its globals at runtime, the same way a mod does.

| If you want to… | read |
|---|---|
| play it with a friend | [`PLAYING-COOP.md`](PLAYING-COOP.md) — the player's guide |
| understand how it works, and what every file is | this file |
| go deep on one area (shop, stairs, mods, saves…) | [`DESIGN-NOTES.md`](DESIGN-NOTES.md) |
| see the game bugs co-op works around | [`UPSTREAM_ISSUES.md`](UPSTREAM_ISSUES.md) |
| see the transport measurements from the prototype | [`TRANSPORTS.md`](TRANSPORTS.md) |

---

## Contents

1. [What the fork changes](#what-the-fork-changes)
2. [Quick start](#quick-start)
3. [Architecture in one picture](#architecture-in-one-picture)
4. [The three ideas](#the-three-ideas)
5. [The life of one keypress](#the-life-of-one-keypress)
6. [Turns: lockstep, and what does not wait](#turns-lockstep-and-what-does-not-wait)
7. [World state vs player state](#world-state-vs-player-state)
8. [The wire protocol](#the-wire-protocol)
9. [Sessions: joining, dropping, coming back](#sessions-joining-dropping-coming-back)
10. [How co-op hooks into the game without editing it](#how-co-op-hooks-into-the-game-without-editing-it)
11. [File map](#file-map)
12. [Configuration](#configuration)
13. [Testing](#testing)
14. [Known limitations](#known-limitations)

---

## What the fork changes

Compared with the upstream branch it was last merged from, the fork **adds** files and changes
**no game source** — nothing under `Game/`, `Scripts/`, `Screens/`, the assets or `index.html`.

| Added / changed | What it is |
|---|---|
| `tools/mp-server/**` | the co-op server, the browser client, and these docs |
| `tests/**` | unit, integration and end-to-end tests (Vitest + Playwright) |
| `package.json` | test scripts and four dev dependencies (`vitest`, `@playwright/test`, `playwright`, `tsx`) |
| `vitest.config.ts`, `playwright.config.ts` | test configuration |
| `tools/run-tests.sh`, `tools/run-e2e-isolated.sh`, `tools/test-image/Dockerfile` | Docker-based test runners |
| `.gitignore` | lets the new `tests/**/*.ts`, `tools/mp-server/**` and `MULTIPLAYER.md` files in (upstream's file ignores everything not listed); ignores `tests/_artifacts/` |
| `MULTIPLAYER.md` (repository root) | a short pointer to this folder |

You can check the claim yourself: `git diff <upstream-commit> HEAD --stat -- Game Scripts Screens index.html`
prints nothing.

Two things the co-op server does at **serve time** instead, both to the copy sent to the browser and
never to the files on disk:

- it inserts its own `<script>` tags into `index.html` (the [`INJECT`](demo-server.js) list);
- it applies a small, policed table of text patches to `out/main.js` (`BUNDLE_PATCHES`), each one
  guarding a crash in the stock game that two players reach and one player does not. Every entry
  names the bug it guards in [`UPSTREAM_ISSUES.md`](UPSTREAM_ISSUES.md) and the condition under which
  it must be deleted; a unit test fails the moment an upstream fix makes one obsolete.

---

## Quick start

**1. Build the game** exactly as the main [`README.md`](../../README.md#build) describes
(`npm i && npm run build`, or its Docker equivalent). Co-op needs the compiled `out/main.js`; it adds
no build step of its own.

**2. Start the co-op server** from the repository root. It serves the game *and* the co-op
connection on one port, **8090**:

```bash
node tools/mp-server/demo-server.js
```

or, with Docker:

```bash
docker run --rm -it --name kdcoop -v "$PWD":/usr/src/app -w /usr/src/app -p 8090:8090 \
  -e KD_MP_HOST_PORT=8090 -e KD_MP_PUBLIC_HOST=<this machine's LAN address> \
  node:24-slim node tools/mp-server/demo-server.js
```

The server needs only Node's built-in modules — no `npm i` for it. The two `-e` lines matter only
under Docker: inside a container the server cannot see the machine's real network address, so you
tell it which address to show the host as "give this to your friend" (see [Configuration](#configuration)).

**3. Play.** Open `http://localhost:8090/`, start a new game, and use the co-op column on the class
screen: **Host Game** on one machine, **Join Game** (typing the host's address) on the other. The
host approves the join. [`PLAYING-COOP.md`](PLAYING-COOP.md) walks through every screen.

**4. Test.** All tests run inside Docker (`mcr.microsoft.com/playwright`, matched to the Playwright
version in `package.json`):

```bash
tools/run-tests.sh unit                                # node-level suite, no browser
tools/run-tests.sh e2e tests/e2e/mp-coop-demo.spec.ts  # one end-to-end spec, two real browsers
```

See [Testing](#testing) for the whole picture.

---

## Architecture in one picture

```
 Browser A (host)                         Co-op server (one Node process, demo-server.js)
┌──────────────────────────┐             ┌────────────────────────────────────────────────────────┐
│ stock index.html +       │   HTTP      │ static file server  ── serves the repo root, inserts   │
│ stock out/main.js        │◄────────────┤                        the client <script> tags         │
│                          │             │                                                        │
│ + client/*.js (injected) │  WebSocket  │ WSBridge (ws-bridge.js)                                │
│   render-client: draw    │◄───────────►│   sockets · join gate · presence/heartbeat · deltas    │
│     what the server says │  JSON       │        │                                               │
│   coop-bootstrap: socket │             │        ▼                                               │
│   coop-lobby: Host/Join  │             │ SwapSession (swap-session.js)                          │
└──────────────────────────┘             │   lockstep turns · who is in the slot · peace/PvP ·   │
                                         │   party choices · drop reports · saves                 │
 Browser B (guest)                       │        │                                               │
┌──────────────────────────┐  WebSocket  │        ▼                                               │
│ same page, same scripts  │◄───────────►│ HeadlessHost (headless-host.js)                        │
└──────────────────────────┘             │   the STOCK out/main.js, booted in a Node vm context  │
                                         │   with browser stubs (shims.js) — the one real world   │
                                         └────────────────────────────────────────────────────────┘
```

Only the host's machine runs the server. The guest needs nothing but a browser: their page is served
by the host's server, so both players are guaranteed the same game build.

---

## The three ideas

### 1. The game runs on the server, headless and unmodified

`HeadlessHost` loads the stock `out/main.js` into a Node [`vm`](https://nodejs.org/api/vm.html)
context, after `shims.js` has stubbed out PIXI, the DOM, WebGL, audio and storage so the bundle boots
without a browser. KD's top-level `let`/`const` globals are not properties of the global object, so
a small function (`__KDEVAL`) is appended to the same script; its closure can read and write every
global by name — the Node equivalent of Playwright's `page.evaluate`.

On top of that, the host turns off what a server must not do (drawing, autosaving to `localStorage`)
by **reassigning** KD's functions at runtime — the same reassignable-global mechanism mods use. KD's
own rules, AI, combat, map generation and input handlers run exactly as in single player.

This is the only simulation. Browsers never simulate; the server is the authority.

### 2. One world, players swapped in

KD is a single-player game: there is exactly one `KinkyDungeonPlayerEntity`, one `KDGameData`, one
set of stats. Rather than change that, the session keeps **one world** and stores each player as a
**bundle** — a capture of every player-specific global (`HeadlessHost.capturePlayer()`).

To let a player act, the session **swaps them in**: it restores their bundle into the world's single
player slot, runs their input through KD's own dispatcher, then captures the bundle again and moves
on to the next player. To the game, each player's action looks like an ordinary single-player turn.

Every *other* player is present in the world as a real KD entity — an avatar called
`RemotePlayer_<name>`, dressed in that player's own outfit — so enemies see, target and attack them,
and collision, vision and dialogue work through KD's normal code paths. When an enemy hits an
avatar, the result is written back into that player's bundle.

### 3. The browser is a thin client

Each browser runs the stock game page, but `client/render-client.js` switches local simulation off:
it wraps `KinkyDungeonAdvanceTime` so time never advances locally, and wraps `KDSendInput` — KD's
single entry point for player actions — so every action goes to the server instead of running.

When the server answers with a state frame, `KDRenderClient.apply()` writes it into KD's globals
(`KDMapData`, the player entity, the message log, that player's own globals…) and KD's **own draw
loop** paints it. Every screen, HUD element, sprite and menu is the game's own.

---

## The life of one keypress

Player A presses `D` to move right.

1. **KD handles the key as usual** and calls `KDSendInput('move', {dir…})`.
2. **`render-client.js`** intercepts that call and hands it to `coop-bootstrap.js`, which sends
   `{type:'input', action:{kdType:'move', data}}` over the WebSocket and remembers it is waiting for
   one reply.
3. **`ws-bridge.js`** decodes the frame, marks A as alive (heartbeat), and calls
   `session.apply('A', action)`.
4. **`swap-session.js`** asks: is this a *turn* input or a *UI* input (see the next section)?
   A move is a turn input, so it is queued for this turn. B has not acted yet, so the bridge replies
   `{type:'waiting', waitingOn:['B']}` to A, and tells B `{type:'await'}`.
5. **B acts.** Now everyone has submitted, so `_advanceTurn()` runs: in a seeded random order, each
   player is swapped into the world, their input runs through KD's `KDInputTypes` handler for real,
   and their bundle is captured again. Then the world advances.
6. **The bridge broadcasts the result.** For each player, `snapshotFor(id)` swaps that player in,
   serializes what *they* should see (`serializeRenderState()` + their bundle + their own message
   log + events), and swaps them out. The first frame is a full `snapshot`; later frames are a
   `delta` against the last one sent (`kd-delta.js`), numbered with `seq`.
7. **Each browser merges the delta**, checks `seq` (a gap makes it ask for a full `resync`), and
   calls `KDRenderClient.apply()`. KD draws the new turn.

The frame that answers a client's own input carries `reply: true`, so each client can match replies
to its sends one-for-one, in order.

---

## Turns: lockstep, and what does not wait

**Turn inputs wait for everyone.** KD advances time once per player action; in co-op, the world
advances once per *round*, when every seated player has submitted one turn input (moves, attacks,
spells, waiting, picking up…). By default there is no timer: the turn waits as long as it takes.
`KD_IDLE_GRACE_MS` can make the server auto-wait for an idle player instead.

**UI inputs do not wait.** Opening the inventory, changing a setting, scrolling a shop, choosing a
dialogue option — anything that does not advance time — is applied immediately for that player
alone, with the same swap-in / capture / swap-out, and answered at once.

**Who decides which is which?** KD itself. Before the session starts, `input-classifier.js` reads
the bundle's text and asks, for each `KDInputTypes` handler, whether `KinkyDungeonAdvanceTime` is
reachable; unsure means "turn". At runtime, `applyInputObserved` counts whether an input actually
advanced time, and the classification is corrected from that evidence. No list of input names lives
in the co-op code.

**Order within a round** is a seeded shuffle, so two players aiming at the same free tile are
resolved first-come. The second player's move into the first player's freshly-arrived avatar is
cancelled rather than turned into an attack (`setBumpVeto`), and reported back to them.

**An action never vanishes silently.** Four separate reports are carried in the snapshot and logged:
an input type the world has no handler for, an input displaced by a second one in the same turn, a
move cancelled by a contested tile, and an input whose handler threw.

**The party moves between floors together.** The stairs are refused (through KD's own
`beforeStairCancel` event) until every player is on or next to the stair tile; on arrival everybody
is placed on free tiles around where KD put the arriving player.

**Party choices are agreed.** Where KD asks the single player to choose for the run (the journey
route out of the hub, a perk card), one player proposes and the same choice from the other commits it
(`party-choice.js`).

---

## World state vs player state

The swap model only works if every global is correctly classed as **world** (one copy, shared — the
map, enemies, the floor, the shop stock) or **player** (one copy per bundle — stats, inventory,
restraints, gold, position, the message log).

- **Player state is captured generically.** `capturePlayer()` records every global that differs from
  its value right after the world booted, minus `GLOBAL_BLACKLIST` (globals that are world, render-
  only or audio). There is no hand-maintained list of "player fields", so a new KD global is carried
  per player automatically.
- **World keys inside `KDGameData`** are listed in `KDGAMEDATA_WORLD_KEYS`; a swap leaves them alone.
- **Game modes** (KD keeps them in `KinkyDungeonStatsChoice`, beside perks) are split by
  `game-modes.js` into run-wide modes that come from the host and per-character ones.
- **A guard watches for new world state.** `tests/unit/mp-transition-write-audit.spec.ts` scans KD's
  map-transition functions and fails when one writes a global that nobody has classified yet.

On the client side, a global that drops *out* of a bundle (because it went back to its default on the
server) is reset to its default in the browser too (`kd-absent-reset.js`).

---

## The wire protocol

One WebSocket per browser, same origin as the page, JSON text frames. The WebSocket server is
hand-written over Node's `http` module (RFC 6455 framing in `ws-bridge.js`); there are no runtime
dependencies.

**Browser → server** (handled in `WSBridge._handle`):

| type | from | meaning |
|---|---|---|
| `join` | anyone | ask for a seat: `role` (`host`/`guest`), `clientId`, `name`, `build`, mods, perks, character, and for the host the world options / save to continue |
| `join_answer` | host | accept or decline the pending guest |
| `mods_declare` | host | re-declare the host's mod set after publishing it |
| `input` | seated player | one game action: `{kdType, data}` (a `KDSendInput` call), or `{mp: …}` for co-op-only actions such as chat or a peace offer |
| `resync` | seated player | "I missed a frame — send me a full snapshot" |
| `export_request` | host | "give me this run as a single-player save" |
| `pong` | anyone | heartbeat answer |

**Server → browser** (every kind and field is declared once, in `OUTBOUND_MESSAGES` in
`ws-bridge.js`, and a unit test holds the code to that table):

| type | meaning |
|---|---|
| `joined` | you have a seat (the host also gets the LAN address to share) |
| `awaiting_approval` / `join_pending` | guest: waiting for the host · host: someone is asking (with the mod difference) |
| `reject` | refused, with a reason (`build_mismatch`, `busy`, `session_full`, `declined`, `duplicate_id`…) |
| `state` | a world update: full `snapshot` or `delta`, with `seq`; `kind` is absent for a turn, `ui` for an immediate answer, `push` for a server-initiated update; `reply: true` on the frame answering your own input |
| `ack` | your UI input changed nothing visible |
| `waiting` / `await` | the turn is waiting on these players |
| `blocked` | your input was refused (e.g. the session is paused for a missing player) |
| `error` | your input failed on the server |
| `ping` | heartbeat |
| `peer_joined` / `peer_missing` / `peer_back` / `peer_gone` / `host_changed` | presence changes |
| `save_export` | host only: the run as a save string KD can load |

Besides the WebSocket, the server has a few HTTP routes under `/mp/`: shared scripts (below) and the
mod relay (`/mp/mods/manifest`, `GET`/`POST /mp/mods/<hash>`).

---

## Sessions: joining, dropping, coming back

- **Two seats.** Seat 0 is the host, seat 1 the guest (`join-gate.js`, pure logic with no socket).
- **The host approves every join.** There are no accounts and no join codes. A pending request holds
  no seat; a second request while one is pending is refused as `busy`.
- **Same build or no join.** The guest's page reports KD's version string; the host's build defines
  the session, and a different build is refused before the host is even asked.
- **Ways in.** The class screen's **Host Game / Continue Save / Join Game**, **Host this game** in the
  in-game menu (turns a solo run in progress into a co-op run), and **Join with this character** on
  the save-slot screen.
- **Mods follow the host.** The host's mod set defines the session; the guest's browser fetches what it
  is missing, identified by content hash (`mod-sync.js`, `client/coop-mods.js`). A mod difference
  never refuses a join.
- **Liveness.** The server pings every 5 s at the application level (a frozen page cannot answer,
  unlike a protocol-level ping). A player silent for 30 s, or whose socket closes, is reported
  `missing` and the session **pauses**. A host who loses the guest gets an in-game dialogue: wait,
  or go on solo. A guest who loses the host is told so and can quit. A player that answers again —
  reconnected or merely unfrozen — is `back` and play resumes.
  A reconnecting player comes back as themselves, on their own seat.
- **A missing host** is waited for (2 minutes by default); then the guest is promoted to host.
- **Saves.** A host can continue a single-player save in co-op, and the run is exported back to the
  host as a normal KD save on every floor transition (and on a timer in Roguelike save mode), so a
  stopped server never destroys the run.

---

## How co-op hooks into the game without editing it

Every co-op behaviour uses one of these mechanisms, in this order of preference:

1. **Runtime wrapping of a KD global.** Reassign the function to a wrapper that calls the previous
   value first, guarded by a sentinel so a re-evaluation does not wrap twice (e.g. `KinkyDungeonRun`
   for the lobby screens, `KDSendInput` for input routing, `KDGetContextActions.Game` for the
   co-op context-menu entries).
2. **KD's own extension points.** New `KDInputTypes` handlers for co-op actions, `KDDialogue` entries
   for co-op dialogues, `KDKeyCheckers` for hotkeys, `KDEventMapGeneric` / `KDCancelEvents` for the
   party stair gate, `addTextKey` for text.
3. **A serve-time text patch of `out/main.js`** — last resort, only for crashes in the stock game,
   under the policy described in [`DESIGN-NOTES.md` → Bundle-patch policy](DESIGN-NOTES.md#bundle-patch-policy-kdm-166).

**One source, two runtimes.** Several co-op features need the same code in the server's headless
world *and* in the browser (a dialogue definition, a routed choice, the delta codec). Those files
(`kd-*.js`) export their code as **source text**: the server evaluates it inside the headless world,
and `demo-server.js` serves the same text to the browser at `/mp/<name>.js`. Each half guards on the
global it needs, so the text is safe to run in either place.

**Script order in the browser is guaranteed.** `index.html` loads `out/main.js` as a plain synchronous
script and the co-op scripts are inserted just before `</body>`, so every KD global already exists
when a client script runs; no client code polls for the bundle.

---

## File map

Line counts are approximate. "Both" means the file's code runs in the headless world on the server
**and** in the browser.

### Server — the shipped path

| File | Lines | Role |
|---|---|---|
| `demo-server.js` | 480 | **Entry point.** HTTP server for the game files; inserts the client scripts into `index.html`; serves `/mp/*.js` and the mod relay; applies `BUNDLE_PATCHES`; starts the `WSBridge` on the same port. Reads the environment variables in [Configuration](#configuration). (The name is historical; this is the real launcher.) |
| `ws-bridge.js` | 1700 | Everything about connections: WebSocket framing, the `join` handshake, seats via `JoinGate`, liveness via `Presence`, the heartbeat, host grace and promotion, join-late, delta-encoded state frames, the `OUTBOUND_MESSAGES` registry, save delivery, telemetry. |
| `swap-session.js` | 3750 | The game session: lockstep turns, swapping players in and out, turn/UI classification, peer avatars and PvP, peace/war, party choices, co-op dialogues, chat, the stair gate, per-player logs and one-shot events, join-late, save import/export, drop reports. |
| `headless-host.js` | 3650 | Boots the stock bundle in a `vm` context and exposes the world: `capturePlayer` / `restorePlayer`, `applyInputObserved`, `serializeRenderState`, avatars, perks/modes/character, `loadSave` / `exportSave`, `loadMod`. Holds the world-vs-player tables. |
| `shims.js` | 830 | Browser stubs (PIXI, DOM, WebGL, canvas, audio, storage, `fetch` from local files) so the bundle boots in Node. Loaded by path into the `vm` context. |
| `join-gate.js` | 720 | Seat and approval rules, build check, the host's declarations, and the input sanitisers (names, perks, characters, saves). No socket, no world. |
| `presence.js` | 230 | Per-seat liveness: `connected` → `missing` → `gone`; whether the session is paused. Time is passed in, never read. |
| `party-choice.js` | 120 | "Propose, then confirm" between players, for the journey route and the perk card. |
| `peace.js` | 190 | Which pairs of players are at war or at peace, and the truce offer handshake. |
| `game-modes.js` | 170 | Which of KD's game-mode keys are run-wide (host's) vs per-character; validates the host's world options. Also served to the browser. |
| `input-classifier.js` | 190 | Reads the bundle text to pre-classify each `KDInputTypes` handler as turn or UI. |
| `mod-sync.js` | 140 | Compares two mod declarations by content hash; an in-memory store for mod payloads. |
| `lan-address.js` | 120 | Works out which address the host should give a friend. |

### Shared source text (`kd-*.js`)

| File | Runs | Role |
|---|---|---|
| `kd-codec.js` | both | JSON encoding of KD state, including `Map` and `Set`. |
| `kd-delta.js` | both | Structural diff (server) and merge (browser) for state frames. |
| `kd-absent-reset.js` | browser | Resets a global to its default when it drops out of the bundle. |
| `kd-peace-dialogue.js` | both | The peace-offer dialogue. |
| `kd-disconnect-dialogue.js` | both | Dialogues for "host lost", "partner lost", "someone wants to join" and "you are now the host". |
| `kd-journey-choice.js` | both | Routes the journey-map pick (KD writes it inside a draw function) as a real input the party agrees on. |
| `kd-perk-choice.js` | both | The same for the perk-room card. |
| `kd-coop-routed.js` | both | One shared check ("is this choice routed here?") used by the two files above, so a solo page is untouched. |
| `kd-shop-buy.js` | both | Buys by item identity instead of list index, so a purchase cannot buy the wrong item after the partner bought one. |
| `kd-coop-capture.js` | server | A capture only sends the party to jail when nobody is left free. |
| `kd-variant-registry.js` | server | Keeps item variants that only the *other* player still holds from being pruned. |

### Browser client (`client/`)

Inserted into the page in this order, after `out/main.js`: `coop-mods`, `coop-text`, the shared
`/mp/` scripts, `render-client`, `coop-bootstrap`, `coop-menu`, `coop-chat`, `coop-lobby`, then the
dialogue/choice scripts.

| File | Lines | Role |
|---|---|---|
| `render-client.js` | 950 | `window.KDRenderClient`: turns local simulation off, routes every `KDSendInput` to the server, and applies state frames to KD's globals. |
| `coop-bootstrap.js` | 2020 | `window.__coop`: the WebSocket, identity, the join handshake, matching replies to inputs, resync, reconnect, entering the game. `__coopConnect` is what the lobby calls. |
| `coop-lobby.js` | 1050 | The co-op screens and buttons (Host / Continue / Join, the address and name fields, approving a guest, the mod difference), drawn through a wrap of `KinkyDungeonRun`. |
| `coop-chat.js` | 470 | Chat: `Y` for a text message, `U` for quick emoji; shown in KD's own message log under a Chat filter. |
| `coop-menu.js` | 200 | Context-menu entries: offer peace, save this run for single player. |
| `coop-mods.js` | 320 | The browser half of mod sync: holds back KD's mod auto-loader, fetches the host's mods, then runs them all in one pass. |
| `coop-text.js` | 720 | Every player-facing co-op string, in one table (`window.KDMPText`), with translations; KD's own `TextGet` wins when it has the key. |

### Prototype (not on the shipped path)

`orchestrator.js`, `mp-session.js`, `lobby.js`, `integration.js`, `transport/`, `demo.js`,
`smoke-boot.js`, `bench-transports.js` — an earlier architecture (one KD instance per player) that
proved the bundle runs headless and that the transport choice costs no game-code change. Nothing the
co-op server runs loads them; they keep their own specs as evidence. See
[`DESIGN-NOTES.md` → Appendix](DESIGN-NOTES.md#appendix--the-prototype).

### Docs

`README.md` (this file), `PLAYING-COOP.md`, `DESIGN-NOTES.md`, `UPSTREAM_ISSUES.md`, `TRANSPORTS.md`.

---

## Configuration

All optional. Set them in the environment of `demo-server.js` (with Docker, as `-e NAME=value`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8090` | Port for both the game and the WebSocket. |
| `KD_MP_PUBLIC_HOST` | auto-detected | The address the Host screen tells the host to share (`192.168.1.24`, or several, comma-separated, optionally with `:port`). Needed under Docker, where auto-detection would see the container's network. |
| `KD_MP_HOST_PORT` | — | The port published on the host machine, when it differs from the container's. Setting it without `KD_MP_PUBLIC_HOST` makes the screen say "this machine only" rather than guess. |
| `KD_IDLE_GRACE_MS` | `0` | `0` = strict lockstep. Otherwise, auto-wait a player who has not acted after this many ms. |
| `KD_PVP` | off | `1` starts the session with the players hostile to each other. |
| `KD_COOP_PERKS` | — | Default start perks for a player who picked none. |
| `KD_START_RESTRAINT` / `KD_WEAR_RESTRAINT` | — | Give / put on items at start (testing aid). |
| `KD_HB_INTERVAL_MS` | `5000` | Heartbeat interval; `0` turns the heartbeat off. |
| `KD_HB_TIMEOUT_MS` | `30000` | Silence after which a player is reported missing. |
| `KD_HOST_GRACE_MS` | `120000` | How long a running game waits for a missing host before promoting the guest. |
| `KD_MP_DEBUG` | off | `1` prints the session's trace to the server's stderr (it is also forwarded to the browser console). |

---

## Testing

There are three layers, all run in Docker by `tools/run-tests.sh`, which also builds `out/main.js`
first. Artifacts (HTML report, traces, logs) land in `tests/_artifacts/`.

| Layer | Runner | What it drives | Count |
|---|---|---|---|
| `tests/unit/` | Vitest (`vitest.config.ts`) | Node only: the real headless world, `SwapSession`, `WSBridge` over real sockets, pure modules | ~130 specs |
| `tests/integration/` | Playwright | the stock game in one browser | 4 specs |
| `tests/e2e/` | Playwright (`playwright.config.ts`) | **two real browsers** against a co-op server started inside the test (`demo-server.start(0)`) | ~75 specs |

```bash
tools/run-tests.sh unit                         # whole unit layer
tools/run-tests.sh unit tests/unit/mp-heartbeat.spec.ts
tools/run-tests.sh e2e tests/e2e/mp-coop-untie.spec.ts
tools/run-e2e-isolated.sh                       # every e2e spec in its own container (slower, steadier)
KD_FRESH_INSTALL=1 tools/run-tests.sh unit      # reinstall node_modules first
```

A full e2e run takes a long time (two browsers plus a headless world per spec);
`run-e2e-isolated.sh` exists because a loaded machine produces timeouts that are not product bugs, and
it labels those as contention.

**Helpers worth knowing**

| Helper | Use |
|---|---|
| `tests/e2e/helpers/coop.ts` | `bootCoopPair` (two pages through the real lobby), real-key moves, wire capture, recorders for what was actually *painted* (`recordDrawnText`, `recordDrawnSprites`) |
| `tests/helpers/mp-lobby.ts` | drives the lobby as a player would, pressing KD's own canvas buttons |
| `tests/helpers/mp-ws-client.ts` | the one test WebSocket client; merges deltas with the real `kdMerge` |
| `tests/helpers/session-tiles.ts` | free / contested tiles in a running session |
| `tests/unit/helpers/world.ts` | a real floor change (`descend()`) |

**Guard specs.** Some unit specs check the codebase rather than a feature, so a whole class of
mistake cannot recur:

| Spec | Fails when… |
|---|---|
| `mp-outbound-fields` | the server sends a message kind or field not declared in `OUTBOUND_MESSAGES`, or the client reads one that is not |
| `mp-join-fields` | the client sends a `join` field the bridge does not forward |
| `mp-drop-channels` | a drop report is recorded but never reaches the browser |
| `mp-transition-write-audit` | a KD map transition writes a global nobody has classed as world or player |
| `mp-bundle-patch-policy` | a bundle patch lacks its metadata, or upstream fixed the bug it guards |
| `mp-i6-no-gameplay-constants` | a gameplay table (class names, outfits…) is hard-coded in the co-op code instead of read from KD |
| `mp-parity-oracle` | a one-player co-op session diverges from a plain single-player run |
| `mp-client-strings` | a player-facing string bypasses the `coop-text.js` table |

---

## Known limitations

- **Two players.** The join gate has two seats. (The prototype ran 2–4; the shipped session has not
  been widened.)
- **Direct connection only.** The guest connects straight to the host's machine — there is no relay
  or matchmaking. Over the internet that means a port forward or a VPN.
- **Not hardened for the open internet.** Plain HTTP and WebSocket (no TLS), no accounts; the only
  gate is the host approving each join. The static file server serves the repository root
  (confined to it). Run it on a network you trust.
- **Lockstep pace.** A turn waits for both players, so the slower player sets the pace unless
  `KD_IDLE_GRACE_MS` is set.
- **Text-coupled pieces.** The bundle patches, the input classifier and two wraps of KD draw functions
  (journey map, perk orb) depend on the text or structure of specific KD functions. Each one counts
  what it matched and has a test that turns red when an upstream change moves the code — that red
  test is the signal to update it, not a bug in the change that triggered it.
- **The shims track the game's rendering surface** as of the last merge; a new PIXI/DOM call in KD can
  need a new stub.
- **Emoji** in chat depend on the player's system font.
- More specific known limits (untying locked gear, and others) are listed in
  [`DESIGN-NOTES.md`](DESIGN-NOTES.md#saves-and-other-known-limits) and
  [`PLAYING-COOP.md` → What does not work](PLAYING-COOP.md#what-does-not-work).
