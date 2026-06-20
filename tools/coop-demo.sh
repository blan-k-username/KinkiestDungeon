#!/usr/bin/env bash
# Hands-on co-op MVP launcher (epic mp-mvp / KD-071). Runs ENTIRELY in Docker —
# builds the bundle (npx tsc) then serves the game + the WebSocket bridge on :8080.
#
# Usage:
#   tools/coop-demo.sh           # serve on http://localhost:8090
#   PORT=9000 tools/coop-demo.sh # serve on another port
#
# Port 8090 by default (NOT 8080 — that's the stock `npm run serve` / kdrunner).
#
# Then open TWO browser windows:
#   http://localhost:8090/#coop=A    (window 1 — creates the session, waits)
#   http://localhost:8090/#coop=B    (window 2 — both in → shared dungeon starts)
# Move with arrow keys / WASD, [space] to wait. BOTH players must act each turn
# (lockstep co-op). You see the other player's avatar and a shared enemy.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8090}"
IMAGE="node:23-slim"

exec docker run --rm -it \
	-v "$PROJECT_ROOT":/usr/src/app -w /usr/src/app \
	-p "${PORT}:${PORT}" -e "PORT=${PORT}" \
	"$IMAGE" bash -c 'npm i --no-audit --no-fund && npx tsc && node tools/mp-server/demo-server.js'
