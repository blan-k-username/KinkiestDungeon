/**
 * E2E (KDM-240) — the party changes floor together, and can still SEE each other afterwards.
 *
 * This is the user-visible half of the task, and the reason it is worth a boot-heavy spec rather
 * than a third unit test (epic cadence rule 5): the failure a player actually reports is *"we went
 * down the stairs and my partner disappeared"*. That symptom lives in the browser — it is the
 * absence of a `RemotePlayer*` entity in the client's own `KDMapData.Entities` — and no server-side
 * assertion reproduces it.
 *
 * Mechanically it pins F1 (avatars are spawned once and never re-spawned, `swap-session.js:1383`)
 * and F2 (only the acting player is re-placed) end to end, through the real WS bridge, the real
 * snapshot pipeline and the real client.
 *
 * The descent itself is driven SERVER-SIDE, through `bridge.session`. Walking two browser clients
 * to a randomly-placed stair tile and completing KD's two-action confirm handshake
 * (`KinkyDungeonTiles.ts:113-123`) would make this a test of pathfinding; the behaviour under test
 * begins the moment the map changes. `bridge.session` is the same handle `mp-coop-demo.spec.ts`
 * already reaches for.
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, coopMoveAnyDirection, MP_TEST_TIMEOUT, reportedPageErrors, waitForPeerAvatar,
} from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('after a floor change both players are on the new floor and can still see each other', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errs: string[] = [];
	A.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
	B.on('pageerror', (e) => errs.push(String((e && e.message) || e)));

	try {
		await bootCoopPair(A, B, port);

		// Precondition, and the control for the assertion at the end: each client can see the other
		// BEFORE anything changes floor. Without this a green "avatar present" later could simply
		// mean the test never noticed the avatar was optional.
		await waitForPeerAvatar(A, { label: 'A, before the floor change' });
		await waitForPeerAvatar(B, { label: 'B, before the floor change' });

		/*
		 * WHICH MAP the client thinks the party is on.
		 *
		 * Deliberately NOT the level number. Measured: the party's first move is hub -> dungeon floor,
		 * which changes `KDGameData.RoomType` and leaves `MiniGameKinkyDungeonLevel` at 0. A level-only
		 * oracle would call that "no floor change" and red on a working feature — the browser-side twin
		 * of the F4 defect this whole task is about.
		 */
		const clientMapId = (P: typeof A) => P.evaluate(() => [
			// @ts-ignore bare let-globals — these are bundle `let`s, not on globalThis
			MiniGameKinkyDungeonLevel, (KDGameData as any).RoomType || '',
			// @ts-ignore
			(KDMapData as any).mapX, (KDMapData as any).mapY,
		].join('|'));

		const mapBefore = await clientMapId(A);

		// Take the stairs, server-side, with the party gate stood down — this spec is about landing,
		// not about the co-location rule (that is `mp-party-stair-gate.spec.ts`).
		//
		// Arming the journey target is required, not incidental: from the hub the stock JourneyChoice
		// filter claims the first transition and opens the journey map instead of moving anybody
		// (KinkyDungeonTiles.ts:12-21). Without it `KinkyDungeonHandleStairs` returns cleanly and the
		// party never moves, which would make every assertion below vacuous.
		const session = bridge.session;
		session.world.restorePlayer(session.bundles.get('A'));
		session.world.setPartyGate({ peers: [], down: [], radius: 1 });
		const took = session.world.eval(`(function(){
			var slot = KDGameData.JourneyMap[KDGameData.JourneyX + ',' + KDGameData.JourneyY];
			var c = slot && slot.Connections && slot.Connections[0];
			if (!c) return 'no journey connection to descend to';
			KDGameData.JourneyTarget = { x: c.x, y: c.y };
			KDGameData.UseJourneyTarget = true;
			try { KinkyDungeonHandleStairs('s', true); return 'ok'; }
			catch (e) { return 'threw: ' + e.message; }
		})()`);
		session.bundles.set('A', session.world.capturePlayer());
		expect(took, 'the server could not take the stairs at all — the rest of this spec is vacuous')
			.toBe('ok');

		// One real lockstep turn, driven from the browsers, so the change reaches both clients the
		// way it does in play: through the turn, the snapshot and the render client.
		await coopMoveAnyDirection(A, B);

		const mapAfter = await clientMapId(A);
		expect(mapAfter, 'the client never learned the party moved to another map').not.toBe(mapBefore);
		expect(await clientMapId(B),
			'the two clients disagree about which map the party is on').toBe(mapAfter);

		// THE assertion. `waitForPeerAvatar` throws with a diagnosis, so a red here reads as
		// "the peer never arrived", not as a null dereference.
		const peerSeenByA = await waitForPeerAvatar(A, { label: 'A, AFTER the floor change' });
		const peerSeenByB = await waitForPeerAvatar(B, { label: 'B, AFTER the floor change' });

		// …and they landed together, not at opposite ends of the new floor (R4).
		const posA = await A.evaluate(() => ({
			// @ts-ignore bare let-global
			x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y,
		}));
		const apart = Math.max(Math.abs(posA.x - peerSeenByA.x), Math.abs(posA.y - peerSeenByA.y));
		expect(apart,
			`A landed ${apart} tiles from their partner. "Both land in the same next place" is the ` +
			'requirement; a stale bundle coordinate that happens to be walkable on the new map looks ' +
			'exactly like this.').toBeLessThanOrEqual(3);
		expect(peerSeenByB.id, "B's view of the peer is a live entity too").toBeTruthy();

		const { real, ignored } = reportedPageErrors(errs);
		expect(real,
			`client-side exceptions during the floor change: ${real.join(' | ')}\n` +
			`(known pre-existing noise ignored: ${ignored.length} — ${ignored.join(' | ')})`).toEqual([]);
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		bridge.close();
		await new Promise((r) => server.close(r));
	}
});
