/**
 * Custom Playwright fixtures for KD tests.
 *
 * Strategy:
 *  - `sharedPage` — worker-scoped, single Page with bundle pre-loaded.
 *    Amortizes the 1–2s bundle load across every test in the worker.
 *  - `kdPage` — test-scoped, resets KD state via existing init functions
 *    before each test. Reuses sharedPage, so no second bundle load.
 *
 * Use `test`/`expect` from this module in every integration/e2e spec.
 */
import { test as base, type Page } from '@playwright/test';
import { waitForBundleReady } from './bundle';
import { resetKDState } from './state';

type WorkerFixtures = {
	sharedPage: Page;
};

type TestFixtures = {
	kdPage: Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
	sharedPage: [
		async ({ browser }, use) => {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto('/');
			await waitForBundleReady(page);
			await use(page);
			await context.close();
		},
		{ scope: 'worker' },
	],
	kdPage: async ({ sharedPage }, use) => {
		await resetKDState(sharedPage);
		await use(sharedPage);
	},
});

export { expect } from '@playwright/test';
