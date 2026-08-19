/**
 * E2E (Playwright/Chromium): KD-071 Step-0 thin-client feasibility spike.
 *
 * The MVP's #1 risk: can the stock KD renderer be driven PURELY from an injected
 * render-state snapshot, with NO local simulation? This proves it in a real browser:
 *  - load the bundle, start game A, snapshot it (window.__snapA);
 *  - regenerate a DIFFERENT game B (different map) and render it;
 *  - apply snapshot A via the thin-client (`KDRenderClient.apply`) WITHOUT advancing
 *    time, and assert the render globals now reflect A, not B, while
 *    KinkyDungeonCurrentTick did NOT move (no simulation).
 *
 * The proof is at the level of the render GLOBALS. It used to claim the canvas too;
 * that assertion was vacuous and is gone — see the long note at the end (KDM-217).
 *
 * Go/no-go gate for the KD-071 client design. Uses the production client core
 * `tools/mp-server/client/render-client.js` (same snapshot shape as the host).
 *
 * KDM-216 — uses `isolatedPage`, NOT `kdPage`. This spec injects render-client.js and
 * calls disableLocalSim(), which installs permanent __kdClientGuard wrappers that make
 * KinkyDungeonAdvanceTime a no-op. resetKDState() cannot undo a monkey-patch, so on the
 * worker-scoped shared page every later spec — all four integration specs included —
 * inherited a game that could not advance a turn. Its own context, its own mess.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { installRenderSurfaceReader, readRenderSurface, PAINTED_MIN_COLORS } from './helpers/render-surface';

test('stock renderer is driven purely from an applied render-state snapshot (no local sim)', async ({ isolatedPage }) => {
	// KDM-217: arm the render-surface reader BEFORE the bundle brings PIXI up — the
	// frame read at the end takes PIXIapp.view's pixels, which WebGL would otherwise
	// have discarded by the time we look.
	await installRenderSurfaceReader(isolatedPage);
	await bootKD(isolatedPage);

	// Inject the production thin-client core (classic script → shares bundle scope).
	await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });
	expect(await isolatedPage.evaluate(() => typeof (window as any).KDRenderClient)).toBe('object');

	// --- Game A: start, render, snapshot ---
	const a = await isolatedPage.evaluate(() => {
		// @ts-ignore KD globals
		KDsetSeed && KDsetSeed('thin-client-spike-A');
		// @ts-ignore
		KinkyDungeonStartNewGame(false);
		// @ts-ignore
		KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
		// @ts-ignore
		(window as any).__snapA = (window as any).KDRenderClient.serialize();
		// @ts-ignore
		return { grid: KDMapData.Grid, px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y, tick: KinkyDungeonCurrentTick };
	});
	await isolatedPage.waitForTimeout(300);

	// --- Game B: a DIFFERENT dungeon, rendered ---
	const b = await isolatedPage.evaluate(() => {
		// @ts-ignore
		KDsetSeed && KDsetSeed('thin-client-spike-B-different');
		// @ts-ignore
		KinkyDungeonStartNewGame(false);
		// @ts-ignore
		KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
		// @ts-ignore
		return { grid: KDMapData.Grid, px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y };
	});
	await isolatedPage.waitForTimeout(300);

	// the two games must actually differ, else the test proves nothing
	expect(a.grid).not.toBe(b.grid);

	// --- Apply snapshot A onto game B, render-only, NO AdvanceTime ---
	const c = await isolatedPage.evaluate(() => {
		// @ts-ignore
		const before = KinkyDungeonCurrentTick;
		// @ts-ignore
		const role = (window as any).KDRenderClient.disableLocalSim();
		// @ts-ignore
		(window as any).KDRenderClient.apply((window as any).__snapA);
		// @ts-ignore
		return { role, tickBefore: before, tickAfter: KinkyDungeonCurrentTick, grid: KDMapData.Grid, px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y };
	});
	await isolatedPage.waitForTimeout(300);
	const frameC = await readRenderSurface(isolatedPage);

	// render globals now reflect snapshot A, not game B
	expect(c.grid).toBe(a.grid);
	expect(c.grid).not.toBe(b.grid);
	expect(c.px).toBe(a.px);
	expect(c.py).toBe(a.py);

	// NO simulation happened: the turn counter did not move during apply
	expect(c.tickAfter).toBe(c.tickBefore);

	// the client marked itself render-only (disableLocalSim returns the flag — KD-085
	// reverted the KDServerRole game-source flag; the client is pure monkey-patch).
	expect(c.role).toBe(true);

	/*
	 * The render surface is REAL — read off PIXIapp.view, the actual canvas.
	 *
	 * KDM-217: this spec used to end with
	 *     expect(Buffer.compare(shotC, shotB)).not.toBe(0)
	 * over `locator('#MainCanvas').screenshot()`, commented "the CANVAS reflects the
	 * applied snapshot". Two things were wrong with it, and the second is why the
	 * comparison is GONE rather than merely re-pointed:
	 *
	 * 1. WRONG SURFACE. #MainCanvas is a dead 300x150 placeholder nothing draws to
	 *    (KDM-169). It discriminated only because an element screenshot captures the
	 *    composited page clipped to the element's box — "the top-left 300x150 of the
	 *    page", incidentally over the PIXI canvas. See helpers/render-surface.ts.
	 *
	 * 2. NOTHING TO SEE. Games A and B are not visually different worlds. Both seeds
	 *    land in the SAME "Floor 0: Journey Selection" hub room — KinkyDungeonStartNewGame
	 *    always starts there — so A and B differ in map DATA (asserted above: a.grid !==
	 *    b.grid) but render as the same room in different light. Measured, settled, as a
	 *    fraction of differing pixels on the real surface:
	 *        same-world noise floor .......... 0.0022
	 *        A vs B (the "different worlds") . 0.1210   ← lighting, not layout
	 *        after apply(): C vs B ........... 0.0394
	 *        after apply(): C vs A ........... 0.1229   ← C is no closer to A than B was
	 *    C stays B's picture. And the mutation check settles it: with apply() REMOVED and
	 *    only the pinGameScreen light-grid flag left, C-vs-B is still 0.0336 — 15x the
	 *    noise floor. Every "the frames differ" assertion available here passes with the
	 *    thing under test deleted. A vacuous green is worse than no assertion, so what
	 *    remains is the one claim the pixels actually support: something is painted.
	 *
	 * The spec's real proof of adoption is above and unaffected: c.grid/px/py === A's,
	 * from a snapshot, with the tick frozen. Restoring a genuine visual assertion needs
	 * two genuinely different maps — filed as KDM-219.
	 */
	expect(frameC.colors, 'render surface should hold a painted frame').toBeGreaterThan(PAINTED_MIN_COLORS);
});
