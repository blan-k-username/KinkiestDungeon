/**
 * Custom Playwright fixtures for KD tests.
 *
 * Strategy:
 *  - `sharedPage` — worker-scoped, single Page with bundle pre-loaded.
 *    Amortizes the 1–2s bundle load across every test in the worker.
 *  - `kdPage` — test-scoped, resets KD state via existing init functions
 *    before each test. Reuses sharedPage, so no second bundle load.
 *  - `isolatedPage` — test-scoped, its OWN context. For specs that permanently
 *    mutate the page, or that need a cold boot. Handed over BEFORE navigation so
 *    the spec can patch what the bundle reads on its way up; call `bootKD(page)`
 *    to bring it up.
 *
 * Use `test`/`expect` from this module in every integration/e2e spec.
 *
 * KDM-216 — WHICH ONE DO I WANT? Default to `kdPage`; it is the cheap one.
 * Reach for `isolatedPage` when your spec leaves something behind that
 * `resetKDState()` cannot undo — a monkey-patched global, an injected script tag,
 * an open socket. That helper re-runs KD's init functions; it does not restore
 * patched globals, so a permanent patch on the shared page is inherited by every
 * spec that follows in the worker.
 *
 * That was not hypothetical. The thin-client specs called
 * `KDRenderClient.disableLocalSim()`, whose `__kdClientGuard` wrapper makes
 * `KinkyDungeonAdvanceTime` a no-op, and left `KDRenderClient` / `KDDelta` / an
 * open WebSocket on `window`. With `workers: 1` and `tests/e2e` sorting before
 * `tests/integration`, everything after them — all four integration specs
 * included — ran against a game that could not advance a turn.
 * `tests/e2e/shared-page-clean-slate.spec.ts` now guards the invariant.
 */
import { test as base, type Page } from '@playwright/test';
import { bootKD } from './bundle';
import { resetKDState } from './state';

type WorkerFixtures = {
	sharedPage: Page;
};

type TestFixtures = {
	kdPage: Page;
	isolatedPage: Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
	sharedPage: [
		async ({ browser }, use) => {
			const context = await browser.newContext();
			const page = await context.newPage();
			await bootKD(page);
			await use(page);
			await context.close();
		},
		{ scope: 'worker' },
	],

	kdPage: async ({ sharedPage }, use) => {
		await resetKDState(sharedPage);
		await use(sharedPage);
	},

	isolatedPage: async ({ browser }, use) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		// Deliberately NOT navigated: addInitScript only takes effect before load,
		// which is the whole reason some specs need their own page. Call bootKD().
		await use(page);
		// Teardown runs even when the test failed, so the context never outlives it.
		await context.close();
	},
});

export { expect } from '@playwright/test';
