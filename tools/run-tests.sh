#!/usr/bin/env bash
# Test runner. Runs the test suite inside a dockerized Playwright
# environment. No host installs, no host runtimes — node/npm/playwright all
# run inside the container.
#
# Usage:
#   tools/run-tests.sh [all|unit|integration|e2e|watch] [extra args…]
#
# Defaults to "all". Any extra args are forwarded verbatim to the underlying
# runner, so a single spec is a one-liner (KDM-167 AC3):
#
#   tools/run-tests.sh e2e tests/e2e/mp-pvp-tie.spec.ts
#   tools/run-tests.sh unit tests/unit/mp-parity-oracle.spec.ts
#   tools/run-tests.sh e2e tests/e2e/mp-coop-demo.spec.ts --repeat-each=3
#
# Before this, running ONE spec meant hand-rolling a `docker run … playwright
# test <file>` invocation — which is exactly what you need most often, because
# re-running a single spec in isolation is how you tell a real failure from
# host contention (see the epilogue below).
#
# Env:
#   KD_FRESH_INSTALL=1   force `npm i` even when node_modules is already there
#                        (needed after a package.json change)
#   KD_COOP_BOOT_TIMEOUT ms for the two-browser co-op boot wait; raise it on a
#                        host you know is loaded (see tests/e2e/helpers/coop.ts)
#
# Invariant: this image tag MUST stay in lockstep with `playwright` and
# `@playwright/test` versions in package.json. Bumping one without the other
# results in "Executable doesn't exist at /ms-playwright/..." errors.
set -euo pipefail

LAYER="${1:-all}"
[ $# -gt 0 ] && shift
EXTRA=("$@")

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.60.0-jammy"

# Reinstalling on every run costs ~30 s and is pure waste for the single-spec
# loop this script now supports. Install only when it is actually missing.
INSTALL='if [ ! -x node_modules/.bin/playwright ] || [ ! -x node_modules/.bin/vitest ]; then npm i --no-audit --no-fund; fi'
if [ "${KD_FRESH_INSTALL:-0}" = "1" ]; then
	INSTALL='npm i --no-audit --no-fund'
fi

# KD_SKIP_TSC=1 skips the game compile. Only for a driver that already compiled
# once and is now invoking this script per-spec (tools/run-e2e-isolated.sh) —
# 20 identical `tsc` runs are ~10 min of pure waste. Never set it for a normal
# run: a stale out/main.js would silently test the wrong code.
TSC='npx tsc && '
if [ "${KD_SKIP_TSC:-0}" = "1" ]; then
	TSC=''
fi

# Quote each forwarded arg so paths with spaces survive the `sh -c` hop.
ARGS=""
for a in ${EXTRA+"${EXTRA[@]}"}; do
	ARGS="$ARGS $(printf '%q' "$a")"
done

case "$LAYER" in
	unit)
		CMD="$INSTALL && ${TSC}npx vitest run$ARGS"
		;;
	integration)
		CMD="$INSTALL && ${TSC}npx playwright test ${ARGS:-tests/integration}"
		;;
	e2e)
		CMD="$INSTALL && ${TSC}npx playwright test ${ARGS:-tests/e2e}"
		;;
	all)
		if [ ${#EXTRA[@]} -gt 0 ]; then
			echo "note: '$LAYER' runs the whole suite and ignores extra args; use unit|integration|e2e to filter" >&2
		fi
		CMD="$INSTALL && npx tsc && npm run test:in-container"
		;;
	watch)
		CMD="$INSTALL && npx vitest --watch$ARGS"
		;;
	*)
		echo "usage: $0 [all|unit|integration|e2e|watch] [extra args…]" >&2
		exit 64
		;;
esac

# ---------------------------------------------------------------------------
# KDM-167: host contention is this suite's dominant failure mode, so record it.
#
# Each MP e2e runs two full game bundles plus a node host with three headless
# instances. Measured across four runs: on a loaded host the suite takes ~1 h
# and co-op boot times out; on a quiet host the same specs pass first try in
# ~20 min. Neither the code nor the Playwright config changed between those
# runs — only what else the machine was doing.
#
# Capturing the load HERE means a failure log carries the evidence needed to
# judge it, instead of costing an hour to re-run and find out.
# ---------------------------------------------------------------------------
host_load() {
	local n r
	n="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')" || n="?"
	r="$(docker ps --filter status=restarting --format '{{.Names}}' 2>/dev/null | paste -sd, - )" || r=""
	printf '%s containers running' "$n"
	if [ -n "$r" ]; then printf ', CRASH-LOOPING: %s' "$r"; fi
	# MUST end truthy. `[ -n "$r" ] && printf …` returns 1 when nothing is crash-looping, and
	# `LOAD_BEFORE="$(host_load)"` takes the substitution's status — so under `set -e` the whole
	# script died silently the moment the host got healthy. Caught only because a crash-looping
	# container disappeared mid-task and the runner started exiting 1 with zero output.
	return 0
}

LOAD_BEFORE="$(host_load)"
echo "── kd tests: layer=$LAYER${ARGS:+ filter=$ARGS}"
echo "── host at start: $LOAD_BEFORE"

# MEASURED THRESHOLD (KDM-167). Per-spec host load vs outcome, one isolated run:
#     19 containers → FAILED · 18 → flaky · ≤16 → 18/18 passed, all first attempt
# It is a cliff, not a gradient, and no amount of timeout tuning crosses it: raising the co-op boot
# budget 150 s → 240 s simply bought 90 s more waiting before the same page-crash death. Above the
# threshold this suite cannot produce a trustworthy result, so say so BEFORE burning 40 minutes on
# one. A warning, never a hard stop — it is your machine and sometimes you need the run anyway.
KD_LOAD_LIMIT="${KD_LOAD_LIMIT:-16}"
RUNNING_N="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')" || RUNNING_N=0
if [ "${RUNNING_N:-0}" -gt "$KD_LOAD_LIMIT" ] && [ "$LAYER" != "unit" ]; then
	cat >&2 <<-EOS
	── ⚠️  HOST TOO LOADED FOR A TRUSTWORTHY e2e RUN ────────────────────────
	$RUNNING_N containers are running; measured threshold is $KD_LOAD_LIMIT.
	Above it, MP e2e specs die on co-op boot / page crashes regardless of
	timeouts — a red here tells you nothing about the code.

	Free the machine, or accept that failures will need an isolated re-run to
	mean anything. Override the threshold with KD_LOAD_LIMIT=<n>.
	─────────────────────────────────────────────────────────────────────────
	EOS
fi

# Use -it only when stdin is a real terminal (so `npm run test:watch` keeps
# its interactive prompt). CI / background runs are non-TTY.
TTY_FLAGS=""
if [ -t 0 ] && [ -t 1 ]; then
	TTY_FLAGS="-it"
fi

START=$(date +%s)
set +e
docker run --rm $TTY_FLAGS --ipc=host \
	-v "$PROJECT_ROOT":/usr/src/app \
	-w /usr/src/app \
	-e KD_COOP_BOOT_TIMEOUT="${KD_COOP_BOOT_TIMEOUT:-}" \
	-e KD_HOST_LOAD="$LOAD_BEFORE" \
	"$IMAGE" sh -c "$CMD"
EXIT=$?
set -e
ELAPSED=$(( $(date +%s) - START ))

echo "── elapsed: $((ELAPSED / 60))m $((ELAPSED % 60))s   exit=$EXIT"
echo "── host at start: $LOAD_BEFORE"
echo "── host at end:   $(host_load)"

if [ "$EXIT" -ne 0 ]; then
	cat >&2 <<-'EOS'

	── Is this red real? ────────────────────────────────────────────────────
	Check the host load above FIRST. This suite is contention-sensitive: MP
	e2e failures on a loaded machine are usually the co-op session failing to
	boot, not a product bug.

	  contention signature   "co-op boot TIMEOUT" · "Target crashed" ·
	                         "Target page closed" · a retry that fails EARLIER
	                         or slower than the first attempt
	  real-bug signature     an assertion about game state, failing the same
	                         way in isolation

	Re-run the ONE failing spec — now a one-liner:
	    tools/run-tests.sh e2e tests/e2e/<spec>.spec.ts
	Passes alone ⇒ it was contention. Fails alone ⇒ it is real.

	Also grep the log for `flaky`: retries are on, so "N passed" does NOT
	prove zero deaths.
	─────────────────────────────────────────────────────────────────────────
	EOS
fi

exit $EXIT
