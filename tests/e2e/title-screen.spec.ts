/**
 * E2E test: the game boots to its title screen and the renderer is alive.
 *
 * Verifies the full pipeline: index.html loads, all script tags execute in order,
 * out/main.js initializes PIXI, the boot sequence walks through to the title
 * screen, and the renderer paints real content to its canvas.
 *
 * No state-mutation assertions — this is a pure "did the bundle bring up a
 * usable game?" smoke test.
 *
 * KDM-169 — this spec used to reuse the worker-scoped `kdPage`/`sharedPage`
 * fixture and assert a committed PNG baseline. Both were wrong:
 *
 *  1. ORDER DEPENDENCE. `sharedPage` is one Page for the whole worker, and
 *     `mp-thin-client-spike` / `mp-thin-client-ws` sort before this file and used
 *     the same fixture. They call KinkyDungeonStartNewGame() and
 *     KDRenderClient.disableLocalSim(), neither of which resetKDState() undoes,
 *     so this spec screenshotted a live dungeon: 737k px / ratio 0.81 different.
 *     It "passed on retry" only because a retry gets a fresh worker, hence a
 *     fresh page. (KDM-216 has since moved those two specs off the shared page
 *     as well, but this spec stays isolated on its own merits — it asserts a
 *     COLD BOOT, which a reset-in-place shared page cannot give it.)
 *  2. A MEANINGLESS BASELINE. The committed title-screen.png was not a title
 *     screen at all — it was the asset preloader mid-load ("Preloading Character
 *     Assets: 34%"). It only ever matched because the changing percentage is a
 *     tiny fraction of the frame, well under the 5% tolerance. The baseline is
 *     deleted rather than regenerated: this test wants "something rendered",
 *     which a pixel baseline answers badly and rots at.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { installRenderSurfaceReader, readRenderSurface, PAINTED_MIN_COLORS } from './helpers/render-surface';

test('title screen boots and paints a live canvas', async ({ isolatedPage }) => {
	await installRenderSurfaceReader(isolatedPage);
	await bootKD(isolatedPage);

	// The new-game entry point is callable from the title screen.
	const hasStart = await isolatedPage.evaluate(() =>
		// @ts-ignore — KD globals
		typeof KinkyDungeonStartNewGame === 'function',
	);
	expect(hasStart).toBe(true);

	// A real boot signal, not a sleep: the game walks Logo → Consent → Intro,
	// and 'Intro' IS the title screen.
	await isolatedPage.waitForFunction(
		// @ts-ignore — KD globals
		() => KinkyDungeonState === 'Intro',
		undefined,
		{ timeout: 30_000 },
	);

	// The renderer's own surface — PIXIapp.view, NOT the dead #MainCanvas placeholder
	// (helpers/render-surface.ts explains why locating that element is always a mistake).
	const frame = await readRenderSurface(isolatedPage);
	expect(frame.w).toBeGreaterThan(100);
	expect(frame.h).toBeGreaterThan(100);

	// Visual smoke: the canvas holds real, non-uniform painted content.
	// Measured on the title screen: hundreds of distinct colours; a blank buffer is 1.
	expect(frame.colors, 'render surface should hold non-uniform painted content').toBeGreaterThan(PAINTED_MIN_COLORS);
});
