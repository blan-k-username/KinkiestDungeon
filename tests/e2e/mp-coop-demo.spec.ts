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
		// render-only: the client marks itself render-only via KDRenderClient (KD-085 —
		// the KDServerRole game-source flag was reverted; the client is pure monkey-patch).
		expect(await A.evaluate(() => (window as any).KDRenderClient.isLocalSimDisabled())).toBe(true);

		const peerOfA = () => B.evaluate(() => {
			// @ts-ignore
			const a = (KDMapData.Entities || []).find((e: any) => e.Enemy && e.Enemy.name === 'RemotePlayer');
			return a ? { x: a.x, y: a.y } : null;
		});

		// --- true lockstep move (R8): turn advances only when BOTH act; B sees A move ---
		// Try a few directions: A starts adjacent to B's avatar (an ally blocks that
		// tile), so not every direction is open. Each turn proves lockstep (advances only
		// when BOTH submit) and that B's view of A stays in sync; net A must move.
		let moved = false;
		let prevPeer = await peerOfA();
		for (const [dx, dy] of [[-1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1]]) {
			const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate((d) => (window as any).__coop.sendMove(d.dx, d.dy), { dx, dy }); // A moves...
			await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' })); // ...B waits → turn advances
			await A.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, t0, { timeout: 30_000 });
			await B.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, t0, { timeout: 30_000 });
			const aPos = await A.evaluate(() => ({ /* @ts-ignore */ x: KinkyDungeonPlayerEntity.x, /* @ts-ignore */ y: KinkyDungeonPlayerEntity.y }));
			const peerAfter = await peerOfA();
			expect(peerAfter).toEqual({ x: aPos.x, y: aPos.y });        // B's view of A in sync
			if (peerAfter!.x !== prevPeer!.x || peerAfter!.y !== prevPeer!.y) { moved = true; break; }
			prevPeer = peerAfter;
		}
		expect(moved).toBe(true);

		// --- routed bump-attack (KD-085 swap model): A moves into the shared enemy →
		// the world's REAL dispatcher resolves it → both see the world enemy damaged ---
		const session = bridge.session;          // SwapSession (one authoritative world)
		// put the world enemy directly below A's avatar so a (0,1) move bumps = attacks it
		const aAv = session.posOf('A');
		session.world.moveAvatar(session.enemyId, aAv.x, aAv.y + 1);
		const enemyHp0 = session.enemyView()?.hp;
		expect(enemyHp0).toBeGreaterThan(0);
		const tAtk = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendMove(0, 1));   // A bumps the enemy
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, tAtk, { timeout: 30_000 });
		// the world's authoritative enemy took damage (HP dropped or it was killed)
		const enemyAfter = session.enemyView();
		expect(enemyAfter == null || enemyAfter.hp < enemyHp0).toBe(true);

		// --- click-to-move route (KD FastMove) advances ONE tile per lockstep turn and
		// is NOT "forgotten" after a single tile (regression: routes used to drain
		// client-side in a few frames). Park the shared enemy far away so the route is
		// not interrupted (KinkyDungeonInDanger) — matches the no-enemy report. ---
		{
			const aNow = session.posOf('A');
			session.world.moveAvatar(session.enemyId, aNow.x + 30, aNow.y + 30);
		}
		// This block tests route CADENCE (one step/turn, path preserved), not the
		// enemy-interrupt itself — stub KinkyDungeonInDanger to false so the generated
		// dungeon's other hostiles don't legitimately terminate the route mid-assert.
		await A.evaluate(() => { /* @ts-ignore bare let-global */ KinkyDungeonInDanger = function () { return false; }; });
		// Probe KD's REAL pathfinder (wrapped to capture the path) for a reachable
		// multi-step route from A; suppress sends while probing.
		const setup = await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore bare let-global
			const p = KinkyDungeonPlayerEntity;
			w.__coop.submitted = true;
			const cands = [[3, 0], [0, 3], [-3, 0], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2], [4, 0], [0, 4], [5, 0], [0, 5]];
			for (const [dx, dy] of cands) {
				w.__coop.route = null;
				// @ts-ignore bare let-global — KD's real fast-move pathfinder
				KDFastMoveTo(p.x + dx, p.y + dy);
				// @ts-ignore
				if (w.__coop.route && w.__coop.route.length >= 2) return { len: w.__coop.route.length, fastPath: (KinkyDungeonFastMovePath || []).length };
			}
			return null;
		});
		expect(setup, 'no reachable >=2-step route from A').not.toBeNull();
		// KD's own per-frame drainer is disabled (path captured, not drained locally)
		expect(setup!.fastPath).toBe(0);
		expect(setup!.len).toBeGreaterThanOrEqual(2);

		const startPos = await A.evaluate(() => ({ /* @ts-ignore */ x: KinkyDungeonPlayerEntity.x, /* @ts-ignore */ y: KinkyDungeonPlayerEntity.y }));
		// kick off step 1 — exactly ONE step is consumed (not the whole path)
		const afterKick = await A.evaluate(() => {
			const w = window as any;
			w.__coop.submitted = false;
			w.__coop._stepRoute();
			return w.__coop.route ? w.__coop.route.length : 0;
		});
		expect(afterKick).toBe(setup!.len - 1);

		// one lockstep turn (B waits) → A walks one tile via the route
		const tr0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tr0, { timeout: 30_000 });
		const afterT1 = await A.evaluate(() => ({ /* @ts-ignore */ x: KinkyDungeonPlayerEntity.x, /* @ts-ignore */ y: KinkyDungeonPlayerEntity.y }));
		expect(afterT1.x !== startPos.x || afterT1.y !== startPos.y).toBe(true);

		// a second turn CONTINUES the route (the bug stopped after one tile). Guarded so
		// an interrupt can't hang the barrier.
		const stillRouting = await A.evaluate(() => (window as any).__coop.submitted && (window as any).__coop.route != null);
		if (stillRouting) {
			const tr1 = await A.evaluate(() => (window as any).__coop.lastTick);
			await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tr1, { timeout: 30_000 });
			const afterT2 = await A.evaluate(() => ({ /* @ts-ignore */ x: KinkyDungeonPlayerEntity.x, /* @ts-ignore */ y: KinkyDungeonPlayerEntity.y }));
			expect(afterT2.x !== afterT1.x || afterT2.y !== afterT1.y).toBe(true);
		}

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
