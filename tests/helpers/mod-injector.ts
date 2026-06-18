/**
 * Mod injection for tests. Mirrors the production mod loader path at
 * Scripts/KDMods.ts:483 (`eval(res)`), minus the zip-extraction step.
 *
 * Pass any JS string that would normally live in a mod's init.js/init.ks.
 * The code runs in the page's global scope, identical to a real mod load.
 */
import type { Page } from '@playwright/test';

export async function injectMod(page: Page, modCode: string): Promise<void> {
	await page.evaluate((code) => {
		// Indirect eval — runs in global scope, NOT in the page.evaluate function scope.
		// Matches the production mod loader where `eval(res)` is at top level.
		(0, eval)(code);
	}, modCode);
}
