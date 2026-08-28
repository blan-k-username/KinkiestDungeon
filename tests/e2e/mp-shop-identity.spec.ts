/**
 * E2E (KDM-264) — a real browser's purchase carries the item it was showing, over the real wire.
 *
 * The unit layer covers the SERVER half: given a tagged `shrineBuy`, the wrapped handler re-finds the
 * item in the shared stock, re-points the index at it, and refuses when it is gone. It cannot cover
 * the CLIENT half, and that half is where the feature lives or dies — the buyer's browser must attach
 * the item it was SHOWING, read from its own `KDMapData.ShopItems` at click time. Only the client
 * knows that: by the time the server sees the input, the stock may already have moved. An untagged
 * buy silently falls back to index resolution, which is the bug.
 *
 * The tag is a wrap on `KDRenderClient.sendInput`, installed by `kd-shop-buy.js`. The buy is driven
 * through `KDSendInput('shrineBuy', …)` — the exact call KD's own shop button makes
 * (`KinkyDungeonShrine.ts:528`) — so the routing gate, the tag, the socket, the session and KD's own
 * `KinkyDungeonPayShrine` are all the production ones.
 *
 * R14's other half — that a selection left open while the stock changes keeps DENOTING the same item
 * — landed as KDM-266, and the tail of this test is where it is pinned. Three things, because the
 * feature has three ways to be quietly wrong:
 *   · the highlight follows its item across a partner's purchase (the expectation that used to read
 *     'PotionStamina' and now reads 'PotionWill');
 *   · it survives REPLICATION — the server's copy of `KinkyDungeonShopIndex` must not overwrite the
 *     viewer's, and its ABSENCE must not reset it, each checked against a control global that IS
 *     clobbered on the same frame;
 *   · and when the selected item is the one sold, the cursor is clamped to a real row and the player
 *     is told (an out-of-range cursor is a crash on KD's own draw path, not a blank selection).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, reportedPageErrors } from './helpers/coop';
import type { Page } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Real `KinkyDungeonConsumables` names, so KD's own consumable branch runs. */
const NAMES = ['PotionMana', 'ManaOrb', 'PotionWill', 'PotionStamina'];
const STOCK = NAMES.map((name) => ({
	name, shoptype: 'consumable', consumable: true, quantity: 1, rarity: 0, cost: 1,
}));

/**
 * Highlight a NAMED item and click Buy, exactly as KD's shop does.
 *
 * By name rather than by a fixed index on purpose: which row an item sits on is precisely what the
 * other player's purchase changes. Returns the index clicked, so a failure can say which row it was.
 */
async function buyByName(P: Page, name: string): Promise<number> {
	const i = await highlight(P, name);
	await P.evaluate(() => {
		// @ts-ignore bundle let-globals — exactly `KinkyDungeonShrine.ts:528`
		KDSendInput('shrineBuy', { type: 'Commerce', shopIndex: KinkyDungeonShopIndex });
	});
	return i;
}

/** Click a row in the shop list — `KinkyDungeonShrine.ts:548`, a purely local cursor move. */
async function highlight(P: Page, name: string): Promise<number> {
	return P.evaluate((n) => {
		// @ts-ignore
		const i = KDMapData.ShopItems.findIndex((it: any) => it.name === n);
		// @ts-ignore
		KinkyDungeonShopIndex = i;
		return i;
	}, name);
}

async function pageShop(P: Page) {
	return P.evaluate((names: string[]) => ({
		// @ts-ignore
		shelf: (KDMapData.ShopItems || []).map((i: any) => i.name),
		// @ts-ignore
		stats: JSON.parse(JSON.stringify(window.__KDCoopShopStats || null)),
		// @ts-ignore
		showing: ((KDMapData.ShopItems || [])[KinkyDungeonShopIndex] || {}).name || null,
		owned: names.reduce((acc: any, n: string) => {
			// @ts-ignore
			const e = KinkyDungeonInventoryGet(n);
			acc[n] = (e && e.quantity) || 0;
			return acc;
		}, {}),
	}), NAMES);
}

test('a purchase carries the item the buyer was showing, and the shared stock loses exactly it', async ({ browser }) => {
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

		// One shared stock, planted in the WORLD, and purses that make cost irrelevant.
		bridge.session.world.eval(`(function(){ KDMapData.ShopItems = ${JSON.stringify(STOCK)}; })()`);
		for (const [id, b] of bridge.session.bundles) {
			bridge.session.world.restorePlayer(b);
			bridge.session.world.eval('(function(){ KinkyDungeonGold = 5000; })()');
			bridge.session.bundles.set(id, bridge.session.world.capturePlayer());
		}
		bridge.session.world.parkGlobalPlayer(1, 1);

		// Both pages must be looking at the SAME shelf before anything is bought — otherwise the two
		// players are not in one shop and nothing below means what it says.
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			await expect
				.poll(async () => (await pageShop(P)).shelf, {
					message: `${label} must receive the shared stock`, timeout: 30_000,
				})
				.toEqual(NAMES);
		}

		// The client half must actually be INSTALLED, or every assertion below reduces to "KD did
		// whatever KD does" — a green that says nothing.
		for (const [label, P] of [['A', A], ['B', B]] as [string, Page][]) {
			expect(await P.evaluate(() => ({
				// @ts-ignore
				send: !!(window.KDRenderClient.sendInput as any)._kdcoop_shop_wrapped,
				// @ts-ignore
				stats: !!window.__KDCoopShopStats,
			})), `${label}: kd-shop-buy.js must have wrapped the client hook`)
				.toEqual({ send: true, stats: true });
		}

		const b0 = await pageShop(B);

		// B highlights the third row, the way clicking that row in KD's shop list does
		// (`KinkyDungeonShrine.ts:548` — a purely local `KinkyDungeonShopIndex = index`), and then
		// leaves it open while the other player shops.
		expect(await highlight(B, 'PotionWill'), 'B highlights the third row').toBe(2);

		// ── A buys the FIRST item, which shifts every later row up by one. ────────────────────────
		expect(await buyByName(A, 'PotionMana'), 'A clicks the first row').toBe(0);
		// `shrineBuy` is turn-consuming, so the party has to finish the turn.
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));

		await expect
			.poll(async () => (await pageShop(B)).shelf, {
				message: 'B must see the item A bought leave the shared shelf', timeout: 30_000,
			})
			.toEqual(['ManaOrb', 'PotionWill', 'PotionStamina']);

		/*
		 * KDM-266 — R14's display half. B was pointing at row 2 (PotionWill); A's purchase shifted
		 * every later row up by one, so row 2 is now PotionStamina and row 1 is PotionWill. The
		 * highlight must have MOVED WITH ITS ITEM rather than staying on its row number.
		 *
		 * This expectation used to read 'PotionStamina' — the gap, pinned deliberately so it could not
		 * be closed without someone noticing this spec had been describing it. It is the inversion of
		 * that line, not a new assertion.
		 */
		expect((await pageShop(B)).showing,
			'KDM-266: B\'s highlight follows PotionWill to its new row, instead of staying on row 2')
			.toBe('PotionWill');

		// ── B buys PotionWill, from the shifted list. ─────────────────────────────────────────────
		const clickedAt = await buyByName(B, 'PotionWill');
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));

		await expect
			.poll(async () => (await pageShop(B)).owned.PotionWill, {
				message: 'R12: B receives the item B clicked', timeout: 30_000,
			})
			.toBe(b0.owned.PotionWill + 1);

		const b1 = await pageShop(B);
		for (const n of ['PotionStamina', 'ManaOrb']) {
			expect(b1.owned[n] - b0.owned[n], `R12: …and nothing else — ${n} must be untouched`).toBe(0);
		}
		expect(bridge.session.world.eval('KDMapData.ShopItems.map(function(i){ return i.name; })'),
			'R13: exactly the bought item left the SHARED stock').toEqual(['ManaOrb', 'PotionStamina']);

		/*
		 * The MECHANISM, not just the outcome. Without this pair a green above could be index
		 * arithmetic that happened to agree — which it does whenever the two views are in step, i.e.
		 * most of the time. `tagged` proves the browser attached the identity; `repointed` proves the
		 * server resolved by that identity instead of taking the index on trust.
		 */
		expect(b1.stats.tagged, 'the client wrap tagged B\'s purchase').toBeGreaterThanOrEqual(1);
		expect(bridge.session.world.eval('__KDCoopShopStats.repointed'),
			'…and the server wrap resolved both purchases by identity').toBeGreaterThanOrEqual(2);
		expect(clickedAt, 'sanity: B clicked a real row, not a hardcoded index').toBeGreaterThanOrEqual(0);
		expect(b1.stats.followed, 'KDM-266: …and the cursor half actually ran').toBeGreaterThanOrEqual(1);

		/*
		 * ── KDM-266 H1: the cursor also has to survive REPLICATION ────────────────────────────────
		 *
		 * Everything above only proves the cursor follows a SHIFTING SHELF. It says nothing about the
		 * other half, because in the script so far the server never had a reason to carry B's
		 * `KinkyDungeonShopIndex` (it is captured only while it differs from the post-init default of
		 * 0). The moment it does, two channels overwrite the viewer's own cursor: `adoptBundle`
		 * installs the server's value, and the absent-rule resets it to 0 once the name has been
		 * dirty and then drops out. `CLIENT_OWNED_GLOBALS` (render-client.js) closes both.
		 *
		 * So plant a DIFFERENT value in B's bundle server-side rather than waiting for one to happen.
		 * B points at row 0; the server says row 1. Without the exclusion B's highlight becomes the
		 * server's row on the next frame.
		 */
		const shelfNow = (await pageShop(B)).shelf;
		expect(shelfNow.length, 'two rows are enough to tell 0 from 1').toBeGreaterThanOrEqual(2);
		expect(await highlight(B, shelfNow[0]), 'B points at the FIRST row').toBe(0);

		// CONTROL, in the same breath and through the same channel: a per-player global the server
		// genuinely owns. If the cursor survives and this does NOT, the finding is "this global is
		// excluded"; if BOTH survive, the frame never landed and the assertion below is vacuous.
		await B.evaluate(() => {
			// @ts-ignore bare let-globals — not on window (CLAUDE.md)
			KinkyDungeonGold = 1;
		});
		const serverGold = bridge.session.world.eval('KinkyDungeonGold');
		bridge.session.world.restorePlayer(bridge.session.bundles.get('B'));
		bridge.session.world.eval('(function(){ KinkyDungeonShopIndex = 1; })()');
		bridge.session.bundles.set('B', bridge.session.world.capturePlayer());
		expect(bridge.session.bundles.get('B').globals.KinkyDungeonShopIndex,
			'precondition: the server now really does carry B\'s cursor').toBe(1);
		bridge.session.world.parkGlobalPlayer(1, 1);

		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		// Wait on the CONTROL being clobbered — that is the proof a bundle was adopted, and it makes
		// the cursor assertion below impossible to pass by simply never receiving a frame.
		await expect
			.poll(async () => B.evaluate(() =>
				// @ts-ignore
				KinkyDungeonGold), { message: 'the control must be overwritten by the server\'s copy', timeout: 30_000 })
			.not.toBe(1);
		expect((await pageShop(B)).showing,
			'H1: the viewer\'s own cursor is not replaced by the server\'s copy of it')
			.toBe(shelfNow[0]);

		// …and the OTHER channel: the name now drops back out of the bundle, which is what the
		// absent-rule reads as "back to the default". It may only do that if the name was never marked
		// dirty — i.e. if the skip sits BEFORE the bookkeeping, not after it.
		bridge.session.world.restorePlayer(bridge.session.bundles.get('B'));
		bridge.session.world.eval('(function(){ KinkyDungeonShopIndex = 0; })()');
		bridge.session.bundles.set('B', bridge.session.world.capturePlayer());
		expect(bridge.session.bundles.get('B').globals.KinkyDungeonShopIndex,
			'precondition: back at its default ⇒ absent from the bundle').toBeUndefined();
		bridge.session.world.parkGlobalPlayer(1, 1);
		expect(await highlight(B, shelfNow[1]), 'B moves to the second row').toBe(1);
		await B.evaluate(() => {
			// @ts-ignore
			KinkyDungeonGold = 1;
		});
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await expect
			.poll(async () => B.evaluate(() =>
				// @ts-ignore
				KinkyDungeonGold), { message: 'the control must be clobbered on this frame too', timeout: 30_000 })
			.not.toBe(1);
		expect((await pageShop(B)).showing, 'H1: an ABSENT cursor is not reset to row 0 either')
			.toBe(shelfNow[1]);

		/*
		 * ── KDM-266 AC2: the selected item is the one that gets sold ──────────────────────────────
		 *
		 * B is pointing at `shelfNow[1]`; A buys exactly that. There is nothing to follow, so the
		 * cursor must be CLAMPED to a real row and the player TOLD — never left denoting whatever
		 * slid into the empty slot, and never pointed at nothing: KinkyDungeonShrine.ts:560/563/566
		 * dereference `ShopItems[KinkyDungeonShopIndex].name` unguarded on every drawn frame.
		 */
		const soldName = shelfNow[1];
		await buyByName(A, soldName);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await expect
			.poll(async () => (await pageShop(B)).shelf, {
				message: 'B must see the item B was pointing at leave the shelf', timeout: 30_000,
			})
			.not.toContain(soldName);

		const after = await B.evaluate(() => ({
			// @ts-ignore
			idx: KinkyDungeonShopIndex,
			// @ts-ignore
			len: (KDMapData.ShopItems || []).length,
			// @ts-ignore
			sold: (window.__KDCoopShopStats || {}).sold,
			// A BARE let-global: `window.KinkyDungeonMessageLog` is undefined (CLAUDE.md), and guarding
			// on it silently reports an empty log for every session.
			// @ts-ignore
			log: (KinkyDungeonMessageLog || []).map((m: any) => (m && m.text) != null ? m.text : String(m)),
			// @ts-ignore
			text: TextGet('KDCoopShopItemSold'),
		}));
		expect(after.idx, 'AC2: the cursor still points at a REAL row (an out-of-range one crashes the draw)')
			.toBeGreaterThanOrEqual(0);
		expect(after.idx).toBeLessThan(after.len);
		expect(after.sold, 'AC2: the sold-out branch is the one that ran').toBeGreaterThanOrEqual(1);
		expect(after.text, 'the text key resolves — a missing one prints "[NotFound] …" at the player')
			.not.toContain('NotFound');
		expect(after.log, 'AC2: B is told, rather than silently handed the neighbour').toContain(after.text);

		const { real } = reportedPageErrors(errs);
		expect(real, 'no page errors while shopping').toEqual([]);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});
