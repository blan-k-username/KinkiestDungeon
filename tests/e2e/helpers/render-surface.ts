/**
 * Reading the renderer's REAL surface from a test, and comparing two frames of it.
 *
 * `#MainCanvas` (index.html) is a DEAD 300x150 PLACEHOLDER. Nothing ever draws to
 * it — its 2D context reads as a single colour (KDM-169). PIXI builds its own
 * 2000x1000 WebGL view and appends it to <body>; the renderer global is `PIXIapp`
 * and `PIXIapp.view` IS the render surface. **Never locate `#MainCanvas` in a test.**
 *
 * KDM-217 — `page.locator('#MainCanvas').screenshot()` *looks* like it works, and
 * that is the trap: Playwright's element screenshot captures the COMPOSITED PAGE
 * clipped to the element's box, not the element's own backing store. So those calls
 * really mean "the top-left 300x150 of the page", which incidentally overlaps the
 * PIXI canvas underneath. One CSS/layout change and the same comparison silently
 * starts measuring an empty region — identical in every frame, so a
 * `Buffer.compare(...) !== 0` assertion either fails for an unrelated reason or, worse,
 * passes while proving nothing. Read the surface by name instead.
 *
 * A second trap, which is why `frameDiffRatio` exists rather than a byte/hash equality:
 * this surface is NOT frame-deterministic. Idle animation and timed overlays mean two
 * frames of the SAME world already differ. So "the frames are not identical" is a
 * vacuous claim — a test that wants "the render CHANGED" must measure how much, against
 * a same-world noise floor sampled in the same run. See `frameDiffRatio`.
 *
 * Every reader below needs `installRenderSurfaceReader()` called BEFORE navigation.
 */
import type { BrowserContext, Page } from '@playwright/test';

/** Downsample grid the page-side sampler reduces the surface to. 20k pixels ships fine over CDP. */
const SAMPLE_W = 200;
const SAMPLE_H = 100;

export type RenderFrame = {
	/** Distinct RGB values in the sample. A surface that never painted returns 1. */
	colors: number;
	/** Real surface dimensions (PIXIapp.view), not the sample's. */
	w: number;
	h: number;
	/** Packed 0xRRGGBB per sampled pixel, row-major. Compare with `frameDiffRatio`. */
	pixels: number[];
};

/**
 * WebGL discards its drawing buffer after compositing unless asked not to, so
 * drawImage() off the live view returns a blank frame and the renderer exposes no
 * extract plugin to go around it. Forcing the flag at the getContext seam — before
 * the bundle runs — is what makes the painted output readable from inside the page.
 * Test-only, and scoped to the page/context it is installed on.
 */
export function preserveDrawingBuffer() {
	const orig = HTMLCanvasElement.prototype.getContext;
	(HTMLCanvasElement.prototype as any).getContext = function (type: string, attrs?: any) {
		if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
			attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
		}
		return orig.call(this, type, attrs);
	};
}

/** Arms a not-yet-navigated page or context so `readRenderSurface()` can see painted pixels. */
export async function installRenderSurfaceReader(target: Page | BrowserContext): Promise<void> {
	await target.addInitScript(preserveDrawingBuffer);
}

/** Runs IN THE PAGE — `page.evaluate` serialises the source, so it takes its sizes as args. */
function sampleRenderSurface(size: { w: number; h: number }): RenderFrame {
	// @ts-ignore — KD globals are not typed; they exist in the browser.
	const view = PIXIapp.view as HTMLCanvasElement;
	const sample = document.createElement('canvas');
	sample.width = size.w;
	sample.height = size.h;
	const ctx = sample.getContext('2d')!;
	ctx.drawImage(view, 0, 0, sample.width, sample.height);
	const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
	const pixels: number[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < data.length; i += 4) {
		const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
		pixels.push(rgb);
		seen.add(rgb);
	}
	return { colors: seen.size, w: view.width, h: view.height, pixels };
}

/** Reads the render surface of a live page. Requires `installRenderSurfaceReader()` beforehand. */
export async function readRenderSurface(page: Page): Promise<RenderFrame> {
	return page.evaluate(sampleRenderSurface, { w: SAMPLE_W, h: SAMPLE_H });
}

/**
 * Fraction of sampled pixels that differ between two frames, 0..1.
 *
 * Per-channel tolerance, so anti-aliasing jitter on an otherwise identical frame does
 * not register. Use it in a ratio, never as an absolute: read a second frame of the
 * SAME world to get this run's noise floor, then require the frame you claim changed
 * to beat it by a wide margin. That control is what keeps the assertion honest.
 */
export function frameDiffRatio(a: RenderFrame, b: RenderFrame, tolerance = 8): number {
	const n = Math.min(a.pixels.length, b.pixels.length);
	if (n === 0) throw new Error('frameDiffRatio: empty sample — was installRenderSurfaceReader() called before navigation?');
	let differing = 0;
	for (let i = 0; i < n; i++) {
		const p = a.pixels[i], q = b.pixels[i];
		if (Math.abs((p >> 16 & 255) - (q >> 16 & 255)) > tolerance
			|| Math.abs((p >> 8 & 255) - (q >> 8 & 255)) > tolerance
			|| Math.abs((p & 255) - (q & 255)) > tolerance) differing++;
	}
	return differing / n;
}

/** A painted KD frame holds far more than a handful of colours; a blank surface holds 1. */
export const PAINTED_MIN_COLORS = 20;
