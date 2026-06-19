/**
 * E2E test: title screen renders and the canvas is alive.
 *
 * Verifies the full pipeline: index.html loads, all script tags execute in order,
 * out/main.js initializes PIXI, the title screen renders to #MainCanvas.
 *
 * No state-mutation assertions — this is a pure "did the bundle bring up a
 * usable game?" smoke test.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('title screen renders with a non-empty canvas', async ({ kdPage }) => {
	const canvas = kdPage.locator('#MainCanvas');
	await expect(canvas).toBeVisible();

	const box = await canvas.boundingBox();
	expect(box, 'canvas should have a bounding box').not.toBeNull();
	expect(box!.width).toBeGreaterThan(100);
	expect(box!.height).toBeGreaterThan(100);

	// Sanity: the new-game entry point is callable from the title screen
	const hasStart = await kdPage.evaluate(() =>
		// @ts-ignore — KD globals
		typeof KinkyDungeonStartNewGame === 'function',
	);
	expect(hasStart).toBe(true);

	// Visual smoke. Tolerance is generous — we're confirming "something rendered",
	// not pixel-perfect fidelity. The snapshot is committed on first run.
	await expect(kdPage).toHaveScreenshot('title-screen.png', {
		maxDiffPixelRatio: 0.05,
	});
});
