#!/usr/bin/env bash
# KDM-167: run the e2e layer as ONE CONTAINER PER SPEC instead of one long run.
#
# Usage:
#   tools/run-e2e-isolated.sh              # every tests/e2e/*.spec.ts
#   tools/run-e2e-isolated.sh mp-pvp       # only specs whose name matches
#
# WHY. A single `playwright test tests/e2e` run walks ~20 specs in one browser
# process tree, and each MP spec drives TWO full game bundles (~600 preloaded
# assets each) plus a node host running three headless game instances. Resource
# pressure accumulates across the run, and the tail of the suite is where the
# contention failures land — measured: `co-op boot TIMEOUT` and `Target crashed`
# in the back half, while the same specs pass alone in ~3 min.
#
# Per-spec isolation is the lever that worked in the sibling mods repo for the
# same class of problem (its WebKit RAM-death was fixed with a per-mod process
# plus tab recycling). Each spec here gets a fresh container, so nothing carries
# over from the spec before it.
#
# COST: one docker start (~5 s) per spec. `npm i` is skipped when node_modules
# exists and `tsc` runs ONCE up front, so the overhead is small next to a 2–3
# min spec.
#
# This is a DIAGNOSTIC/verification runner, not a replacement for
# `run-tests.sh e2e` — the single-run path stays the default.
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
FILTER="${1:-}"

# NB: plain `while read`, not `mapfile` — macOS ships bash 3.2, where mapfile
# does not exist (and an empty array under `set -u` is an error too).
SPECS=()
while IFS= read -r line; do
	SPECS+=("$line")
done < <(ls tests/e2e/*.spec.ts | { if [ -n "$FILTER" ]; then grep -- "$FILTER"; else cat; fi; })

if [ ${#SPECS[@]} -eq 0 ]; then
	echo "no specs matched '${FILTER}'" >&2
	exit 64
fi

echo "══ e2e, isolated: ${#SPECS[@]} specs, one container each"
echo "══ host: $(docker ps -q 2>/dev/null | wc -l | tr -d ' ') containers running"

# Compile once; the per-spec runs then skip tsc (~30 s each saved).
echo "══ compiling game bundle once…"
KD_SKIP_TSC=0 bash tools/run-tests.sh e2e --list >/dev/null 2>&1 || true

PASS=(); FAIL=(); CONTENDED=()
set +u   # bash 3.2: ${#arr[@]} on an empty array trips `set -u`
START_ALL=$(date +%s)

# Let the previous container fully release before starting the next. MEASURED: on a completely IDLE
# host (0 other containers) a spec still died with `browserType.launch: … has been closed` at 0 ms —
# so that death is not other projects' load, it is this loop starting containers back-to-back while
# the previous one is still tearing down. Cheap insurance; override with KD_SPEC_GAP=0.
SPEC_GAP="${KD_SPEC_GAP:-4}"

first=1
for spec in "${SPECS[@]}"; do
	if [ "$first" -eq 0 ] && [ "$SPEC_GAP" -gt 0 ]; then sleep "$SPEC_GAP"; fi
	first=0
	name="$(basename "$spec" .spec.ts)"
	log="tests/_artifacts/isolated-${name}.log"
	mkdir -p tests/_artifacts
	t0=$(date +%s)
	KD_SKIP_TSC=1 bash tools/run-tests.sh e2e "$spec" >"$log" 2>&1
	rc=$?
	el=$(( $(date +%s) - t0 ))

	# Classify with the same signatures the runner documents. Match on the
	# reported ERROR lines only — the epilogue repeats these words as guidance,
	# so a naive grep over the whole log always "finds" them.
	# The list below is EMPIRICAL — every entry was added after a run misreported something.
	# `browserType.launch: … has been closed` was the miss that mattered most: the browser died
	# BEFORE the test body, so it produced a 0 ms failure with none of the in-test signatures, and
	# the summary cheerfully said "contention signatures: NONE" for a pure resource death.
	if grep -qE '^\s+Error: (\[KDM-167\] co-op boot (TIMEOUT|ABORTED)|page\.evaluate: Target crashed|browserType\.launch:|.*Target (page|crashed)|.*context or browser has been closed)' "$log"; then
		CONTENDED+=("$name")
	fi

	if [ $rc -eq 0 ]; then
		PASS+=("$name")
		printf '  ✓ %-38s %3ds\n' "$name" "$el"
	else
		FAIL+=("$name")
		printf '  ✘ %-38s %3ds   → %s\n' "$name" "$el" "$log"
	fi
done

echo
echo "══ ${#PASS[@]} passed · ${#FAIL[@]} failed · $(( $(date +%s) - START_ALL ))s total"
[ ${#FAIL[@]} -gt 0 ] && echo "══ failed: ${FAIL[*]}"
if [ ${#CONTENDED[@]} -gt 0 ]; then
	echo "══ contention signatures seen in: ${CONTENDED[*]}"
	echo "   (boot TIMEOUT / Target crashed — these are host-load deaths, not product bugs)"
else
	echo "══ contention signatures: NONE"
fi

[ ${#FAIL[@]} -eq 0 ]
