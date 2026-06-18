/**
 * KD bundle utilities for Playwright tests.
 * The KD codebase is a globals-only bundle (Game/src/**.ts compiled into a single
 * out/main.js, loaded by index.html). Tests never import source files; they load
 * the real page in Chromium and exercise the resulting globals via page.evaluate.
 */
import type { Page } from '@playwright/test';

/**
 * Waits until out/main.js has finished initializing — checked via the presence of
 * representative top-level KD functions. ~1–2s on a warm cache.
 */
export async function waitForBundleReady(page: Page, timeout = 30_000): Promise<void> {
	await page.waitForFunction(
		// @ts-ignore — KD globals are not typed; they exist in the browser.
		() => typeof KinkyDungeonStartNewGame === 'function' && typeof KDFactionRelation === 'function',
		undefined,
		{ timeout },
	);
}

/**
 * Returns the version string declared by KDVersionStr in the translation table.
 * Useful for sanity-asserting we're testing the right bundle.
 */
export async function getKDVersion(page: Page): Promise<string> {
	return page.evaluate(() => {
		// @ts-ignore
		return TextGet('KDVersionStr') as string;
	});
}
