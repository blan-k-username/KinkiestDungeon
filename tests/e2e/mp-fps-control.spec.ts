/**
 * E2E — is the 3 fps real, or is my harness lying? (KDM-186)
 *
 * `mp-input-matrix` measured the co-op client at 3 fps, which would explain every UAT symptom (KD
 * samples transient key state per frame, so at ~300 ms/frame a normal keypress falls between polls).
 * But headless Chromium throttles rAF for backgrounded/occluded pages, so 3 fps might be an artifact
 * of the test environment rather than a property of the proxy.
 *
 * This spec settles it with CONTROLS, on the same server, in the same browser, in one run:
 *
 *   A) plain single-player page (NO #coop)      — the game with the proxy entirely out of the picture
 *   B) same page after bringToFront()           — un-occludes it; isolates renderer backgrounding
 *   C) co-op client page (#coop=A, never paired) — the proxy's client, before any session traffic
 *
 * If A ≈ C, the frame rate is the harness and the proxy is exonerated. If A is fast and C is slow,
 * the client loop is genuinely starved and that is the root cause to fix.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Real frames per second, counted from rAF callbacks. */
async function fps(P: Page, ms = 3000) {
	return P.evaluate((d) => new Promise<number>((res) => {
		let n = 0; const t0 = performance.now();
		(function f() { n++; if (performance.now() - t0 < d) requestAnimationFrame(f); else res(Math.round(n / (d / 1000))); })();
	}), ms);
}

/** Wait for the bundle to finish preloading, without assuming co-op is involved. */
async function waitLoaded(P: Page, timeout = 240_000) {
	await P.waitForFunction(() => typeof (window as any).KDLoadingFinished !== 'undefined'
		&& (window as any).KDLoadingFinished === true, undefined, { timeout }).catch(() => {});
}

test('frame-rate controls: plain game vs co-op client', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctx = await browser.newContext();
	const out: any = {};

	try {
		// A) the stock single-player page — proxy client not active (no #coop ⇒ bootstrap returns early)
		const plain = await ctx.newPage();
		await plain.goto(`http://127.0.0.1:${port}/`);
		await waitLoaded(plain);
		out.plainFps = await fps(plain);

		// B) same page, explicitly foregrounded
		await plain.bringToFront();
		out.plainFpsForeground = await fps(plain);

		// C) a co-op client page (unpaired: no partner, so no session traffic at all)
		const coop = await ctx.newPage();
		await coop.goto(`http://127.0.0.1:${port}/#coop=SOLO`);
		await waitLoaded(coop);
		await coop.bringToFront();
		out.coopFps = await fps(coop);

		expect(out.plainFps > 20 && out.coopFps > 20,
			'FRAME-RATE CONTROLS ' + JSON.stringify(out)).toBe(true);
	} finally {
		await ctx.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
