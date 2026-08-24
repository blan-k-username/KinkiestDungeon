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
 * — is NOT implemented, and this spec pins the current (wrong) behaviour explicitly rather than
 * staying silent about it. See KDM-266 and the `kd-shop-buy.js` header.
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
		 * KNOWN GAP, recorded rather than asserted: B's HIGHLIGHT does NOT follow its row. B was
		 * pointing at row 2 (PotionWill) and row 2 is now PotionStamina. The other half of R14 is not
		 * implemented — see the `kd-shop-buy.js` header for the two failed approaches, and KDM-266.
		 *
		 * It is asserted here in its CURRENT form on purpose. A silent omission would let the gap be
		 * "fixed" without anyone noticing this spec had been describing it; when KDM-266 lands, this
		 * expectation flips to 'PotionWill' and the comment goes.
		 */
		expect((await pageShop(B)).showing,
			'KDM-266: the highlight does not yet follow its item — if this is now PotionWill, the gap '
			+ 'has been closed and this expectation should be inverted, not deleted').toBe('PotionStamina');

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

		const { real } = reportedPageErrors(errs);
		expect(real, 'no page errors while shopping').toEqual([]);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});
