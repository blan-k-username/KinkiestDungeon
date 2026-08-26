/**
 * E2E (KDM-242) — two real browsers agree a perk, and BOTH of them get it, over the real wire.
 *
 * The unit layer proves the arbitration and proves the wrap suppresses an Accept driven through KD's
 * own draw function. Neither of those runs in a browser, and the bug this slice fixes is a BROWSER
 * bug — in fact two of them, both inside `KinkyDungeonDrawPerkOrb`, neither of which calls
 * `KDSendInput`:
 *
 *   · the card cursor is `KDMapData.SelectedPerk` (KinkyDungeonShrine.ts:980), which is WORLD state
 *     the page adopts wholesale from every snapshot (`render-client.js:509`) — so the highlight a
 *     player set was erased on the next frame, and since the Accept button renders only while
 *     `SelectedPerk == i` (:950) **it could never be reached**;
 *   · and the Accept callback (:955-975) applied the perk, the restraints and the altar wipe locally,
 *     where the server never saw any of it.
 *
 * What only a browser can show is the whole chain: the wrap fires in the page against the page's own
 * snapshot-driven `KDMapData`, the private cursor survives frames the shared one does not, the
 * client's `KDSendInput` routing gate carries the Accept, the server arbitrates, and the granted perk
 * comes back to BOTH pages. Nothing here is stubbed — production wrap, production socket, production
 * session.
 *
 * The perk room is planted on the SERVER and reaches the pages as world state, deliberately: if the
 * pages did not receive `PerkShrines` from the world, step one fails here rather than somewhere later.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, reportedPageErrors } from './helpers/coop';
import type { Page } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Do in the page exactly what a frame of the perk modal does when the player clicks a card and then
 * Accept — through KD's OWN button callbacks, captured out of `DrawButtonKDEx` rather than by clicking
 * pixels (the modal's geometry is PIXI, and both routes are the same callback).
 *
 * BARE NAMES, not `window.X`: KD compiles to one bundle whose `let`-globals are not properties of
 * `globalThis`, so `window.KDMapData` is `undefined` while `KDMapData` resolves. Only
 * `__KDCoopPerkStats` / `__KDCoopPerkCursor` are real `globalThis` properties, because the wrap
 * creates them that way on purpose.
 */
async function clickCardThenAccept(P: Page, index: number) {
	return P.evaluate((i) => {
		const captured: Record<string, any> = {};
		// @ts-ignore bundle let-globals
		const realDraw = DrawButtonKDEx;
		// @ts-ignore
		const before = __KDCoopPerkStats.routed;
		try {
			// @ts-ignore
			DrawButtonKDEx = (name: string, cb: any) => { captured[name] = cb; };
			// @ts-ignore
			KinkyDungeonDrawPerkOrb();
		// @ts-ignore
		} finally { DrawButtonKDEx = realDraw; }
		// Select the card — this must move the PRIVATE cursor, never the shared, broadcast one.
		if (captured['perkshrinechoicebg' + i]) captured['perkshrinechoicebg' + i]();
		// @ts-ignore
		const sharedAfterSelect = KDMapData.SelectedPerk;

		// Re-draw so KD offers the Accept button for the now-selected card, then fire it.
		const captured2: Record<string, any> = {};
		try {
			// @ts-ignore
			DrawButtonKDEx = (name: string, cb: any) => { captured2[name] = cb; };
			// @ts-ignore
			KinkyDungeonDrawPerkOrb();
		// @ts-ignore
		} finally { DrawButtonKDEx = realDraw; }
		const sawAccept = typeof captured2['AcceptContractButton' + i] === 'function';
		if (sawAccept) captured2['AcceptContractButton' + i]();

		return {
			// @ts-ignore
			cursor: __KDCoopPerkCursor,
			sharedAfterSelect,
			sawAccept,
			// @ts-ignore
			routed: __KDCoopPerkStats.routed - before,
		};
	}, index);
}

/** What this page believes: the offer (world state) and its own perks (player state). */
async function pagePerks(P: Page, perk: string) {
	return P.evaluate((p) => ({
		// @ts-ignore
		shrines: (KDMapData.PerkShrines || []).length,
		// @ts-ignore
		offered: KinkyDungeonMapGet(7, 3),
		// @ts-ignore
		has: !!KinkyDungeonStatsChoice.get(p),
	}), perk);
}

/**
 * Force BOTH pages to send, so both are pushed a fresh state frame.
 *
 * The thin client is PULL-driven: the server replies to what a page sends, so a page doing nothing
 * never learns about a world change. MEASURED while writing this spec — six seconds after the perk
 * room was planted the page still held the pre-plant map (`KDMapData.Entities` 2 against the world's
 * 3), and it never caught up on its own. That is the harness, not a bug: in a real session the client
 * streams `setMoveDirection` as the mouse moves, and a headless page has no mouse.
 *
 * A single `ui` nudge is NOT enough — measured flaky across independent runs, one page's precondition
 * timing out at 30 s while the other's passed, in both directions. KDM-186 Rule 1 holds one
 * unacknowledged send per stream type and supersedes duplicates, so most pumps never leave the page.
 * Sending from BOTH pages, and waiting on each, is what made it deterministic: three consecutive clean
 * runs at ~1.6 min against a 1-in-2 failure rate before.
 *
 * ⚠️ HONEST NAMING: the tick does NOT reliably advance here, so this is a PUMP, not a turn. The
 * `waitForFunction` below is a short, non-fatal settle — the poll that wraps this call is the actual
 * assertion. It is bounded at 4 s on purpose: at 30 s each the two waits cost a minute per poll
 * iteration and pushed the whole spec from 1.6 min to 6.0 min of pure timeout.
 */
async function pumpBoth(A: Page, B: Page) {
	const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
	await A.evaluate(() => (window as any).__coop.sendAction({ kdType: 'wait' }));
	await B.evaluate(() => (window as any).__coop.sendAction({ kdType: 'wait' }));
	await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout: 4_000 })
		.catch(() => { /* settle only — the caller's poll is the assertion */ });
	await B.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout: 4_000 })
		.catch(() => { /* ditto */ });
}

test('two players propose and agree a perk, and neither browser can grant one alone', async ({ browser }) => {
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

		// Plant the perk room in the WORLD. The perk names come from KD's own table, so this fixture
		// cannot drift from the game and no perk is named in a test file either.
		const perks: string[] = bridge.session.world.eval(`(function(){
			var names = [];
			for (var k in KinkyDungeonStatsPresets) {
				if (!KinkyDungeonStatsChoice.get(k) && KDGetPerkCost(KinkyDungeonStatsPresets[k]) > 0) names.push(k);
				if (names.length >= 3) break;
			}
			var coords = ['5,3', '7,3', '9,3'];
			KDMapData.PerkShrines = coords.slice();
			KDMapData.SelectedPerk = -1;
			for (var i = 0; i < coords.length; i++) {
				var xy = coords[i].split(',');
				KinkyDungeonMapSet(parseInt(xy[0]), parseInt(xy[1]), 'P');
				KinkyDungeonTilesSet(coords[i], { Perks: [names[i]], Bondage: [], Method: "", Type: "PerkOrb", Light: 5 });
			}
			return names;
		})()`);
		const CHOSEN = perks[1];   // the middle altar, at 7,3 — index 1

		// The precondition for everything below: both pages see the SAME offer. If this times out, the
		// perk room is not reaching the clients and no amount of correct arbitration would be visible.
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			await expect
				.poll(async () => { await pumpBoth(A, B); return (await pagePerks(P, CHOSEN)).shrines; }, {
					message: `${label} must receive the party's perk room as world state`, timeout: 30_000,
				})
				.toBe(3);
		}

		// ── A picks card 1 and accepts. The wrap must route it and grant A nothing. ────────────────
		const a1 = await clickCardThenAccept(A, 1);
		expect(a1.cursor, 'the private cursor moved to the card A selected').toBe(1);
		expect(a1.sharedAfterSelect,
			'R14: …and the SHARED, broadcast KDMapData.SelectedPerk did not — a cursor living there is '
			+ 'either the partner\'s too, or erased by the next snapshot').toBe(-1);
		expect(a1.sawAccept,
			'the wrapped draw must still offer KD\'s own Accept button for the private cursor position')
			.toBe(true);
		await pumpBoth(A, B);
		expect(a1.routed, 'R9: the Accept left as a routed input').toBe(1);
		expect((await pagePerks(A, CHOSEN)).has,
			'R9: a browser must be structurally incapable of granting itself a perk').toBe(false);

		await expect
			.poll(() => bridge.session.perkReport().pending, {
				message: 'R5: the choice must reach the server as a routed input', timeout: 30_000,
			})
			.toEqual({ index: 1 });
		expect((await pagePerks(A, CHOSEN)).offered,
			'R10: a proposal consumes no altar').toBe('P');

		// ── B agrees, by accepting the same card. ─────────────────────────────────────────────────
		const b1 = await clickCardThenAccept(B, 1);
		expect(b1.routed, 'B\'s Accept is routed the same way').toBe(1);

		await expect
			.poll(() => bridge.session.perkReport().pending, {
				message: 'R6: the same card from the OTHER player commits it', timeout: 30_000,
			})
			.toBe(null);

		// ── and the granted perk reaches BOTH pages, with the room spent for both. ─────────────────
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			await expect
				.poll(async () => { await pumpBoth(A, B); return await pagePerks(P, CHOSEN); }, {
					message: `R1/R11: ${label} must hold the party's perk and see the room spent`,
					timeout: 120_000,
				})
				.toMatchObject({ has: true, offered: 'p' });
		}

		// CONTROL: a perk the party did NOT take must be absent from both, or "has it" proves only
		// that the StatsChoice Map is full.
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			await pumpBoth(A, B);
			expect((await pagePerks(P, perks[0])).has,
				`CONTROL: ${label} must NOT hold the card nobody agreed`).toBe(false);
		}

		const { real } = reportedPageErrors(errs);
		expect(real, 'no page errors while agreeing a perk').toEqual([]);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise((r) => server.close(r));
	}
});
