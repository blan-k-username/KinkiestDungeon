/**
 * Node-layer (Vitest) — KDM-264: buy the item you selected, not your partner's neighbour.
 *
 * ── WHAT WAS BROKEN, AND WHAT WAS ALREADY RIGHT ───────────────────────────────────────────────────
 * Most of "two players share the hub merchants" works by construction, and this spec covers that half
 * as CHARACTERISATION rather than reporting it as work: the stock is `KDMapData.ShopItems` (world
 * state, `KDMapGen.ts:191-192`), the purse is `KinkyDungeonGold` (an ordinary small global, so
 * per-player). Two purses, one stock, no duplication and no double-sale come for free.
 *
 * The CURSOR did not. `KinkyDungeonShopIndex` is a per-player index INTO that shared array and the
 * buy is a routed input carrying that index (`KinkyDungeonInput.ts:613-620`:
 * `KinkyDungeonShopIndex = data.shopIndex; KinkyDungeonPayShrine(...)`). So if A buys index 0 while B
 * points at index 2, B's next click buys index 2 of a now-SHORTER array — a different item. Money
 * spent, wrong goods.
 *
 * ── THREE THINGS THE FIXTURE HAD TO BE TAUGHT (measured, not assumed) ─────────────────────────────
 *   1. `shrineBuy` classifies as **turn**, so a buy is not applied until the whole party has
 *      submitted. Every purchase here is therefore a real lockstep turn with the partner waiting —
 *      the shape a real session actually has. A spec that only called `apply()` would assert on a
 *      purchase that never happened, and every expectation would still be readable and wrong.
 *   2. A fresh KD character already OWNS some of these consumables, so every inventory assertion is a
 *      DELTA against a baseline read in the same test.
 *   3. The price is `KinkyDungeonShrineCost('Commerce')` (50), not the item's own `cost` field.
 *
 * ── WHY THE STOCK IS PLANTED ──────────────────────────────────────────────────────────────────────
 * A generated shop is 8-11 items whose names depend on the seed, the level and `KDRandom`. Asserting
 * "B got the item B was pointing at" means NAMING that item. The names planted are real
 * `KinkyDungeonConsumables` entries, so `KinkyDungeonPayShrine` takes its real consumable branch —
 * cost, inventory, splice and reward program are all still KD's own code.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ────────────────────────────────────────────────────
 * "B bought the right thing" is also what you would see if B's index had never gone stale. So the
 * central test first asserts the stale-index PRECONDITION — that the index B holds now points at a
 * different item — and a separate CONTROL measures what KD's UNWRAPPED handler does with that exact
 * input. The pair is the assertion: the wrap changed the outcome on an input that would otherwise
 * have bought the neighbour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Real `KinkyDungeonConsumables` names, in a known order, all `shoptype: 'consumable'` (KD's `Consumable`). */
const NAMES = ['PotionMana', 'ManaOrb', 'PotionWill', 'PotionStamina'];
const STOCK = NAMES.map((name) => ({
	name, shoptype: 'consumable', consumable: true, quantity: 1, rarity: 0, cost: 1,
}));

/** Enough coin that price is never the reason a purchase does or does not happen. */
const PURSE = 5000;

function session(players: string[]) {
	const s: any = new SwapSession({ requiredPlayers: players.length, seed: 'kdm264-shop', pvp: false });
	for (const p of players) s.join(p);
	return s;
}

function plantShop(s: any) {
	s.world.eval(`(function(){ KDMapData.ShopItems = ${JSON.stringify(STOCK)}; })()`);
	for (const [id, b] of s.bundles) {
		s.world.restorePlayer(b);
		s.world.eval(`(function(){ KinkyDungeonGold = ${PURSE}; KinkyDungeonShopIndex = 0; })()`);
		s.bundles.set(id, s.world.capturePlayer());
	}
	s.world.parkGlobalPlayer(1, 1);
}

/** Point this player's cursor at a slot, the way selecting an item in the shop list does. */
function selectIndex(s: any, who: string, idx: number) {
	s.world.restorePlayer(s.bundles.get(who));
	s.world.eval(`(function(){ KinkyDungeonShopIndex = ${idx | 0}; })()`);
	s.bundles.set(who, s.world.capturePlayer());
	s.world.parkGlobalPlayer(1, 1);
}

/**
 * Buy over a REAL lockstep turn, exactly as the browser sends it: the index this client is pointing
 * at, TAGGED with the item that client is currently SHOWING at that index.
 *
 * `seenStock` is the client's own view, which is the whole point — by the time the server sees the
 * input the shared stock may already have moved. Passing the server's current stock here would make
 * the test send the answer instead of the question.
 */
function buy(s: any, who: string, shopIndex: number, seenStock = STOCK, opts: { tag?: boolean } = {}) {
	const item = seenStock[shopIndex];
	const data: any = { type: 'Commerce', shopIndex };
	if (opts.tag !== false && item) data.shopItemId = `${item.name}|${item.shoptype}`;
	const res = s.apply(who, { kdType: 'shrineBuy', data });
	// `shrineBuy` is turn-consuming, so the party has to finish the turn for it to be applied at all.
	for (const other of s._joined) if (other !== who) s.submit(other, { kind: 'wait' });
	return res;
}

/** What is on the shelves — the SHARED stock, read from the world. */
function shelf(s: any): string[] {
	return s.world.eval('KDMapData.ShopItems.map(function(i){ return i.name; })');
}

/** This player's purse, cursor and consumable counts. Read between turns; leaves the world parked. */
function playerState(s: any, who: string) {
	s.world.restorePlayer(s.bundles.get(who));
	const out = s.world.eval(`(function(){
		var owned = {};
		${JSON.stringify(NAMES)}.forEach(function(n){
			var e = KinkyDungeonInventoryGet(n);
			owned[n] = (e && e.quantity) || 0;
		});
		return { gold: KinkyDungeonGold, index: KinkyDungeonShopIndex, owned: owned };
	})()`);
	s.world.parkGlobalPlayer(1, 1);
	return out;
}

/** Everything the session has told this player, flattened — where a refusal message lands. */
function logText(s: any, who: string): string {
	return (s.logs.get(who) || []).map((m: any) => (m && m.text) || String(m)).join(' | ');
}

describe('KDM-264 — the hub merchants serve two players', () => {
	let s: any;
	beforeEach(async () => {
		s = session(['A', 'B']);
		await s.ready();
		plantShop(s);
	}, BOOT_TIMEOUT);

	it('R12: B buys the item B selected, even though A\'s purchase shifted every index', () => {
		selectIndex(s, 'A', 0);          // A points at PotionMana
		selectIndex(s, 'B', 2);          // B points at PotionWill
		const b0 = playerState(s, 'B');

		buy(s, 'A', 0);
		expect(shelf(s), 'PRECONDITION: A\'s purchase really did shrink the shared stock')
			.toEqual(['ManaOrb', 'PotionWill', 'PotionStamina']);
		expect(shelf(s)[2],
			'PRECONDITION: the off-by-one must land on a DIFFERENT item, or a green here proves nothing')
			.toBe('PotionStamina');

		// B buys, still pointing at index 2 and still showing the stock B last saw.
		buy(s, 'B', 2);

		const b1 = playerState(s, 'B');
		expect(b1.owned.PotionWill - b0.owned.PotionWill, 'R12: B receives the item B selected').toBe(1);
		expect(b1.owned.PotionStamina - b0.owned.PotionStamina,
			'R12: …and NOT the neighbour the stale index pointed at').toBe(0);
		expect(shelf(s), 'R13: the item B bought is the one removed from the shared stock')
			.toEqual(['ManaOrb', 'PotionStamina']);
	}, BOOT_TIMEOUT);

	it('CONTROL: KD\'s UNWRAPPED handler buys the neighbour on that exact input', () => {
		// The bug, measured rather than asserted about. Without this the test above could be green
		// because B's index never went stale in the first place.
		selectIndex(s, 'A', 0);
		selectIndex(s, 'B', 2);
		const b0 = playerState(s, 'B');
		buy(s, 'A', 0);

		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval(`(function(){
			KinkyDungeonShopIndex = 2;
			KDInputTypes.shrineBuy._kdcoop_shop_original({ type: 'Commerce', shopIndex: 2 });
		})()`);
		s.bundles.set('B', s.world.capturePlayer());
		s.world.parkGlobalPlayer(1, 1);

		const b1 = playerState(s, 'B');
		expect(b1.owned.PotionStamina - b0.owned.PotionStamina,
			'stock KD resolves by INDEX, so it hands over whatever now sits there — this IS the bug')
			.toBe(1);
		expect(b1.owned.PotionWill - b0.owned.PotionWill, '…and not the item B had selected').toBe(0);
	}, BOOT_TIMEOUT);

	it('R14: an item that is gone is refused with a message, not silently swapped', () => {
		selectIndex(s, 'A', 2);
		selectIndex(s, 'B', 2);          // both looking at PotionWill
		const b0 = playerState(s, 'B');

		buy(s, 'A', 2);                  // …which A buys first
		expect(shelf(s), 'PRECONDITION: the item B wants is really gone').not.toContain('PotionWill');
		const shelfAfterA = shelf(s);
		const goldBefore = playerState(s, 'B').gold;

		buy(s, 'B', 2);                  // B clicks buy on the item B still sees

		const b1 = playerState(s, 'B');
		for (const n of NAMES) {
			expect(b1.owned[n] - b0.owned[n],
				`R14: a refused purchase must hand over nothing at all — least of all ${n}`).toBe(0);
		}
		expect(b1.gold, 'R14: …and must cost nothing').toBe(goldBefore);
		expect(logText(s, 'B'),
			'R14: B is SHOWN that the item is unavailable, rather than nothing happening')
			.toMatch(/already been sold/i);
		expect(shelf(s), 'R13: and no second item leaves the shelf').toEqual(shelfAfterA);
	}, BOOT_TIMEOUT);

	it('R13 (characterisation): purses and inventories stay per-player, stock stays shared', () => {
		// Already true before this task. Covered so a later change cannot break it in silence — the
		// existing behaviour is not "work done" here, it is the thing that must not regress.
		selectIndex(s, 'A', 0);
		const before = { A: playerState(s, 'A'), B: playerState(s, 'B') };
		buy(s, 'A', 0);
		const after = { A: playerState(s, 'A'), B: playerState(s, 'B') };

		expect(after.A.gold, 'the buyer pays').toBeLessThan(before.A.gold);
		expect(after.B.gold, 'the partner does not').toBe(before.B.gold);
		expect(after.A.owned.PotionMana - before.A.owned.PotionMana, 'the buyer receives it').toBe(1);
		expect(after.B.owned.PotionMana - before.B.owned.PotionMana, 'the partner does not').toBe(0);
		expect(shelf(s).filter((n: string) => n === 'PotionMana'),
			'one stock, sold once — no duplication and no double-sale').toEqual([]);
	}, BOOT_TIMEOUT);

	it('an untagged buy (a stock KD client) still resolves by index, exactly as it always did', () => {
		// The compatibility half of "resolve by identity": an input the wrap cannot IDENTIFY must not
		// become a refusal. Failing closed here would break every client that is not ours.
		selectIndex(s, 'A', 1);
		const a0 = playerState(s, 'A');
		buy(s, 'A', 1, STOCK, { tag: false });
		const a1 = playerState(s, 'A');
		expect(a1.owned.ManaOrb - a0.owned.ManaOrb, 'index resolution is untouched without a tag').toBe(1);
		expect(shelf(s)).toEqual(['PotionMana', 'PotionWill', 'PotionStamina']);
	}, BOOT_TIMEOUT);

	it('the resolver is a WRAP, with KD\'s own handler still underneath it', () => {
		// WRAP_CONVENTION, asserted rather than assumed: `_prev` must be reachable (the CONTROL test
		// above depends on it) and the sentinel must live on the wrapper, not on globalThis.
		const shape = s.world.eval(`(function(){
			return {
				wrapped: !!KDInputTypes.shrineBuy._kdcoop_shop_wrapped,
				hasPrev: typeof KDInputTypes.shrineBuy._kdcoop_shop_original,
				text: (typeof TextGet === 'function') ? TextGet('KDCoopShopItemGone') : '',
			};
		})()`);
		expect(shape.wrapped).toBe(true);
		expect(shape.hasPrev).toBe('function');
		expect(shape.text, 'a missing text key prints "[NotFound] …" straight at the player')
			.not.toMatch(/NotFound/);
	}, BOOT_TIMEOUT);
});
