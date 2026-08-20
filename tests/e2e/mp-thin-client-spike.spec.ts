/**
 * E2E (Playwright/Chromium): KD-071 Step-0 thin-client feasibility spike.
 *
 * The MVP's #1 risk: can the stock KD renderer be driven PURELY from an injected
 * render-state snapshot, with NO local simulation? This proves it in a real browser:
 *  - load the bundle, start game A, snapshot it (window.__snapA);
 *  - generate a VISIBLY different world B and render it;
 *  - apply snapshot A via the thin-client (`KDRenderClient.apply`) WITHOUT advancing
 *    time, and assert both the render globals AND THE PIXELS now reflect A, not B,
 *    while KinkyDungeonCurrentTick did NOT move (no simulation).
 *
 * KDM-219 restored the pixel half of that claim. Read the note at the end before
 * touching the frame assertions — three separate ways to make them vacuous are
 * measured there, and two of them looked fine.
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
import { installRenderSurfaceReader, readRenderSurface, frameDiffRatio, PAINTED_MIN_COLORS } from './helpers/render-surface';

/** Long enough for the renderer to settle after a map swap (measured: the frame is stable well inside this). */
const SETTLE = 2500;

/** Runs IN THE PAGE. World A: the stock new game — the "Floor 0: Journey Selection" hub. */
const makeHub = () => {
	// @ts-ignore KD globals
	KDsetSeed && KDsetSeed('thin-client-spike-A');
	// @ts-ignore
	KinkyDungeonStartNewGame(false);
	// @ts-ignore
	KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
	// @ts-ignore
	KinkyDungeonUpdateLightGrid = true;
};

/**
 * Runs IN THE PAGE. World B: a REAL dungeon floor, via the game's own generator.
 *
 * KDM-219: this is the whole point. `KinkyDungeonStartNewGame` always lands in the same hub
 * room, so two seeds gave two worlds that differed in map DATA and rendered the SAME room —
 * there was nothing for a frame assertion to see. `KinkyDungeonCreateMap` at floor 3 gives a
 * genuinely different picture (measured: 37x44 vs the hub's 24x16) and costs no extra page
 * boot, which is the RAM budget that matters here (see reference: webkit page-death flake).
 * It must run AFTER a StartNewGame — on a fresh page it throws on `KDMapData.HiddenRooms`.
 */
const makeDungeon = () => {
	// @ts-ignore
	KDsetSeed && KDsetSeed('thin-client-spike-B-dungeon');
	// @ts-ignore
	KinkyDungeonCreateMap(KinkyDungeonMapParams['grv'], '', '', 3, undefined, undefined, undefined, undefined, false);
	// @ts-ignore
	KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
	// @ts-ignore
	KinkyDungeonUpdateLightGrid = true;
};

test('stock renderer is driven purely from an applied render-state snapshot (no local sim)', async ({ isolatedPage }) => {
	test.setTimeout(180_000);
	// KDM-217: arm the render-surface reader BEFORE the bundle brings PIXI up — the
	// frame reads below take PIXIapp.view's pixels, which WebGL would otherwise
	// have discarded by the time we look.
	await installRenderSurfaceReader(isolatedPage);
	await bootKD(isolatedPage);

	// Inject the production thin-client core (classic script → shares bundle scope).
	await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });
	expect(await isolatedPage.evaluate(() => typeof (window as any).KDRenderClient)).toBe('object');

	/*
	 * WARM-UP, then discard. KDM-219: the FIRST rendered world after a cold boot is not the
	 * same picture as the second rendering of that same world — measured 0.1204 apart, as large
	 * as two different worlds, because sprites/models are still loading. Taking the ground truth
	 * from an unwarmed renderer is what makes an otherwise-correct frame assertion fail.
	 */
	await isolatedPage.evaluate(makeHub);
	await isolatedPage.waitForTimeout(SETTLE);

	// --- World A: build it AGAIN (the warm-up render above is discarded), then snapshot it ---
	await isolatedPage.evaluate(makeHub);
	await isolatedPage.waitForTimeout(SETTLE);

	// Snapshot it, and take the GROUND TRUTH frame + this run's own noise floor.
	const a = await isolatedPage.evaluate(() => {
		// @ts-ignore
		(window as any).__snapA = (window as any).KDRenderClient.serialize();
		// @ts-ignore
		return { grid: KDMapData.Grid, px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y, tick: KinkyDungeonCurrentTick };
	});
	const frameA = await readRenderSurface(isolatedPage);
	await isolatedPage.waitForTimeout(1200);
	const frameAgain = await readRenderSurface(isolatedPage);
	const noise = frameDiffRatio(frameA, frameAgain);

	// --- World B: a genuinely different dungeon, rendered ---
	await isolatedPage.evaluate(makeDungeon);
	await isolatedPage.waitForTimeout(SETTLE);
	const frameB = await readRenderSurface(isolatedPage);

	const bInfo = await isolatedPage.evaluate(() => ({
		// @ts-ignore
		grid: KDMapData.Grid, px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y,
	}));

	// the two worlds must actually differ — in data AND on screen, else the test proves nothing
	expect(a.grid).not.toBe(bInfo.grid);
	const worldGap = frameDiffRatio(frameA, frameB);
	expect(worldGap, 'A and B must be VISIBLY different worlds, not the same room in different light')
		.toBeGreaterThan(noise * 20);

	// --- Apply snapshot A onto world B, render-only, NO AdvanceTime ---
	const c = await isolatedPage.evaluate(() => {
		// @ts-ignore
		const before = KinkyDungeonCurrentTick;
		// @ts-ignore
		const role = (window as any).KDRenderClient.disableLocalSim();
		// NOTE: no light-grid flag here on purpose — KDM-219 moved that INTO apply(), and this
		// call site is what proves it. Setting it here would hide a regression in that fix.
		// @ts-ignore
		(window as any).KDRenderClient.apply((window as any).__snapA);
		// @ts-ignore
		return { role, tickBefore: before, tickAfter: KinkyDungeonCurrentTick, grid: KDMapData.Grid, px: KinkyDungeonPlayerEntity.x, py: KinkyDungeonPlayerEntity.y };
	});
	await isolatedPage.waitForTimeout(SETTLE);
	const frameC = await readRenderSurface(isolatedPage);

	// render globals now reflect snapshot A, not world B
	expect(c.grid).toBe(a.grid);
	expect(c.grid).not.toBe(bInfo.grid);
	expect(c.px).toBe(a.px);
	expect(c.py).toBe(a.py);

	// NO simulation happened: the turn counter did not move during apply
	expect(c.tickAfter).toBe(c.tickBefore);

	// the client marked itself render-only (disableLocalSim returns the flag — KD-085
	// reverted the KDServerRole game-source flag; the client is pure monkey-patch).
	expect(c.role).toBe(true);

	// ---- and the PIXELS moved too (KDM-219) ----
	const movedFromB = frameDiffRatio(frameC, frameB);
	const distanceToA = frameDiffRatio(frameC, frameA);

	expect(frameC.colors, 'render surface should hold a painted frame').toBeGreaterThan(PAINTED_MIN_COLORS);

	// 1. the screen left world B. Against THIS run's own noise floor, not a constant.
	expect(movedFromB, `applying a snapshot must repaint (noise floor ${noise.toFixed(4)})`)
		.toBeGreaterThan(noise * 20);

	// 2. and it moved TOWARDS A: the applied frame is markedly closer to A's own picture than
	//    B's was. This is the direction assertion the old spec could not make.
	expect(distanceToA, `applied frame must be closer to A (${distanceToA.toFixed(4)}) than B was (${worldGap.toFixed(4)})`)
		.toBeLessThan(worldGap * 0.75);

	/*
	 * WHY THESE TWO ASSERTIONS, AND NOT "THE FRAME EQUALS A" — KDM-219.
	 *
	 * The render surface is REAL: read off PIXIapp.view, the actual canvas. `#MainCanvas` is a
	 * dead 300x150 placeholder nothing draws to (KDM-169), and an element screenshot of it
	 * silently means "the top-left 300x150 of the page" (KDM-217). See helpers/render-surface.ts.
	 *
	 * This spec previously had NO frame assertion at all, because every available one passed with
	 * the thing under test deleted. Three distinct traps were measured; all three are closed above:
	 *
	 *  1. NOTHING TO SEE. Both "different" games were the same hub room in different light —
	 *     A-vs-B 0.1210, but C-vs-A 0.1229, i.e. the applied frame was no closer to A than B was.
	 *     Closed by generating a real dungeon floor for B (`makeDungeon`).
	 *  2. THE MUTANT REPAINTED ANYWAY. With apply() removed and only the light-grid flag left,
	 *     the old setup still moved 0.0336 — 15x its noise floor — so "the frame changed" was
	 *     satisfied without adopting anything. Measured again in this setup: the flag alone moves
	 *     the frame 0.0010, i.e. exactly the noise floor. The mutant is now a clean no-op.
	 *  3. AN UNWARMED GROUND TRUTH. The first world rendered after boot differs from the second
	 *     rendering of the SAME world by 0.1204 (assets still loading) — comparable to two
	 *     different worlds. Closed by the discarded warm-up above.
	 *
	 * Measured on this setup (200x100 sample, settled), which is where the factors come from:
	 *     noise floor (same world, 1.2s apart) ... 0.0015
	 *     A vs B (genuinely different worlds) .... 0.1306
	 *     C vs B after apply ..................... 0.1227   ← assertion 1, ~80x noise
	 *     C vs A after apply ..................... 0.0707   ← assertion 2, ~54% of the world gap
	 *
	 * TWO MUTANTS, RUN — and they do NOT kill the same assertion, which is the point:
	 *
	 *  M1. `apply()` removed from this spec. Dies on the GLOBALS assertions (c.grid !== a.grid)
	 *      before the frame assertions are ever reached. That mutant was always caught.
	 *  M2. The `KinkyDungeonUpdateLightGrid` invalidation removed from `apply()` itself
	 *      (render-client.js). EVERY globals assertion still passes — grid, px, py, tick, role —
	 *      because the state IS adopted. Only the pixels notice: C-vs-A 0.1243 against a
	 *      world gap of 0.1280, i.e. the screen is still showing B. This is the bug class the
	 *      frame assertions exist for, and nothing else in this spec can see it.
	 *
	 * ⚠️ Under M2, assertion 1 (`movedFromB`) STILL PASSES: adopting KDMapData repaints the tiles
	 * even with stale lighting, so "the frame changed" is satisfied by a half-applied world. It is
	 * assertion 2, the DIRECTION one, that carries the weight. Do not drop it as redundant — on its
	 * own, assertion 1 is the same shape as the vacuous assertion KDM-217 had to delete.
	 *
	 * `expect(distanceToA).toBeLessThan(0)`-style equality is NOT available and asserting it would
	 * be wrong: the applied frame does not reach A's picture. Measured, that residual is not the
	 * foreign world leaking through — applying A onto A ITSELF still lands 0.0333 from A, and
	 * regenerating the hub for real after being in B lands 0.0290 from it, both far above the
	 * 0.0015 noise floor. So a few percent of this surface is simply not reproducible across a map
	 * swap (HUD/overlay repaint; the sampled colour count moves 1363 → 1406 on a self-apply).
	 * disableLocalSim is NOT the cause: it moves the frame 0.0022, i.e. noise.
	 * Chasing that residual to zero is a separate question from "does adoption reach the screen",
	 * which is what this spec exists to answer — filed as KDM-222.
	 */
});
