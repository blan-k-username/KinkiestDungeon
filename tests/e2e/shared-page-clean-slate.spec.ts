/**
 * KDM-216 — the worker-scoped shared page really is a clean slate.
 *
 * `kdPage` hands every integration spec and some e2e specs the SAME Page for the
 * whole worker, reset between tests by `resetKDState()`. That contract only holds
 * if no spec leaves a permanent monkey-patch behind, because `resetKDState()`
 * re-runs KD's init functions — it does not restore patched globals.
 *
 * This spec is the guard. It asserts the invariant directly, and it is meaningful
 * only in ORDER: the filename sorts after `mp-thin-client-*` (the specs that used
 * to pollute) and before `title-screen`, so in a suite run it inherits whatever
 * they left behind. Run alone it passes trivially — that is expected; its job is
 * to fail the moment a spec starts permanently mutating the shared page again.
 *
 * The concrete regression it locks down: the thin-client specs called
 * `KDRenderClient.disableLocalSim()`, which installs `__kdClientGuard` wrappers
 * that make `KinkyDungeonAdvanceTime` a no-op. Every spec after them on the shared
 * page — including all four integration specs, since `tests/e2e` sorts before
 * `tests/integration` — silently ran against a game that could not advance a turn.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('the shared page carries no leftover patches from earlier specs', async ({ kdPage }) => {
	const leaks = await kdPage.evaluate(() => {
		const w = window as any;
		return {
			// The thin-client core, injected via addScriptTag and never removed.
			renderClient: typeof w.KDRenderClient,
			delta: typeof w.KDDelta,
			// disableLocalSim()'s permanent wrappers. Their guard flag is the tell:
			// while it is set with clientMode true, local turn advance is a no-op.
			// @ts-ignore — KD globals are bundle-scope lets, reachable by bare name
			advanceGuarded: !!(KinkyDungeonAdvanceTime as any).__kdClientGuard,
			// @ts-ignore
			sendInputGuarded: !!(KDSendInput as any).__kdClientGuard,
			localSimDisabled: w.KDRenderClient ? w.KDRenderClient.isLocalSimDisabled() : false,
			// Ad-hoc scratch state the ws spec parks on window, incl. an open socket.
			scratch: ['__ws', '__states', '__snapA', '__base'].filter((k) => w[k] !== undefined),
		};
	});

	expect.soft(leaks.renderClient, 'KDRenderClient injected by an earlier spec').toBe('undefined');
	expect.soft(leaks.delta, 'KDDelta injected by an earlier spec').toBe('undefined');
	expect.soft(leaks.advanceGuarded, 'KinkyDungeonAdvanceTime still wrapped by disableLocalSim').toBe(false);
	expect.soft(leaks.sendInputGuarded, 'KDSendInput still wrapped by disableLocalSim').toBe(false);
	expect.soft(leaks.localSimDisabled, 'page still in render-only client mode').toBe(false);
	expect.soft(leaks.scratch, 'scratch globals left on window by an earlier spec').toEqual([]);

	// The invariant that actually bites: a turn must be able to advance.
	const advanced = await kdPage.evaluate(() => {
		// @ts-ignore — KD globals
		const before = KinkyDungeonCurrentTick;
		// @ts-ignore
		KinkyDungeonAdvanceTime(1);
		// @ts-ignore
		return { before, after: KinkyDungeonCurrentTick };
	});
	expect(advanced.after, 'local turn advance is blocked on the shared page').toBeGreaterThan(advanced.before);
});
