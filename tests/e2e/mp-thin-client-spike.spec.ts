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

	/*
	 * KDM-222: settle the LIGHTMAP too, and discard that render as well.
	 *
	 * The warm-up above fixes asset loading; this fixes a second, independent transient. The FIRST
	 * lightmap recompute after KinkyDungeonStartNewGame does not produce the same picture as every
	 * later one — measured, flagging the grid again on an untouched world moves the frame 0.0342, 16x
	 * the noise floor, with no apply() anywhere near it. A THIRD flag then moves it 0.0022, i.e. noise:
	 * the recompute is idempotent from the second pass on. Taking the ground truth before that second
	 * pass is what made a self-apply look like it landed 0.033 from its own world.
	 */
	await isolatedPage.evaluate(() => {
		// @ts-ignore
		KinkyDungeonUpdateLightGrid = true;
	});
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

	// 2. and it REACHES A: the applied frame is at A's own picture, within a small multiple of this
	//    run's noise floor. KDM-222 tightened this from `worldGap * 0.75` (0.088 — a direction
	//    assertion) after removing the two things that kept the applied frame away from A.
	//    Measured after those fixes: distanceToA 0.0052 against a 0.0015 noise floor (3.4x) and a
	//    0.1179 world gap, i.e. 4% of the gap rather than 54%. The bound takes the larger of 8x noise
	//    and a 0.012 absolute floor, so an unusually quiet run cannot make it bite spuriously.
	const reachedA = Math.max(noise * 8, 0.012);
	expect(distanceToA, `applied frame must REACH A's picture: ${distanceToA.toFixed(4)} vs bound ${reachedA.toFixed(4)} (noise ${noise.toFixed(4)}, world gap ${worldGap.toFixed(4)})`)
		.toBeLessThan(reachedA);

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
	 * KDM-222 — THE RESIDUAL IS GONE; assertion 2 is now an equality-grade bound, not a direction.
	 *
	 * KDM-219 recorded ~3% of this surface as "simply not reproducible across a map swap" and guessed
	 * HUD/overlay repaint. That guess was wrong, and it was TWO separate causes, neither of them an
	 * overlay. Both were found by rendering the diff as a MASK and looking at where the pixels are —
	 * the row/column histogram named the region in one run, after argument had gone nowhere:
	 *
	 *  1. AN UNSETTLED LIGHTMAP IN THE GROUND TRUTH (0.034 of it). Not apply()'s doing at all: with no
	 *     apply anywhere, flagging KinkyDungeonUpdateLightGrid on an untouched world moved the frame
	 *     0.0342. The first recompute after StartNewGame differs from every later one; from the second
	 *     pass on it is idempotent (0.0022 = noise). Closed by the light-settle in the warm-up above.
	 *     The discriminator that proved apply() innocent: the self-applied frame sits 0.0020 — the
	 *     noise floor — from a frame that had only been light-recomputed.
	 *  2. A LOST ALT-TYPE (0.054 of it, cross-world only). KinkyDungeonVision looks up `lightParams`
	 *     via `KDGetAltType(level)`, which resolves off KDGameData.RoomType / .MapMod
	 *     (KinkyDungeonGame.ts:4300-4304) — NOT off the level number. serialize() carried level and
	 *     checkpoint but not those two, so adopting the Journey hub with RoomType left at '' fell back
	 *     to KinkyDungeonBossFloor(0) and the default shadow colour. Measured at the data level:
	 *     ShadowGrid 384/384 cells different (0x703 → 0x1f) while BrightnessGrid and ColorGrid stayed
	 *     BIT-IDENTICAL, which is why it read as a whole-room tint along the tile texture edges.
	 *     Closed in render-client.js (serialize + apply now carry RoomType/MapMod). In production
	 *     these already rode along in the bundle; this closes the bundle-less snapshot path.
	 *
	 * Net: distanceToA 0.0707 → 0.0539 (fix 1) → 0.0052 (fix 2), against a 0.0015 noise floor and an
	 * unchanged 0.1179 world gap. disableLocalSim was never the cause (it moves the frame 0.0022).
	 *
	 *  M3. NEW MUTANT (KDM-222): drop the `KDGameData.RoomType` restore from render-client's apply().
	 *      Every globals assertion still passes, assertion 1 still passes, and M2's light-invalidation
	 *      is untouched — only assertion 2 notices, at 0.0539 against a 0.012 bound. That is what the
	 *      tightened bound buys: at the old `worldGap * 0.75` (0.088) this mutant sailed through.
	 */
});
