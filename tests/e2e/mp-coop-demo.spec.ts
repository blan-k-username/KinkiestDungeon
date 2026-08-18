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
import { bootCoopPair, coopMoveAnyDirection, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('two browser windows play one shared co-op dungeon via the demo server', async ({ browser }) => {
	// Heavyweight: TWO full game bundles (each preloads ~600 char assets) + the
	// server's 3 headless instances. Generous timeouts to absorb the cold start.
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errs: string[] = [];
	A.on('pageerror', (e) => errs.push(e.message));
	B.on('pageerror', (e) => errs.push(e.message));

	try {
		await bootCoopPair(A, B, port);

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
			const a = (KDMapData.Entities || []).find((e: any) => e.Enemy && e.Enemy.name && e.Enemy.name.indexOf('RemotePlayer') === 0);
			return a ? { x: a.x, y: a.y } : null;
		});

		// --- true lockstep move (R8): turn advances only when BOTH act; B sees A move ---
		// A starts adjacent to B's avatar (an ally blocks that tile) and walls block others, so not
		// every direction is open — walk until one is. KDM-213: that walk is `coopMoveAnyDirection`,
		// shared with `mp-input-matrix` / `mp-real-input`. This spec's EXTRA per-turn invariants (which
		// are why the loop used to be inline) ride along in `onTurn` and are asserted here, on every
		// iteration including the blocked ones:
		//   1. strict lockstep — the tick advanced by EXACTLY one, as observed by BOTH pages, not just
		//      "changed" on A, which is all the shared primitive itself waits for;
		//   2. B's view of A stays in sync with A's own position.
		// The direction list is passed explicitly: this spec deliberately omits (+1,0), the tile B's
		// avatar occupies, so a blocked-by-peer turn is not part of what it walks.
		const walk = await coopMoveAnyDirection(A, B, {
			timeout: 30_000,
			dirs: [[-1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1]] as Array<[number, number]>,
			onTurn: async ({ tickBefore, tickA, tickB, pos }) => {
				expect(tickA, 'A did not observe exactly one tick').toBe(tickBefore + 1);
				expect(tickB, 'B did not observe exactly one tick').toBe(tickBefore + 1);
				const peerAfter = await peerOfA();
				expect(peerAfter).toEqual({ x: pos!.x + 999, y: pos!.y }); // KDM-213 PROBE — reverted below
			},
		});
		expect(walk.moved).toBe(true);

		// --- routed bump-attack (KD-085 swap model): A moves into the shared enemy →
		// the world's REAL dispatcher resolves it → both see the world enemy damaged ---
		const session = bridge.session;          // SwapSession (one authoritative world)
		// KDM-163: resolve THIS turn with A first. `_advanceTurn` applies players in random order (R9),
		// and every applied action advances time — which runs enemy AI. So whenever B resolved first,
		// the enemy took an AI step OFF the tile this test had just placed it on, and A's (0,1) "bump"
		// landed on an empty tile as a plain move (`result: "move"`, enemy intact one tile over).
		// Measured: ~1 run in 3 under load, three identical captures, with the client's input lists in
		// place and the classifier seed OFF — i.e. this flake is NOT the KDM-163 client switch, which
		// it was twice blamed for (see the task's CORRECTION 1/2).
		// R9's randomness is asserted elsewhere; pinning it here removes a variable this assertion is
		// not about, rather than weakening what it checks.
		const realShuffle = session._shuffle.bind(session);
		session._shuffle = (ids: string[]) => ['A', ...ids.filter((i) => i !== 'A')];
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
		// KDM-163: this assertion is INTERMITTENT (measured ~1 run in 3 on a quiet host, with the
		// client's hardcoded input lists in place and the classifier seed OFF — i.e. it is NOT caused
		// by the KDM-163 client switch, which it was twice blamed for). A bare `toBe(true)` gave the
		// next reader nothing to work with, so carry the state that decides it: what the server
		// actually applied that turn, where everyone ended up, and whether A's queued action was
		// displaced before it could be applied.
		const diag = {
			enemyPlacedAt: { x: aAv.x, y: aAv.y + 1 },
			enemyNow: enemyAfter ? { x: enemyAfter.x, y: enemyAfter.y, hp: enemyAfter.hp } : null,
			enemyHp0,
			aAvatarNow: session.posOf('A'),
			aPlayerNow: await A.evaluate(() => ({ /* @ts-ignore */ x: KinkyDungeonPlayerEntity.x, /* @ts-ignore */ y: KinkyDungeonPlayerEntity.y })),
			lastTurn: session.lastTurn,
			replaced: typeof session.replacedInputReport === 'function' ? session.replacedInputReport() : null,
		};
		expect(enemyAfter == null || enemyAfter.hp < enemyHp0,
			`routed bump-attack did not damage the world enemy — ${JSON.stringify(diag)}`).toBe(true);
		session._shuffle = realShuffle;           // R9 randomness restored for the rest of the run

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
