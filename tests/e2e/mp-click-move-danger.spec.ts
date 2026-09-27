/**
 * E2E — a MOUSE click moves the player even while an enemy is in view (owner UAT 2026-09-27).
 *
 * Symptom: both players joined, the keyboard moved them, the mouse did nothing. Measured with a real
 * mouse click (probe, 2026-09-27): the click reached `KinkyDungeonClickGame` → `KDFastMoveTo`, which
 * found a path; the co-op route driver (`coop-bootstrap.js` `stepRoute`) then DROPPED the route because
 * `KinkyDungeonInDanger()` was true — the session's shared Rat was in sight. KD's own fast-move keeps
 * the FIRST step of a freshly clicked path when in danger (`KinkyDungeonEnemies.ts`, the `startPath`
 * rule), so a click always moves at least one tile; the co-op driver threw that step away too.
 *
 * ⚠️ WHY THE OLD CLICK-TO-MOVE COVERAGE MISSED IT: `mp-coop-demo.spec.ts` parks the enemy far away AND
 * stubs `KinkyDungeonInDanger` to `false` before driving a route — the one condition that broke it.
 * Here danger is stubbed the OTHER way (`true`), so the spec exercises exactly the state the owner
 * was in, deterministically, whatever the generated map puts in view.
 *
 * The click is a real `page.mouse` click on the canvas, not a `KDFastMoveTo` call: the owner's
 * complaint was about the mouse, and every layer between the pointer and the route is in scope.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, captureCoopWire, readCoopWire, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const pos = (P: any) => P.evaluate(() => ({
	// @ts-ignore bare let-globals
	x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y,
}));

/** CSS pixel of a free walkable tile next to the player, via KD's own tile→screen mapping. */
async function freeNeighbourOnScreen(P: any) {
	return P.evaluate(() => {
		// @ts-ignore bare let-globals throughout
		const p = KinkyDungeonPlayerEntity;
		const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
		for (const [dx, dy] of dirs) {
			const tx = p.x + dx, ty = p.y + dy;
			// @ts-ignore
			const walkable = KinkyDungeonMovableTilesEnemy.indexOf(KinkyDungeonMapGet(tx, ty)) >= 0;
			// @ts-ignore
			const empty = !KDMapData.Entities.some((e: any) => e.x === tx && e.y === ty);
			if (!walkable || !empty) continue;
			// @ts-ignore
			const kx = (tx - KinkyDungeonCamX) * KinkyDungeonGridSizeDisplay + canvasOffsetX + KinkyDungeonGridSizeDisplay / 2;
			// @ts-ignore
			const ky = (ty - KinkyDungeonCamY) * KinkyDungeonGridSizeDisplay + canvasOffsetY + KinkyDungeonGridSizeDisplay / 2;
			// @ts-ignore — the canvas KD really draws to (memory: #MainCanvas is a decoy)
			const view = (typeof PIXIapp !== 'undefined' && PIXIapp.view) || document.querySelector('canvas');
			const r = view.getBoundingClientRect();
			return { tx, ty, x: r.left + kx * r.width / 2000, y: r.top + ky * r.height / 1000 };
		}
		return null;
	});
}

test('a mouse click moves the player one tile while an enemy is in view', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } });
	const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	try {
		await bootCoopPair(A, B, port);
		// The owner's condition: KD believes the player is in danger (an enemy in sight).
		await A.evaluate(() => { /* @ts-ignore bare let-global */ KinkyDungeonInDanger = function () { return true; }; });
		await captureCoopWire(A);

		const before = await pos(A);
		const target = await freeNeighbourOnScreen(A);
		expect(target, 'control: there is a free tile next to the player to click on').not.toBeNull();

		await A.mouse.move(target!.x, target!.y);
		await A.waitForTimeout(300);
		await A.mouse.down(); await A.waitForTimeout(80); await A.mouse.up();

		// The deciding layer is the client: did the click become a routed move on the wire?
		await expect.poll(async () => (await readCoopWire(A, 'move')).length,
			{ timeout: 10_000, message: 'the click must send a move' }).toBeGreaterThan(0);

		// …and the turn resolves into real movement once the partner acts (lockstep).
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((t) => (window as any).__coop.lastTick > (t as number), t0, { timeout: 60_000 });
		await expect.poll(() => pos(A), { timeout: 30_000, message: 'the player stands on the clicked tile' })
			.toEqual({ x: target!.tx, y: target!.ty });
		expect(before, 'control: the player really moved').not.toEqual({ x: target!.tx, y: target!.ty });
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
