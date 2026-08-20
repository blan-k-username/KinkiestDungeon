#!/usr/bin/env bash
# Hands-on co-op MVP launcher (epic mp-mvp / KD-071). Runs ENTIRELY in Docker —
# builds the bundle (npx tsc) then serves the game + the WebSocket bridge on :8080.
#
# Usage:
#   tools/coop-demo.sh           # serve on http://localhost:8090
#   PORT=9000 tools/coop-demo.sh # serve on another port
#   KD_WEAR_RESTRAINT=MasterworkHeels,HighsecShackles tools/coop-demo.sh   # start WEARING them
#     (self-equip from the inventory is a delayed action that cannot complete in co-op — use this)
#   KD_START_RESTRAINT=DuctTapeFeet tools/coop-demo.sh   # seed every player with that loose item
#     (server-side: goes into each player's BUNDLE, so applying it actually works. The per-window
#      URL form `#coop=A&startitem=Name` only seeds the browser's client-local Items inventory.)
#   KD_PVP=1 tools/coop-demo.sh          # peers are hostile to each other (KD-094) — needed to UAT
#     anything about PvP: real bump-attacks, tying a worn-down peer, defeat/recovery.
#   KD_CLASSIC_HEELS=1 tools/coop-demo.sh    # stock perk that makes heelpower count toward slow
#   KD_IDLE_GRACE_MS=30000 tools/coop-demo.sh   # auto-"wait" a silent player instead of strict lockstep
#
# ⚠️ Every env var the server reads must ALSO be listed in the `-e` flags below — the container gets
# only what is forwarded, so exporting one the launcher does not pass is silently ignored. KD_PVP,
# KD_CLASSIC_HEELS and KD_IDLE_GRACE_MS were all read by demo-server.js and unreachable through this
# script until 2026-08-20: `KD_PVP=1 tools/coop-demo.sh` started a session with PvP OFF and said
# nothing (found while setting up a PvP UAT — the demo simply came up co-op).
#
# Port 8090 by default (NOT 8080 — that's the stock `npm run serve` / kdrunner).
#
# Then open TWO browser windows:
#   http://localhost:8090/#coop=A    (window 1 — creates the session, waits)
#   http://localhost:8090/#coop=B    (window 2 — both in → shared dungeon starts)
# Move with WASD (+ QEZC diagonals), [X] to wait. Arrow keys are NOT bound by the game, and
# [Space] is Skip, not Wait (KinkyDungeon.ts:162-167). BOTH players must act each turn
# (lockstep co-op). You see the other player's avatar and a shared enemy.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8090}"
IMAGE="node:23-slim"

# --init runs a tiny init (tini) as PID 1 that forwards signals + reaps children, and
# `exec node` makes node the direct foreground process — together they make Ctrl-C
# actually stop the server (without --init, SIGINT never reaches node).
#
# KD_DETACH=1 runs it in the background instead (-d, no TTY) — for starting the demo from a
# non-interactive shell. Same container, same args: follow it with `docker logs -f kd-coop-demo`,
# stop it with `docker rm -f kd-coop-demo`.
MODE=(--rm -it)
if [ "${KD_DETACH:-0}" = "1" ]; then MODE=(--rm -d); fi

exec docker run "${MODE[@]}" --init \
	--name kd-coop-demo \
	-v "$PROJECT_ROOT":/usr/src/app -w /usr/src/app \
	-p "${PORT}:${PORT}" -e "PORT=${PORT}" \
	-e "KD_START_RESTRAINT=${KD_START_RESTRAINT:-}" \
	-e "KD_WEAR_RESTRAINT=${KD_WEAR_RESTRAINT:-}" \
	-e "KD_MP_DEBUG=${KD_MP_DEBUG:-}" \
	-e "KD_PVP=${KD_PVP:-}" \
	-e "KD_CLASSIC_HEELS=${KD_CLASSIC_HEELS:-}" \
	-e "KD_IDLE_GRACE_MS=${KD_IDLE_GRACE_MS:-}" \
	"$IMAGE" bash -c 'npm i --no-audit --no-fund && npx tsc && exec node tools/mp-server/demo-server.js'
