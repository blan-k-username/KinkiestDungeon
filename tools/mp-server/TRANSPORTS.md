# MP transport comparison (KD-081)

Three pluggable transports run the **same** orchestrator + reconciler (`mp-session.js`) over a real
serialization boundary. All four KD-079 acceptance criteria (lockstep tick, enemy consistency,
cross-avatar visibility, serverMode suppression) hold across **every** transport — verified by
`tests/unit/mp-transport.spec.ts` (22 cases).

## Headline finding — game-codebase changes per transport

| Transport | `Game/src/**` + `Scripts/**` changes |
|---|---|
| in-process (JSON boundary) | **0** |
| worker_threads | **0** |
| child_process + socket | **0** |

`git diff --stat HEAD -- Game Scripts` is **empty**. Transport choice costs **zero** game-code
change — all three reuse the identical zero-edit `HeadlessHost` + `dispatch` handler. The entire
difference between "localhost MVP" and "real remote server" lives in a thin adapter, not the game.

## Cost lives in the harness, not the game

Shared by all transports: `protocol.js` (73) + `mp-session.js` (162) + `index.js` (27).
Per-transport adapter LoC:

| Transport | adapter files | LoC | goal fit |
|---|---|---:|---|
| in-process | `in-process.js` | 47 | **MVP / localhost** |
| worker_threads | `worker-thread.js` + `worker-entry.js` | 86 | **smaller scale** |
| child_process + socket | `socket.js` + `child-entry.js` | 155 | **true multiplayer / lobby (remote)** |

## Measured (3 instances · 4 turns · seed `kd-poc-seed`, `node:23-slim`)

| Transport | boot (ms) | 4 turns (ms) | msgs | bytes* |
|---|---:|---:|---:|---:|
| in-process | ~574 | ~21 | 124 | 7901 |
| worker_threads | ~794 | ~31 | 124 | 6317 |
| socket (TCP loopback) | ~799 | ~32 | 124 | 6441 |

\* in-process counts request **and** response serialization; worker/socket count the request frame
only — so bytes aren't perfectly apples-to-apples. The point: **identical message count (124)** —
the protocol traffic is transport-independent; only the pipe changes. Boot dominates; per-turn
latency is negligible at this scale.

## Pros / cons

| Axis | in-process (JSON) | worker_threads | child_process + socket |
|---|---|---|---|
| Process isolation | none (one process) | V8 isolate, same process | **separate OS process** (own PID — asserted) |
| Real network framing | no (in-memory JSON) | no (structured clone) | **yes** (TCP, newline-JSON) |
| Crash containment | a crash kills everything | isolate crash is catchable | **child crash can't take the parent down** |
| Boot / mem per instance | lowest | +thread + bundle copy | +process + bundle copy (highest) |
| Debuggability | easiest (one stack) | medium | hardest (cross-process) |
| Serialization realism | real (JSON round-trip) | real (clone) | **real + wire bytes** |
| Path to "remote world" | needs a real transport later | same-machine only | **already a server other hosts can dial** |
| Adapter cost | 47 LoC | 86 LoC | 155 LoC |

## Recommendation by goal

- **MVP / localhost first run** → **in-process**. Cheapest, simplest, real serialization boundary so
  the protocol is already network-shaped. When you outgrow one process, the *session code doesn't
  change* — only the injected transport does.
- **Many lightweight sessions on one host** → **worker_threads**. Real isolation, no per-process
  overhead, crash-catchable.
- **True multiplayer / lobby across machines** → **socket** (child_process now; a real TCP/WS server
  in production). Proven to run a player instance in a *separate OS process* consistent with a world
  in *another* process.

The migration path is the win: because every instance is driven only by serialized messages, you can
start at in-process for an MVP and swap in worker/socket later **without touching game code or the
orchestrator** — just the transport passed to `MPSession`.

## Caveats (PoC)

Throwaway. Socket is plain TCP loopback, no auth/TLS/backpressure/reconnect; child lifecycle is
minimal (spawn + SIGTERM). `bytes` accounting is approximate (see above). Production transport,
framing, and the real thin client are KD-069 / KD-070 / KD-071.
