#!/usr/bin/env bash
# Test runner. Runs the test suite inside a dockerized Playwright
# environment. No host installs, no host runtimes — node/npm/playwright all
# run inside the container.
#
# Usage:
#   tools/run-tests.sh [all|unit|integration|e2e|watch]
#
# Defaults to "all".
#
# Invariant: this image tag MUST stay in lockstep with `playwright` and
# `@playwright/test` versions in package.json. Bumping one without the other
# results in "Executable doesn't exist at /ms-playwright/..." errors.
set -euo pipefail

LAYER="${1:-all}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.60.0-jammy"

case "$LAYER" in
	unit)
		CMD='npm i --no-audit --no-fund && npx tsc && npx vitest run'
		;;
	integration)
		CMD='npm i --no-audit --no-fund && npx tsc && npx playwright test tests/integration'
		;;
	e2e)
		CMD='npm i --no-audit --no-fund && npx tsc && npx playwright test tests/e2e'
		;;
	all)
		CMD='npm i --no-audit --no-fund && npx tsc && npm run test:in-container'
		;;
	watch)
		CMD='npm i --no-audit --no-fund && npx vitest --watch'
		;;
	*)
		echo "usage: $0 [all|unit|integration|e2e|watch]" >&2
		exit 64
		;;
esac

# Use -it only when stdin is a real terminal (so `npm run test:watch` keeps
# its interactive prompt). CI / background runs are non-TTY.
TTY_FLAGS=""
if [ -t 0 ] && [ -t 1 ]; then
	TTY_FLAGS="-it"
fi

exec docker run --rm $TTY_FLAGS --ipc=host \
	-v "$PROJECT_ROOT":/usr/src/app \
	-w /usr/src/app \
	"$IMAGE" sh -c "$CMD"
