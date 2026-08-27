/**
 * KDM-271 — a start perk is the PARTY's, so the floor cannot depend on who was swapped in.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────────────
 * KDM-238 gave every seat its own start perks (`_seatPlayer` → `applyPerks([...base, ...perksOf(id)])`).
 * F10 of KDM-242 found that this is the same defect that task fixed for MID-RUN perks, already
 * shipped: several perks rewrite the SHARED world and are read from whichever bundle happens to be
 * swapped in when the read runs — `Stealthy` scales the floor's enemy count and doubles its treasure
 * count (`KDMapGen.ts:1049`, `:1770`), `Pristine` its rubble, `Doorknobs` whether doors generate open,
 * `Fortify_Barricade` the enemy commander's AI, `Blackout` enemy vision, plus the generic
 * `obj.FilterPerk` gate. All of them are pickable at character creation: the grid is populated from
 * the whole of `KinkyDungeonStatsPresets` by category with no `tags: ["start"]` filter
 * (`KinkyDungeon.ts:930-937`). So a host with `Stealthy` and a guest without it made the floor's
 * difficulty a function of swap order.
 *
 * ── THE RULE UNDER TEST ───────────────────────────────────────────────────────────────────────────
 * The same one KDM-242 D1 uses at the other end of the run: a perk belongs to the party. The start
 * set is the UNION of every seat's declaration, applied to every seat. Nothing here classifies perks
 * as "world-affecting" — if no perk differs between two seats, no world read can differ either, and a
 * subset would have to name perks in `tools/mp-server/**`, which epic AC2 forbids.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. Every "the partner has it too" assertion is PAIRED with a control key that NOBODY declared and
 *     that must be absent from both. An implementation that switches every perk on passes the first
 *     half and fails the second.
 *  2. The union is asserted BOTH WAYS ROUND — A's perk reaching B and B's perk reaching A — off one
 *     booted session, so "everyone gets the host's set" is not enough to pass.
 *  3. The seats are compared by VALUE, as whole sets, not key by key: the property is "these two
 *     bundles agree", which is exactly what a world read swapping between them needs.
 *  4. The start-EFFECT is asserted on the body (`Submissive`'s BasicCollar, `Unchained`'s RedKey),
 *     not merely the flag, so writing the map without `KDInitPerks` cannot pass.
 *  5. The single-seat case is asserted against `partyPerks()` being exactly that seat's declaration —
 *     req 4, "with one player seated, behaviour is indistinguishable from stock KD".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/**
 * A perk NOBODY declares, in every session below. It is the control for every positive assertion:
 * "the partner gained A's perk" means nothing unless "the partner did not gain a perk out of thin
 * air" is asserted in the same breath. `Pacifist` has a visible start-effect (a Rope weapon) so its
 * absence is checkable on the body as well as in the map.
 */
const UNDECLARED = 'Pacifist';

describe('KDM-271 — the start perk set is the party\'s (R1, R2)', () => {
	let s: any = null;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'party-start-perks' });
		// Both seats declare, and they declare DIFFERENT things — the union has to travel in both
		// directions or one of the two assertions below fails.
		// `Submissive` (collar + leash) and `Studious` (a spell point) both have start-effects, so the
		// grant can be checked on the body and not only as a flag.
		// The garbage key rides along to prove KD's own table is still what rejects it.
		s.setCharacter('A', { perks: ['Submissive', 'NoSuchPerkAtAll'] });
		s.setCharacter('B', { perks: ['Studious'] });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	/** The perk keys actually switched on inside that player's OWN captured bundle. */
	function perksIn(clientId: string): string[] {
		s.world.restorePlayer(s.bundles.get(clientId));
		return (s.world.eval(`(function(){
			if (typeof KinkyDungeonStatsChoice === 'undefined' || !KinkyDungeonStatsChoice) return [];
			return Array.from(KinkyDungeonStatsChoice.keys())
				.filter(function(k){ return KinkyDungeonStatsChoice.get(k); });
		})()`) || []) as string[];
	}

	/** The restraint names worn by that player, from KD's own accessor. */
	function restraintsIn(clientId: string): string[] {
		s.world.restorePlayer(s.bundles.get(clientId));
		return (s.world.eval(`(function(){
			if (typeof KinkyDungeonAllRestraint !== 'function') return [];
			return KinkyDungeonAllRestraint().map(function(r){ return String(r && r.name || ''); });
		})()`) || []) as string[];
	}

	/**
	 * How many of a named item that player is carrying, from KD's own accessor
	 * (`KinkyDungeonInventory.ts:645`). One helper for every start-effect that manifests as an item —
	 * `Unchained`'s RedKey and the control perk's Rope — because two copies would drift.
	 */
	function inventoryCount(clientId: string, name: string): number {
		s.world.restorePlayer(s.bundles.get(clientId));
		return (s.world.eval(`(function(){
			if (typeof KinkyDungeonInventoryGet !== 'function') return -1;
			var it = KinkyDungeonInventoryGet(${JSON.stringify(name)});
			return it ? (it.quantity === undefined ? 1 : it.quantity) : 0;
		})()`) || 0) as number;
	}

	it('R1 — the union travels host → guest', () => {
		expect(perksIn('A')).toContain('Submissive');
		expect(perksIn('B'), 'the guest holds the host\'s world-affecting perk too').toContain('Submissive');
	});

	it('R1 — and guest → host, so this is a union and not "the host decides"', () => {
		expect(perksIn('B')).toContain('Studious');
		expect(perksIn('A'), 'the host holds the guest\'s perk too').toContain('Studious');
	});

	it('CONTROL — a perk nobody declared is on nobody', () => {
		// Without this, "grant everything to everyone" would pass every assertion above.
		expect(perksIn('A')).not.toContain(UNDECLARED);
		expect(perksIn('B')).not.toContain(UNDECLARED);
		expect(inventoryCount('A', 'Rope'), 'and its start-effect is on nobody either').toBe(0);
		expect(inventoryCount('B', 'Rope')).toBe(0);
	});

	it('R1 — the two seats agree as WHOLE SETS, which is what a world read needs', () => {
		// The property is not "B has Submissive"; it is "whichever bundle KDMapGen finds swapped in,
		// it answers the same". Compared by value, sorted, so order of application cannot hide a
		// difference.
		expect([...perksIn('A')].sort()).toEqual([...perksIn('B')].sort());
	});

	it('R1 — the START-EFFECT of the partner\'s perk landed too, not just the flag', () => {
		// A seat is built from KD's own new-game template, so `applyPerks` runs `KDInitPerks()` for
		// the whole party set. `Submissive` adds a BasicCollar and a BasicLeash
		// (`KinkyDungeonPerks.ts:737-740`) — B declared neither and wears both.
		expect(restraintsIn('A')).toEqual(expect.arrayContaining(['BasicCollar', 'BasicLeash']));
		expect(restraintsIn('B')).toEqual(expect.arrayContaining(['BasicCollar', 'BasicLeash']));
	});

	it('R2 — an unknown perk key is still dropped by KD\'s own table, not applied', () => {
		expect(perksIn('A')).not.toContain('NoSuchPerkAtAll');
		expect(perksIn('B')).not.toContain('NoSuchPerkAtAll');
	});


	it('R2 — `partyPerks()` is the union of DECLARATIONS, and each seat\'s own is untouched', () => {
		// The declaration is what the player SAID; the union is what the party plays with. Conflating
		// them would make a partner's perk look like this player's own choice on the wire.
		//
		// Note `NoSuchPerkAtAll` is in the union: the gate deliberately does not judge whether a perk
		// exists (that would be a perk list in `tools/mp-server/**`, epic AC2), so a bogus key travels
		// all the way to `applyPerks` and dies against `KinkyDungeonStatsPresets` — which is what the
		// assertion above measured. Pinned here so nobody "tidies" the union into a validator.
		expect([...s.partyPerks()].sort()).toEqual(['NoSuchPerkAtAll', 'Studious', 'Submissive'].sort());
		expect(s.perksOf('A')).toEqual(['Submissive', 'NoSuchPerkAtAll']);
		expect(s.perksOf('B')).toEqual(['Studious']);
	});

	it('R1 — the agreement does not drift as the session runs', () => {
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect([...perksIn('A')].sort()).toEqual([...perksIn('B')].sort());
		expect(perksIn('A')).toContain('Studious');
	});

	it('R3 — a LATE arrival widens the party set, and grants a PERK rather than a character', () => {
		// `Unchained` adds a RedKey consumable (`KinkyDungeonPerks.ts:748`). Nobody in the party has
		// declared it, so it is a fresh key AND a fresh start-effect — which is what lets one test
		// assert both halves of the rule at once.
		//
		// ⚠️ THE BASELINE IS MEASURED, NOT ASSUMED. KD's own new game already hands out RedKeys
		// (measured: 2 before the join), so asserting `toBe(0)` would have been this test asserting
		// the wrong thing rather than the implementation being wrong.
		const aKeysBefore = inventoryCount('A', 'RedKey');

		s.setCharacter('C', { perks: ['Unchained'] });
		const res = s.joinInProgress('C');
		expect(res.seated, 'the late join itself has to work for this to mean anything').toBe(true);

		// The newcomer is a fresh character and gets the WHOLE party set, start-effects included.
		expect(perksIn('C')).toEqual(expect.arrayContaining(['Submissive', 'Studious', 'Unchained']));
		expect(restraintsIn('C'), 'a seat is built from the party set, not from its own declaration')
			.toContain('BasicCollar');

		// …and the seats already taken hold the new key, or the union is per-seat again the moment
		// anybody joins late — the defect with extra steps.
		expect(perksIn('A'), 'the host caught up').toContain('Unchained');
		expect(perksIn('B'), 'the guest caught up').toContain('Unchained');
		expect([...perksIn('A')].sort()).toEqual([...perksIn('C')].sort());

		// THE PAIR THAT PINS THE ASYMMETRY. `grantPerks` deliberately does not run `KDInitPerks()`:
		// re-running it on an already-seated player would re-apply THEIR OWN start-effects too
		// (`Submissive` adds its collar and leash unconditionally), so somebody else walking in would
		// silently re-equip everybody. A gained the flag and no key; C, built as a character in the
		// very same call, gained a key from the very same perk. An implementation that skipped the
		// fan-out fails the first half; one that re-ran `KDInitPerks` fails the second.
		expect(inventoryCount('A', 'RedKey'), 'no start-effect on a mid-run grant').toBe(aKeysBefore);
		expect(inventoryCount('C', 'RedKey'), 'and a seat IS a character, so this half must differ')
			.toBeGreaterThan(aKeysBefore);

		// Still nothing out of thin air.
		expect(perksIn('C')).not.toContain(UNDECLARED);
		expect(perksIn('A')).not.toContain(UNDECLARED);
	});
});
