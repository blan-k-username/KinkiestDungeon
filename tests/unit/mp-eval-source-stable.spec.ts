/**
 * KDM-215 — the two full-set scans must eval a BYTE-IDENTICAL source string every call.
 *
 * `_captureGlobals` and `_restoreGlobals` each embed the whole `_watchNames` list (~48 KB) as a
 * literal in their eval source. That looks like an obvious per-pass waste, and KDM-215 carried a
 * candidate to remove it by passing the array over the vm context instead. Measured on a quiet host,
 * interleaved and both ways round, the candidate was NEUTRAL — 0.57 vs 0.58 ms/pass — and the reason
 * turned out to be the thing worth protecting:
 *
 *   | eval source, same scan body      | median per pass |
 *   |----------------------------------|-----------------|
 *   | identical every call (production)|         0.58 ms |
 *   | unique per call (cache defeated) |         5.06 ms |
 *   | array over the vm context        |         0.57 ms |
 *
 * V8 caches compiled `eval` by source string. `_watchNames` is fixed once the baseline is taken, so
 * the 48 KB literal is parsed ONCE per process and every later pass is served from that cache. The
 * embed is free — but only while the string never changes. Interpolating anything per-call into
 * either template (a tick, a player id, a size that varies, a timestamp) reinstates the full ~4.5 ms
 * parse on BOTH halves — about 9 ms added to a ~13.6 ms transaction, an 8.7x cliff on the hottest
 * path in the proxy.
 *
 * That failure is invisible: nothing breaks, every test still passes, the server just gets slower.
 * So it is asserted structurally here rather than by a timing threshold, which on a shared host
 * would be pure flake (TESTING_POLICY rule 3).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('KDM-215 — the hot-path eval sources are cacheable', () => {
	/** Run `fn` twice, returning the eval source strings each call passed to the bridge. */
	function sourcesOverTwoCalls(world: any, fn: () => void): string[][] {
		const real = world.eval.bind(world);
		const seen: string[][] = [];
		let cur: string[] = [];
		world.eval = (code: string) => { cur.push(code); return real(code); };
		try {
			for (let i = 0; i < 2; i++) { cur = []; fn(); seen.push(cur); }
		} finally {
			world.eval = real;
		}
		return seen;
	}

	it('_captureGlobals and _restoreGlobals eval the same source on every call', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'kdm215-eval-stable', seedInputKinds: true });
		s.join('A');
		s.join('B');
		const world = s.world;
		// A real turn between the two calls, so anything that varies with world state has its chance.
		s.apply('A', { kdType: 'setMoveDirection', data: { dir: { x: 0, y: -1 } } });

		const names: string[] = world._watchNames || [];
		expect(names.length, 'precondition: there is a watch set being embedded').toBeGreaterThan(0);

		for (const [what, run] of [
			['_captureGlobals', () => world._captureGlobals()],
			['_restoreGlobals', () => world._restoreGlobals(s.bundles.get('A').globals)],
		] as [string, () => void][]) {
			const [first, second] = sourcesOverTwoCalls(world, run);

			// Validity: the capture we are inspecting must be the big embedded one, or this asserts
			// nothing. (`_captureGlobals` also evals smaller follow-ups via _reportGrownOverMax /
			// _auditOversize, so pick the scan by size rather than by position.)
			const big = (srcs: string[]) => srcs.filter((c) => c.length > 10_000);
			expect(big(first).length, `${what}: expected the ~48 KB embedded scan source`).toBeGreaterThan(0);
			expect(big(second).length, `${what}: the second call must run the same scan`)
				.toBe(big(first).length);

			big(first).forEach((src, i) => {
				expect(src, `${what}: its eval source CHANGED between two calls, so V8 must recompile `
					+ '~48 KB every pass instead of serving it from the eval compilation cache — that is '
					+ 'a measured 8.7x cliff on the hottest path (0.58 -> 5.06 ms/pass). Something '
					+ 'per-call was interpolated into the template; make it a constant or move it over '
					+ 'the vm context like __KD_BASE_H.').toBe(big(second)[i]);
			});
		}
	}, BOOT_TIMEOUT);
});
