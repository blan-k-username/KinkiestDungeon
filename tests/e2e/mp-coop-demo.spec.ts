/**
 * E2E (Playwright/Chromium): the hands-on co-op demo launcher — KD-071.
 *
 * Starts the real demo server (static game + WS bridge on one port) and drives TWO
 * independent browser windows against it, exactly as a human would:
 *   window A → /#coop=A , window B → /#coop=B → the shared dungeon starts.
 * Asserts both render the SAME server-owned world and that a lockstep move (both
 * submit) advances the shared turn — proving the two-browser UAT path works.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('two browser windows play one shared co-op dungeon via the demo server', async ({ browser }) => {
	// Heavyweight: TWO full game bundles (each preloads ~600 char assets) + the
	// server's 3 headless instances. Generous timeouts to absorb the cold start.
	test.setTimeout(300_000);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errs: string[] = [];
	A.on('pageerror', (e) => errs.push(e.message));
	B.on('pageerror', (e) => errs.push(e.message));

	try {
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });

		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		// both joined → server starts the shared world → both receive their first state
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForTimeout(1500); // let render frames settle

		// the game actually reaches the dungeon SCREEN (not stuck on the asset
		// preloader, and not crashed) in both windows.
		for (const P of [A, B]) {
			const screen = await P.evaluate(() => ({
				// @ts-ignore bare let-globals
				state: KinkyDungeonState, drawState: KinkyDungeonDrawState,
			}));
			expect(screen.state).toBe('Game');
			expect(screen.drawState).toBe('Game');
		}
		// the draw path must not crash on the injected entities (regression guard:
		// peer-avatar def must re-link, else KDEnemyRank reads `.tags` of undefined).
		expect(errs.find((e) => /reading 'tags'/.test(e))).toBeUndefined();

		// vision is recomputed client-side after adopting state → the player's own
		// tile is lit (regression guard: without it the whole map stays black).
		for (const P of [A, B]) {
			const vis = await P.evaluate(() => {
				// @ts-ignore bare let-globals
				const p = KinkyDungeonPlayerEntity;
				// @ts-ignore
				return (typeof KinkyDungeonVisionGet === 'function') ? KinkyDungeonVisionGet(p.x, p.y) : -1;
			});
			expect(vis).toBeGreaterThan(0);
		}

		// both windows render the SAME shared, server-owned dungeon, render-only
		const ga = await A.evaluate(() => (KDMapData as any).Grid);
		const gb = await B.evaluate(() => (KDMapData as any).Grid);
		expect(typeof ga).toBe('string');
		expect(ga.length).toBeGreaterThan(0);
		expect(ga).toBe(gb);
		// @ts-ignore — KDServerRole is a bundle `let` global, not on window
		expect(await A.evaluate(() => (typeof KDServerRole !== 'undefined' ? KDServerRole : null))).toBe('client');

		const peerOfA = () => B.evaluate(() => {
			// @ts-ignore
			const a = (KDMapData.Entities || []).find((e: any) => e.Enemy && e.Enemy.name === 'RemotePlayer');
			return a ? { x: a.x, y: a.y } : null;
		});

		// --- true lockstep move (R8): turn advances only when BOTH act; B sees A move ---
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		const peerBefore = await peerOfA();
		await A.evaluate(() => (window as any).__coop.sendMove(1, 0)); // A moves...
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' })); // ...B waits → turn advances
		await A.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, t0, { timeout: 30_000 });
		await B.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, t0, { timeout: 30_000 });
		const aPos = await A.evaluate(() => ({ /* @ts-ignore */ x: KinkyDungeonPlayerEntity.x, /* @ts-ignore */ y: KinkyDungeonPlayerEntity.y }));
		const peerAfter = await peerOfA();
		expect(peerAfter).toEqual({ x: aPos.x, y: aPos.y });            // B's view of A in sync
		expect(peerAfter!.x !== peerBefore!.x || peerAfter!.y !== peerBefore!.y).toBe(true);

		// --- routed attack (KD-085): A attacks the shared enemy → both see it damaged ---
		const recon = bridge.session.reconciler;
		const world = bridge.session.orch.world;
		// put the world enemy adjacent to A's avatar so the attack is in range
		const avId = recon.worldAvatar.get('A');
		const av = world.listEntities().find((e: any) => e.id === avId);
		world.moveAvatar(recon.worldEnemyId, av.x, av.y + 1);
		const enemyHp0 = recon.enemyView(bridge.session.orch)?.hp;
		const tAtk = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate((tgt) => (window as any).__coop.sendAction({ kind: 'attack', tx: tgt.x, ty: tgt.y }), { x: av.x, y: av.y + 1 });
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, tAtk, { timeout: 30_000 });
		// the world's authoritative enemy took damage (HP dropped or it was killed)
		const enemyAfter = recon.enemyView(bridge.session.orch);
		expect(enemyAfter == null || enemyAfter.hp < enemyHp0).toBe(true);

		// real rendered frames in both windows
		const shotA = await A.locator('#MainCanvas').screenshot();
		const shotB = await B.locator('#MainCanvas').screenshot();
		expect(shotA.length).toBeGreaterThan(1000);
		expect(shotB.length).toBeGreaterThan(1000);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
	}
});
