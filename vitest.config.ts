import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/unit/**/*.spec.ts', 'tests/helpers/**/*.spec.ts'],
		environment: 'node',
		globals: false,
		reporters: ['default'],
		coverage: { enabled: false },

		/*
		 * KDM-290 — CHOSEN, not inherited.
		 *
		 * vitest's default is 5 s, and this suite quietly did not fit in it. Seating the second player
		 * starts the session, and starting a session boots a real headless KD world — 1.25 s of
		 * synchronous work (`swap-session.js:780-800`), measured. That is the point of this layer: the
		 * MP node specs drive the real game, not a stub of it.
		 *
		 * 1.25 s idle becomes 2.4 s against a single competing suite, and a full run puts 123 spec
		 * files on the machine at once. So the default left roughly one doubling of headroom, and the
		 * failure it produced — `Test timed out in 5000ms` on a random session-starting spec — looked
		 * exactly like a flake: it passed alone, passed on re-run, and named nothing.
		 *
		 * 30 s is ~12x the measured worst case. A generous budget costs wall-clock only in a test that
		 * is already failing, and `MPClient.next` gives up well inside it (`MAX_WAIT_MS`) so the
		 * helper — which can say WHICH frame never arrived — is what reports first.
		 * `tests/unit/mp-test-budget.spec.ts` holds that ordering in place.
		 */
		testTimeout: 30_000,
		// The MP specs close a bridge in `afterEach`, which shuts a live TCP server. Same reasoning;
		// a hook killed by the default 10 s would report as an unrelated teardown mystery.
		hookTimeout: 30_000,
	},
});
