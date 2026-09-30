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
import { freeNeighbour } from '../helpers/session-tiles';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const pos = (P: any) => P.evaluate(() => ({
	// @ts-ignore bare let-globals
	x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y,
}));
/**
 * Screen point of a tile at PATH distance `n` (BFS over walkable, empty tiles), skipping `avoid`.
 *
 * Only a tile whose screen point lies in the open play area counts, read from a camera that has stopped.
 * Two ways a click used to land on UI instead of the tile: right after boot `KinkyDungeonCamX/Y` can
 * still be settling (the tile left of the player mapped to the top-right corner), and near a map EDGE
 * a neighbour of the player may sit under the HUD — the party now starts on KD's own
 * start tile, which is often beside an edge (KDM-309). Polled, so a settling camera is simply waited out.
 */
async function pathTarget(P: any, n: number, avoid: any = null) {
	let t: any; let prev = '';
	await expect.poll(async () => {
		t = await pathTargetNow(P, n, avoid);
		const now = t ? [t.tx, t.ty, Math.round(t.x), Math.round(t.y)].join(',') : '';
		const stable = now !== '' && now === prev;   // the camera has stopped moving
		prev = now;
		return stable && t.onScreen;
	}, { timeout: 15_000, intervals: [250], message: `a tile ${n} steps away, clear of the HUD` }).toBe(true);
	return t;
}
const pathTargetNow = (P: any, n: number, avoid: any) => P.evaluate((a: any) => {
	// @ts-ignore
	const p = KinkyDungeonPlayerEntity;
	// A tile's centre in KD's 2000x1000 canvas space, and whether it is clear of the HUD.
	// @ts-ignore
	const gx = (x: number) => (x - KinkyDungeonCamX) * KinkyDungeonGridSizeDisplay + canvasOffsetX + KinkyDungeonGridSizeDisplay / 2;
	// @ts-ignore
	const gy = (y: number) => (y - KinkyDungeonCamY) * KinkyDungeonGridSizeDisplay + canvasOffsetY + KinkyDungeonGridSizeDisplay / 2;
	const clear = (x: number, y: number) => gx(x) > 450 && gx(x) < 1550 && gy(y) > 150 && gy(y) < 850;
	const key = (x: number, y: number) => x + ',' + y;
	const seen: any = {}; seen[key(p.x, p.y)] = 0;
	let frontier = [[p.x, p.y]]; const ring: number[][] = [];
	for (let d = 1; d <= a.n; d++) {
		const next: any[] = [];
		for (const [x, y] of frontier) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
			const tx = x + dx, ty = y + dy; if (seen[key(tx, ty)] !== undefined) continue;
			// @ts-ignore
			if (KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(tx, ty)) < 0) continue;
			// @ts-ignore
			if (KDMapData.Entities.some((e: any) => e.x === tx && e.y === ty)) continue;
			seen[key(tx, ty)] = d; next.push([tx, ty]);
			if (d === a.n && !(a.avoid && a.avoid.tx === tx && a.avoid.ty === ty)) ring.push([tx, ty]);
		}
		frontier = next;
	}
	if (!ring.length) return null;
	const pick = ring.find(([x, y]) => clear(x, y)) || ring[0];
	const [tx, ty] = pick;
	// @ts-ignore
	const view = (typeof PIXIapp !== 'undefined' && PIXIapp.view) || document.querySelector('canvas');
	const r = view.getBoundingClientRect();
	return { tx, ty, onScreen: clear(tx, ty),
		x: r.left + gx(tx) * r.width / 2000, y: r.top + gy(ty) * r.height / 1000 };
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

async function withPair(body: (A: any, B: any, bridge: any) => Promise<void>, browser: any, overrides: any = null) {
	const { server, bridge, port } = await start(0, overrides);
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
		await withPair(async (A, B) => {
			// No demo enemy by default (KDM-309): the partner is the only other entity near the start.
			// Asserted, so a generated enemy wandering into view fails loudly instead of making #1 #2.
			expect(await A.evaluate(() => (window as any).__coop._inDanger()), 'control: nothing but the partner in view').toBe(false);
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
		await withPair(async (A, B, bridge) => {
			// The demo enemy, asked for (KDM-309 made it opt-in): KD's own danger rule must still apply to it.
			// Right beside A, so it stays in view as A steps away: summoned a few tiles off the start tile,
			// A walked 3 tiles in one run — presumably it had dropped out of view.
			const s = bridge.session;
			const beside = freeNeighbour(s, 'A');
			expect(beside, 'precondition: a free tile beside A').not.toBeNull();
			s.world.moveAvatar(s.enemyId, beside!.x, beside!.y);
			// A world write reaches A's screen with the next turn: both wait one.
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await partnerWaits(A, B);
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
		}, browser, { enemyType: 'Rat' });
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
