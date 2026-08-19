/**
 * E2E (Playwright/Chromium): KD-071 Step-0 thin-client feasibility spike.
 *
 * The MVP's #1 risk: can the stock KD renderer be driven PURELY from an injected
 * render-state snapshot, with NO local simulation? This proves it in a real browser:
 *  - load the bundle, start game A, snapshot it (window.__snapA);
 *  - regenerate a DIFFERENT game B (different map) and render it;
 *  - apply snapshot A via the thin-client (`KDRenderClient.apply`) WITHOUT advancing
 *    time, and assert the render globals + the CANVAS now reflect A, not B, while
 *    KinkyDungeonCurrentTick did NOT move (no simulation).
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

test('stock renderer is driven purely from an applied render-state snapshot (no local sim)', async ({ isolatedPage }) => {
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
	const shotA = await isolatedPage.locator('#MainCanvas').screenshot();

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
	const shotB = await isolatedPage.locator('#MainCanvas').screenshot();

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
	const shotC = await isolatedPage.locator('#MainCanvas').screenshot();

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

	// the CANVAS reflects the applied snapshot: frame C (A's map) differs from frame
	// B (B's map), and is a real non-empty render.
	expect(shotC.length).toBeGreaterThan(1000);
	expect(Buffer.compare(shotC, shotB)).not.toBe(0);
});
