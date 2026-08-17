/**
 * E2E — what does the co-op proxy actually cost in frames? (KDM-186, corrected by KDM-205)
 *
 * `mp-input-matrix` measured the co-op client at 3 fps, which would explain every UAT symptom (KD
 * samples transient key state per frame, so at ~300 ms/frame a normal keypress falls between polls).
 * But headless Chromium software-renders with no GPU, so a low number might be the environment rather
 * than a property of the proxy. This spec exists to tell those apart with an in-run control.
 *
 * ⚠️ KDM-205 — THE ORIGINAL CONTROL WAS INVALID, AND ITS VERDICT WAS WRONG. It measured:
 *
 *     A) plain page, no #coop        →  plainFps 37-47   ... rendering the MAIN MENU
 *     C) #coop=SOLO, never paired    →  coopFps   4-8    ... rendering a full DUNGEON
 *
 * and asserted `plainFps > 20 && coopFps > 20`, concluding from the 6-10x gap that "the client loop is
 * genuinely starved". It is not. The two arms were drawing different things:
 *
 *   - a plain page never leaves `KinkyDungeonState = "Logo"/"Menu"` (Game/src/base/KinkyDungeon.ts:134).
 *     `waitLoaded` only awaits `KDLoadingFinished`, which is ASSET PRELOAD, not a started game.
 *   - the co-op page runs `KinkyDungeonStartNewGame(false)` via `forceGameScreen()`
 *     (tools/mp-server/client/coop-bootstrap.js:400) and pins `KinkyDungeonState = 'Game'`.
 *
 * MEASURED with a fair control (same page: menu, then a real game; then the co-op client), twice, on
 * separate runs:
 *
 *     run 1   menuFps 29     gameFps 6     coopFps 4     game/coop 1.50   (integer meter, 3 s)
 *     run 2   menuFps 42     gameFps 8     coopFps 5     game/coop 1.60   (integer meter, 3 s)
 *     run 3   menuFps 48     gameFps 9     coopFps 5     game/coop 1.80   (integer meter, 8 s)
 *     run 4   menuFps 46.5   gameFps 8.2   coopFps 4.4   game/coop 1.86   (1-dp meter, 8 s)
 *
 * The menu reading swings 29->48 with host load while the RATIO holds. So a dungeon costs ~5x a menu
 * whether or not a proxy exists, and the proxy's real cost is ~1.86x — not the 6-10x the old spec
 * implied. The 1.50/1.60 in the early runs were the integer meter under-reading, not a faster proxy:
 * runs 3 and 4 agree once the reading is precise.
 *
 * ⚠️ ~1.86x against the 2x line below is only ~7% of headroom, and that cost is NOT yet attributed —
 * it is real, not measurement error. Tracked as its own investigation; do NOT respond to a red here by
 * widening the line.
 *
 * Two consequences, both load-bearing for how this spec is now written:
 *
 *   1. Both arms must render a DUNGEON. Case A therefore starts a real single-player game, exactly as
 *      the co-op bootstrap does, so the only difference left between the arms is the proxy.
 *   2. The assertion must be a RATIO, not an absolute. `coopFps > 20` is unreachable in a dungeon on a
 *      headless host no matter how fast the proxy is — the UN-PROXIED game manages 6-8. An absolute
 *      threshold here measures the host; the ratio measures the product.
 *
 * This is NOT a loosened budget: the invalid baseline (a menu) is replaced by a valid one (the same
 * game, un-proxied), and a real assertion is kept against it. A proxy regression past 2x still fails.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Real frames per second, counted from rAF callbacks.
 *
 * KDM-205 — the DUNGEON readings need a LONG window AND a fractional result, and the second mattered
 * more than the first. At the ~5 fps a headless dungeon runs at, a 3 s window counts only ~15 frames.
 * But lengthening it alone changed nothing, because the old meter rounded the RATE
 * (`Math.round(n / (d/1000))`): every reading carried ±0.5 fps ≈ ±10% however long the sample ran, and
 * the ratio multiplied that across both arms. Hence one decimal place, over ~40 frames.
 *
 * This is noise reduction, NOT a relaxed budget — the 2x line is untouched; only the precision of the
 * numbers fed into it improves. Ten extra seconds is nothing beside the two page boots this spec pays.
 */
const DUNGEON_SAMPLE_MS = 8000;

async function fps(P: Page, ms = 3000) {
	return P.evaluate((d) => new Promise<number>((res) => {
		let n = 0; const t0 = performance.now();
		(function f() {
			n++;
			if (performance.now() - t0 < d) requestAnimationFrame(f);
			// KDM-205: ONE DECIMAL, not an integer. `Math.round(n / (d/1000))` rounded the RATE, so at
			// ~5 fps every reading carried ±0.5 fps ≈ ±10% NO MATTER HOW LONG the window was — and the
			// ratio below multiplied that error across both arms. Lengthening the window alone did not
			// help precisely because the rounding was applied after the division.
			else res(Math.round(10 * n / ((performance.now() - t0) / 1000)) / 10);
		})();
	}), ms);
}

/** Wait for the bundle to finish preloading, without assuming co-op is involved. */
async function waitLoaded(P: Page, timeout = 240_000) {
	await P.waitForFunction(() => typeof (window as any).KDLoadingFinished !== 'undefined'
		&& (window as any).KDLoadingFinished === true, undefined, { timeout }).catch(() => {});
}

/** What KD believes it is drawing — the validity evidence behind each reading. */
async function screen(P: Page) {
	// @ts-ignore bare let-globals
	return P.evaluate(() => ({ state: KinkyDungeonState, draw: KinkyDungeonDrawState }));
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
		await plain.bringToFront();
		out.menuFps = await fps(plain);          // retained for reference: this is the OLD "plainFps"

		// …now start a REAL game in that same page, so the control renders what the co-op page renders.
		// Same call the co-op bootstrap makes (coop-bootstrap.js:519). Same page ⇒ same browser, process,
		// GPU context and moment in time as the reading above.
		out.startedGame = await plain.evaluate(() => {
			try {
				// @ts-ignore bare let-globals
				KinkyDungeonStartNewGame(false);
				// @ts-ignore
				KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
				// @ts-ignore
				if (typeof KinkyDungeonUpdateLightGrid !== 'undefined') KinkyDungeonUpdateLightGrid = true;
				return true;
			} catch (e) { return String((e as any) && (e as any).message || e); }
		});
		await plain.waitForTimeout(2000);        // let the first dungeon frames settle
		out.plainScreen = await screen(plain);
		out.gameFps = await fps(plain, DUNGEON_SAMPLE_MS);   // THE BASELINE: a dungeon, un-proxied

		// C) a co-op client page (unpaired: no partner, so no session traffic at all)
		const coop = await ctx.newPage();
		await coop.goto(`http://127.0.0.1:${port}/#coop=SOLO`);
		await waitLoaded(coop);
		await coop.bringToFront();
		await coop.waitForTimeout(2000);
		out.coopScreen = await screen(coop);
		out.coopFps = await fps(coop, DUNGEON_SAMPLE_MS);
		out.proxyCost = out.coopFps ? +(out.gameFps / out.coopFps).toFixed(2) : null;

		const msg = 'PROXY FRAME COST ' + JSON.stringify(out);
		// Report on SUCCESS too — this spec exists to measure, and a number only visible when it fails
		// cannot show the ratio drifting toward the limit before it crosses it.
		// eslint-disable-next-line no-console
		console.log(msg);

		// VALIDITY FIRST — a ratio between two readings is meaningless if either arm drew the wrong
		// thing, and "both slow" would otherwise pass this test while measuring nothing.
		expect(out.startedGame, `the control must actually start a game, else gameFps is a MENU reading ` +
			`and the comparison is the invalid one KDM-205 removed. ${msg}`).toBe(true);
		expect(out.plainScreen.state, `the control reading must be taken in Game. ${msg}`).toBe('Game');
		expect(out.coopScreen.state, `the co-op reading must be taken in Game. ${msg}`).toBe('Game');
		expect(out.gameFps, `the control must produce real frames. ${msg}`).toBeGreaterThan(0);

		// THE ASSERTION — the proxy may not cost more than 2x the un-proxied game rendering the same
		// dungeon. Measured 1.50 / 1.60 / 1.80 across three runs, so 2x is the regression line rather
		// than a ceiling fitted to today's number. The headroom over 1.80 is thin, which is exactly why
		// the readings above use DUNGEON_SAMPLE_MS: the spread is measurement quantisation, not the
		// proxy moving. If this ever goes red, check `gameFps`/`coopFps` frame COUNTS before assuming a
		// regression — a red at ~2.0 with single-digit fps is the harness, not the product.
		expect(out.coopFps > out.gameFps / 2, msg).toBe(true);
	} finally {
		await ctx.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
