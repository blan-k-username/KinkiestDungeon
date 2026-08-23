/**
 * E2E (KDM-235) — a friend joins a run that is already going, and both of them play on.
 *
 * The node spec proves the seating, the placement and the barrier timing. This proves the part it
 * cannot: that a second browser can walk into a live dungeon and the two of them then take turns
 * together, with the world the host was already in — not a fresh one, and not a crash.
 *
 * ⚠️ THE CONTROL IS THE HOST'S SOLO TURN. Without it, "a turn resolved after the join" is also what a
 * session that quietly restarted looks like. So the host plays ALONE first, and the tick and the
 * world are compared across the join.
 *
 * Two invariants ride along, per TESTING_POLICY: no crash handler fires, and no unresolved text key
 * is painted — a new avatar with a new `RemotePlayer_*` def is exactly the change that trips the
 * second one.
 */
import { test, expect } from '@playwright/test';
import { MP_TEST_TIMEOUT, COOP_BOOT_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Boot one page as a co-op client and wait for it to be playing. */
async function bootOne(P: any, port: number, id: string) {
	await P.goto(`http://127.0.0.1:${port}/#coop=${id}`);
	await P.waitForFunction(
		() => { const c = (window as any).__coop; return !!c && !!c.started; },
		undefined, { timeout: COOP_BOOT_TIMEOUT },
	);
}

async function view(P: any) {
	return P.evaluate(() => {
		const c = (window as any).__coop || {};
		return {
			started: !!c.started, lastTick: c.lastTick, peers: c.peers || [],
			// @ts-ignore bare let-global
			pos: (typeof KinkyDungeonPlayerEntity !== 'undefined' && KinkyDungeonPlayerEntity)
				? { x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y } : null,
			// @ts-ignore bare let-global
			entities: (typeof KDMapData !== 'undefined' && KDMapData && KDMapData.Entities)
				? KDMapData.Entities.length : -1,
		};
	});
}

test('a friend can join a run already in progress, and the two then play together',
	async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		// requiredPlayers: 1 — the host starts playing ALONE, which is the situation this feature is
		// for (and the state KDM-253's "continue solo" leaves behind).
		const { server, bridge, port } = await start(0, { requiredPlayers: 1 });

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const A = await ctxA.newPage();
		const B = await ctxB.newPage();

		/*
		 * ⚠️ WHAT THIS ORACLE WATCHES, AND WHEN IT STARTS WATCHING.
		 *
		 * Both halves were wrong first time round. (a) `String(e)` on a page error whose payload is an
		 * `Event` — which is how a failed asset fetch surfaces — yields the useless string "Event",
		 * unmatchable by any text filter; the message is recorded properly below. (b) The baseline was
		 * taken before B booted, so B's ENTIRE boot counted as "after the join" and its own asset 404s
		 * read as crashes caused by joining.
		 *
		 * So B's handler is attached only once B is in the game. What each page is watched for is then
		 * the same thing: what happened AFTER this page was playing.
		 */
		const crashes: string[] = [];
		const record = (label: string) => (e: any) => {
			crashes.push(`${label}: ${(e && e.message) || String(e)}`);
		};
		A.on('pageerror', record('A'));
		// Pre-existing boot noise: the demo server does not serve every asset (`Logo.png` 404s in
		// every MP spec). Excluded by name and reported, never by widening the oracle.
		const ASSET_NOISE = /\[(Loader\.load|WorkerManager\.loadImageBitmap)\]|: Event$/;

		try {
			// ---- the host is playing, alone --------------------------------------------------------
			await bootOne(A, port, 'A');
			await A.waitForTimeout(1500);                       // let render frames settle

			const solo = await view(A);
			expect(solo.started).toBe(true);
			expect(bridge.session.players, 'one player, mid-run').toEqual(['A']);

			// A turn resolves with nobody else there — the control for "it really was in progress".
			await A.evaluate(() => (window as any).__coop.sendMove(1, 0));
			await A.waitForFunction(
				(t) => { const c = (window as any).__coop; return !!c && c.lastTick != null && c.lastTick > (t as number); },
				solo.lastTick ?? 0, { timeout: 120_000 },
			);
			const beforeJoin = await view(A);
			const turnAtJoin = bridge.session.turn;
			expect(turnAtJoin, 'the run is past its first turn').toBeGreaterThan(0);
			const crashesBefore = crashes.length;

			// ---- the friend arrives ------------------------------------------------------------------
			await bootOne(B, port, 'B');
			await B.waitForTimeout(1500);
			// Now that B is playing, watch it — see the note on the recorder above.
			B.on('pageerror', record('B'));

			expect(bridge.session.players, 'seated into the running session').toEqual(['A', 'B']);

			// R3/R4 — B is in the world A was already in, not a fresh dungeon. The turn counter is the
			// cheapest proof the session was not restarted underneath them.
			const joined = await view(B);
			expect(joined.started).toBe(true);
			expect(joined.lastTick, 'B adopts the live turn counter, not zero')
				.toBeGreaterThanOrEqual(turnAtJoin);
			expect(bridge.session.turn, 'and the run did not restart').toBeGreaterThanOrEqual(turnAtJoin);

			// J1 — B arrived next to A, which is what the owner asked for.
			const avA = bridge.session.avatars.get('A');
			const avB = bridge.session.avatars.get('B');
			const posA = bridge.session.world.entityPos(avA);
			const posB = bridge.session.world.entityPos(avB);
			expect(posB, 'B has an avatar in the shared world').toBeTruthy();
			expect(Math.max(Math.abs(posA.x - posB.x), Math.abs(posA.y - posB.y)),
				`B should arrive beside A (A ${posA.x},${posA.y} B ${posB.x},${posB.y})`)
				.toBeLessThanOrEqual(1);

			// ---- R5/A6: they now take turns TOGETHER --------------------------------------------------
			//
			// The real deliverable. One player acting is no longer enough — the turn waits for both,
			// and then resolves for both.
			const tickBefore = bridge.session.turn;
			await A.evaluate(() => (window as any).__coop.sendMove(1, 0));
			await A.waitForFunction(
				() => { const c = (window as any).__coop; return !!c && c.submitted === true; },
				undefined, { timeout: 120_000 },
			);
			expect(bridge.session.turn, 'A alone no longer advances the turn').toBe(tickBefore);

			await B.evaluate(() => (window as any).__coop.sendMove(-1, 0));
			await A.waitForFunction(
				(t) => { const c = (window as any).__coop; return !!c && c.lastTick != null && c.lastTick > (t as number); },
				tickBefore, { timeout: 120_000 },
			);
			await B.waitForFunction(
				(t) => { const c = (window as any).__coop; return !!c && c.lastTick != null && c.lastTick > (t as number); },
				tickBefore, { timeout: 120_000 },
			);
			expect(bridge.session.turn, 'both submits resolved exactly one turn').toBe(tickBefore + 1);

			// Each sees the other in their world.
			const seen = await B.evaluate((id) => {
				// @ts-ignore bare let-global
				return (KDMapData.Entities || []).some((e: any) => e.id === id);
			}, avA);
			expect(seen, 'the joiner can see the player who was already there').toBe(true);

			// ---- the invariants ------------------------------------------------------------------------
			const sinceJoin = crashes.slice(crashesBefore);
			const dropped = sinceJoin.filter((c) => ASSET_NOISE.test(c));
			// eslint-disable-next-line no-console
			if (dropped.length) console.log(`[KDM-235] ignored ${dropped.length} pre-existing asset error(s): ${dropped[0]}`);
			expect(sinceJoin.filter((c) => !ASSET_NOISE.test(c)),
				'joining a live run must not trip KD\'s error handler').toEqual([]);

			// A new avatar means a new `RemotePlayer_*` def and a new name key — the classic source of
			// "[NotFound] …" painted at the player.
			const names = await B.evaluate((id) => {
				// @ts-ignore bare let-globals
				const e = (KDMapData.Entities || []).find((x: any) => x.id === id);
				if (!e) return null;
				// @ts-ignore
				return { custom: e.CustomName || '', def: TextGet('Name' + (e.Enemy && e.Enemy.name)) };
			}, avA);
			expect(names, 'the peer avatar is there to be named').toBeTruthy();
			expect(names.def, 'and its name resolves to real text').not.toMatch(/NotFound/);
		} finally {
			await ctxA.close().catch(() => {});
			await ctxB.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
