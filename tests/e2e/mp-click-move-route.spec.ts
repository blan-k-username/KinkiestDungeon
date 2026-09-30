/**
 * E2E (KDM-310) — co-op click-to-move: a clicked PATH is walked, and a second click REPLACES the first.
 *
 * Owner's UAT (2026-09-30): "the MP char doesn't remember the planned path, I have to click again and
 * again" and "if I choose another action while waiting for the other player, it should replace my
 * first decision". Both reproduced with real canvas clicks before this spec was written:
 *
 *  - the route driver keeps only the first step of a click while `KinkyDungeonInDanger()` — KD's own
 *    single-player rule — and in co-op that was ALWAYS true, because the PARTNER's avatar counts as a
 *    visible enemy. #1 is that case with nothing else in view; #2 is the control that the rule itself
 *    survives for a REAL enemy, so #1 cannot pass by simply deleting the danger check.
 *  - a new click while an earlier action was waiting stored its route but never sent its first step,
 *    so the FIRST choice was applied. The server is already last-wins (swap-session `submit`); #3.
 *
 *  - and a route also died a few tiles in because the client matches replies to its sends in order,
 *    and the bridge dropped a coalesced hover input WITHOUT a reply — every later reply was credited to
 *    an earlier send. Pinned at the wire by `tests/unit/mp-action-latency-repro.spec.ts`; #1 here.
 *
 * Written first, per the project's Rule 1 (#1 and #3 were red before the fix).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const pos = (P: any) => P.evaluate(() => ({
	// @ts-ignore bare let-globals
	x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y,
}));
/**
 * Screen point of a tile at PATH distance `n` (BFS over walkable, empty tiles), skipping `avoid`.
 *
 * Waits until KD's camera is centred on the player first: right after boot `KinkyDungeonCamX/Y` can
 * still be settling, and a point computed from them then lands on the UI instead of the tile (seen:
 * the tile left of the player mapped to the top-right corner, and #3's first click did nothing).
 */
async function pathTarget(P: any, n: number, avoid: any = null) {
	let t: any;
	await expect.poll(async () => { t = await pathTargetNow(P, n, avoid); return !t || t.centred; },
		{ timeout: 15_000, message: "KD's camera centres on the player" }).toBe(true);
	return t;
}
const pathTargetNow = (P: any, n: number, avoid: any) => P.evaluate((a: any) => {
	// @ts-ignore
	const p = KinkyDungeonPlayerEntity;
	const key = (x: number, y: number) => x + ',' + y;
	const seen: any = {}; seen[key(p.x, p.y)] = 0;
	let frontier = [[p.x, p.y]]; let found: any = null;
	for (let d = 1; d <= a.n && !found; d++) {
		const next: any[] = [];
		for (const [x, y] of frontier) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
			const tx = x + dx, ty = y + dy; if (seen[key(tx, ty)] !== undefined) continue;
			// @ts-ignore
			if (KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(tx, ty)) < 0) continue;
			// @ts-ignore
			if (KDMapData.Entities.some((e: any) => e.x === tx && e.y === ty)) continue;
			seen[key(tx, ty)] = d; next.push([tx, ty]);
			if (d === a.n && !found && !(a.avoid && a.avoid.tx === tx && a.avoid.ty === ty)) found = [tx, ty];
		}
		frontier = next;
	}
	if (!found) return null;
	const [tx, ty] = found;
	// A tile's centre in KD's 2000x1000 canvas space.
	// @ts-ignore
	const gx = (x: number) => (x - KinkyDungeonCamX) * KinkyDungeonGridSizeDisplay + canvasOffsetX + KinkyDungeonGridSizeDisplay / 2;
	// @ts-ignore
	const gy = (y: number) => (y - KinkyDungeonCamY) * KinkyDungeonGridSizeDisplay + canvasOffsetY + KinkyDungeonGridSizeDisplay / 2;
	const kx = gx(tx), ky = gy(ty);
	// The player sits in the middle half of the view once the camera has followed them.
	const centred = Math.abs(gx(p.x) - 1000) < 500 && Math.abs(gy(p.y) - 500) < 250;
	// @ts-ignore
	const view = (typeof PIXIapp !== 'undefined' && PIXIapp.view) || document.querySelector('canvas');
	const r = view.getBoundingClientRect();
	return { tx, ty, centred, x: r.left + kx * r.width / 2000, y: r.top + ky * r.height / 1000 };
}, { n, avoid });

/** A REAL click: mouse down/up over the tile, through KD's own input path. */
async function click(P: any, t: any) {
	await P.mouse.move(t.x, t.y); await P.waitForTimeout(300);
	await P.mouse.down(); await P.waitForTimeout(80); await P.mouse.up();
	await P.waitForTimeout(500);
}

/** The partner spends a turn waiting; returns once A has seen the turn resolve (or a timeout). */
async function partnerWaits(A: any, B: any) {
	const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
	await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
	await A.waitForFunction((t) => (window as any).__coop.lastTick > (t as number), t0, { timeout: 30_000 }).catch(() => {});
	await A.waitForTimeout(1000);
}

/** Take the session's demo enemy out of the world, so the partner is the only other entity. */
async function removeDemoEnemy(bridge: any, A: any, B: any) {
	const id = bridge.session.enemyId;
	bridge.session.world.eval(`KDMapData.Entities = KDMapData.Entities.filter(function(e){ return e.id !== ${id | 0}; }); KDUpdateEnemyCache = true;`);
	await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
	await partnerWaits(A, B);
	await expect.poll(() => A.evaluate((i: number) => !KDMapData.Entities.some((e: any) => e.id === i), id),
		{ timeout: 30_000, message: 'the demo enemy is gone on A' }).toBe(true);
}

async function withPair(body: (A: any, B: any, bridge: any) => Promise<void>, browser: any) {
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } });
	const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
	const A = await ctxA.newPage(); const B = await ctxB.newPage();
	try {
		await bootCoopPair(A, B, port);
		await body(A, B, bridge);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
}

test.describe('KDM-310 — co-op click-to-move', () => {
	test('#1 with only the partner in view, a clicked path is walked to its end', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		await withPair(async (A, B, bridge) => {
			await removeDemoEnemy(bridge, A, B);
			const t = await pathTarget(A, 4);
			expect(t, 'control: a tile 4 steps away exists').not.toBeNull();
			await click(A, t);
			for (let i = 0; i < 6; i++) {
				const p = await pos(A);
				if (p.x === t!.tx && p.y === t!.ty) break;
				await partnerWaits(A, B);
			}
			expect(await pos(A), 'the whole path, from ONE click').toEqual({ x: t!.tx, y: t!.ty });
		}, browser);
	});

	test('#2 CONTROL — a real enemy in view still stops the walk after the first step, as in single player', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		await withPair(async (A, B) => {
			// The demo enemy stays: KD's own danger rule must still apply to it.
			// Polled: right after boot the enemy may not have reached A's view yet. And the ROUTE's own
			// test, which ignores the partner — KD's raw one would be true from the partner alone.
			await expect.poll(() => A.evaluate(() => (window as any).__coop._inDanger()),
				{ timeout: 30_000, message: 'control: a real enemy is in view' }).toBe(true);
			const start0 = await pos(A);
			const t = await pathTarget(A, 4);
			await click(A, t);
			for (let i = 0; i < 3; i++) await partnerWaits(A, B);
			const end = await pos(A);
			const moved = Math.max(Math.abs(end.x - start0.x), Math.abs(end.y - start0.y));
			expect(moved, 'exactly one step: the clicked one').toBe(1);
		}, browser);
	});

	test('#3 a second click while waiting for the partner replaces the first', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		await withPair(async (A, B) => {
			const first = await pathTarget(A, 1);
			const second = await pathTarget(A, 1, first);
			expect(second, 'control: two different neighbours').not.toBeNull();
			await click(A, first);
			await expect.poll(() => A.evaluate(() => (window as any).__coop.submitted),
				{ timeout: 15_000, message: 'the first click is waiting for the partner' }).toBe(true);
			await click(A, second);
			await partnerWaits(A, B);
			expect(await pos(A), 'the SECOND choice wins').toEqual({ x: second!.tx, y: second!.ty });
		}, browser);
	});
});
