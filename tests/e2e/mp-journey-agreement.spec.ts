/**
 * E2E (KDM-263) — two real browsers agree the route out of the hub, over the real wire.
 *
 * The unit layer proves the arbitration and proves the wrap reverts a write driven through KD's own
 * draw function. Neither of those runs in a browser, and the bug this slice fixes is a BROWSER bug:
 * the journey click never left the client, because `KDRenderJourneyMap` writes `JourneyTarget` inline
 * instead of calling `KDSendInput`. What only a browser can show is the whole chain — the wrap fires
 * in the page, the client's `KDSendInput` routing gate carries it, the server arbitrates, and the
 * agreed answer comes back to BOTH pages as world state.
 *
 * The choice is driven through the KEYBOARD branch of the real `KDRenderJourneyMap`
 * (`KinkyDungeonKeybindingCurrentKey === KinkyDungeonKeyWait[0]` → `JourneyTarget =
 * currentSlot.Connections[0]`, KDJourney.ts:434-440) rather than by clicking pixels on the map
 * screen: both branches are the same inline write inside the same draw call, and the keyboard one
 * needs no sprite geometry. Nothing about the routing is stubbed — this is the production
 * `KDSendInput` wrapper, the production socket and the production session.
 *
 * The fork is planted on the SERVER and reaches the pages as world state. That is deliberate: if the
 * pages did not receive `JourneyMap` from the world, step one would fail here rather than in some
 * later run — the pages must be arguing about the same map.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, reportedPageErrors } from './helpers/coop';
import type { Page } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Two routes out of 0,0. Matches the unit spec's fixture so the two layers argue about one map. */
const FORK = {
	'0,0': { x: 0, y: 0, type: 'shop', color: '#fffafa', Connections: [{ x: 0, y: 1 }, { x: 1, y: 1 }], SideRooms: [], HiddenRooms: {}, MapMod: '', RoomType: '', Faction: '', EscapeMethod: '' },
	'0,1': { x: 0, y: 1, type: 'dungeon', color: '#fffafa', Connections: [], SideRooms: [], HiddenRooms: {}, MapMod: 'LeftMod', RoomType: '', Faction: '', EscapeMethod: '' },
	'1,1': { x: 1, y: 1, type: 'dungeon', color: '#fffafa', Connections: [], SideRooms: [], HiddenRooms: {}, MapMod: 'RightMod', RoomType: '', Faction: '', EscapeMethod: '' },
};
const LEFT = { x: 0, y: 1 };

/**
 * Do in the page exactly what a frame of the journey map does when the player presses the "down"
 * key, and report what the page was left holding.
 *
 * `target` is read AFTER the call: it is the client's own `KDGameData.JourneyTarget`, and R9 says it
 * must be untouched — the client may not commit a route locally, only display the one it is sent.
 */
async function pickFirstRoute(P: Page): Promise<{ target: any; routed: number }> {
	return P.evaluate(() => {
		// @ts-ignore bundle let-globals
		const before = __KDCoopJourneyStats.routed;
		// @ts-ignore
		KinkyDungeonKeybindingCurrentKey = KinkyDungeonKeyWait[0];
		// Drawn far from the party's slot on purpose: no sprite falls in the window, so nothing is
		// painted and the keyboard branch is reached on its own.
		// @ts-ignore
		KDRenderJourneyMap(0, 99, 5, 7);
		// @ts-ignore
		const t = KDGameData.JourneyTarget;
		// @ts-ignore
		return { target: t ? { x: t.x, y: t.y } : null, routed: __KDCoopJourneyStats.routed - before };
	});
}

/** What this page believes about the party's route — all of it world state, none of it its own. */
async function pageJourney(P: Page) {
	return P.evaluate(() => ({
		// @ts-ignore
		slots: Object.keys((KDGameData as any).JourneyMap || {}).length,
		// @ts-ignore
		conns: (((KDGameData as any).JourneyMap || {})['0,0'] || { Connections: [] }).Connections.length,
		// @ts-ignore
		target: (KDGameData as any).JourneyTarget
			// @ts-ignore
			? { x: (KDGameData as any).JourneyTarget.x, y: (KDGameData as any).JourneyTarget.y } : null,
		// @ts-ignore
		use: !!(KDGameData as any).UseJourneyTarget,
	}));
}

test('two players propose and agree a route, and neither browser can commit one alone', async ({ browser }) => {
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

		// The party stands at the fork. Planted in the WORLD; the pages have to be told.
		bridge.session.world.eval(`(function(){
			KDGameData.JourneyMap = ${JSON.stringify(FORK)};
			KDGameData.JourneyX = 0; KDGameData.JourneyY = 0;
			KDGameData.JourneyTarget = null; KDGameData.UseJourneyTarget = false;
		})()`);

		// R10, and the precondition for everything below: both pages see the SAME routes. If this
		// times out, the world half of KDGameData is not reaching the client and no amount of correct
		// arbitration would be visible.
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			await expect
				.poll(async () => (await pageJourney(P)).conns, {
					message: `${label} must receive the party's JourneyMap as world state`, timeout: 30_000,
				})
				.toBe(2);
		}

		// ── A picks. The wrap must route it and leave A's own target alone. ───────────────────────
		const a1 = await pickFirstRoute(A);
		expect(a1.routed, 'the wrap saw KD\'s inline write and routed it').toBe(1);
		expect(a1.target,
			'R9: a selection that only mutated client state has not happened — the browser must not be '
			+ 'able to commit a route by itself').toBe(null);

		await expect
			.poll(() => bridge.session.journeyReport().pending, {
				message: 'R5: the choice must reach the server as a routed input', timeout: 30_000,
			})
			.toEqual(LEFT);
		expect(bridge.session.journeyReport().committed,
			'R5: one player is a proposal, not an agreement').toBe(null);
		// …and nobody's browser has jumped ahead of the world.
		expect((await pageJourney(A)).target, 'A holds only what the world sent it').toBe(null);
		expect((await pageJourney(B)).target, 'B holds only what the world sent it').toBe(null);

		// ── B agrees, by picking the same slot. ───────────────────────────────────────────────────
		const b1 = await pickFirstRoute(B);
		expect(b1.routed, 'B\'s choice is routed the same way').toBe(1);

		await expect
			.poll(() => bridge.session.journeyReport().committed, {
				message: 'R6: the same slot from the OTHER player commits it', timeout: 30_000,
			})
			.toEqual({ ...LEFT, use: true });

		// ── and the agreed answer comes back to both pages, in KD's own fields. ───────────────────
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			await expect
				.poll(async () => await pageJourney(P), {
					message: `R6/R10: ${label} must be shown the route the party agreed`, timeout: 30_000,
				})
				.toMatchObject({ target: LEFT, use: true });
		}

		const { real } = reportedPageErrors(errs);
		expect(real, 'no page errors while agreeing a route').toEqual([]);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});
