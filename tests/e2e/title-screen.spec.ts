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

/**
 * WebGL discards its drawing buffer after compositing unless asked not to, so
 * drawImage() off the live view returns a blank frame and the renderer exposes
 * no extract plugin to go around it. Forcing preserveDrawingBuffer at the
 * getContext seam — before the bundle runs — is what makes the painted output
 * readable from inside the page. Test-only, and scoped to this spec's own context.
 */
function preserveDrawingBuffer() {
	const orig = HTMLCanvasElement.prototype.getContext;
	(HTMLCanvasElement.prototype as any).getContext = function (type: string, attrs?: any) {
		if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
			attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
		}
		return orig.call(this, type, attrs);
	};
}



/** Distinct colours in a downsampled copy of the render surface. A canvas that never painted returns 1. */
function countRenderedColors() {
	// @ts-ignore — KD globals
	const view = PIXIapp.view as HTMLCanvasElement;
	const sample = document.createElement('canvas');
	sample.width = 500;
	sample.height = 250;
	const ctx = sample.getContext('2d')!;
	ctx.drawImage(view, 0, 0, sample.width, sample.height);
	const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
	const seen = new Set<number>();
	for (let i = 0; i < data.length; i += 4 * 13) {
		seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
	}
	return seen.size;
}

test('title screen boots and paints a live canvas', async ({ isolatedPage }) => {
	await isolatedPage.addInitScript(preserveDrawingBuffer);
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

	// The renderer's own surface — note #MainCanvas is an unused 300x150
	// placeholder in index.html; PIXI appends the real 2000x1000 view to body,
	// so the old assertions about #MainCanvas's size were measuring nothing.
	const view = await isolatedPage.evaluate(() => ({
		// @ts-ignore — KD globals
		w: PIXIapp.view.width as number,
		// @ts-ignore
		h: PIXIapp.view.height as number,
	}));
	expect(view.w).toBeGreaterThan(100);
	expect(view.h).toBeGreaterThan(100);

	// Visual smoke: the canvas holds real, non-uniform painted content.
	// Measured on the title screen: ~250 distinct colours; a blank buffer is 1.
	const colors = await isolatedPage.evaluate(countRenderedColors);
	expect(colors, 'render surface should hold non-uniform painted content').toBeGreaterThan(20);
});
