/**
 * Node-layer (Vitest) — KDM-284: prune the shared variant registry against ALL seats, not one.
 *
 * ── THE DEBT THIS PAYS OFF ──────────────────────────────────────────────────────────────────────
 * KDM-245 made the three item-variant registries world state, then discovered KD garbage-collects
 * them: `KDPruneInventoryVariants` (`KinkyDungeonInventory.ts:3261`) deletes every variant it cannot
 * find in the LIVE player's inventory or the world's containers, and it runs as the first statement
 * of every descent (`KDStairActions.ts:32`). In the swap-session model exactly one seat is swapped in,
 * so a descent by A would delete everything only B is carrying. KDM-245 therefore suppressed the prune
 * outright while `__kdCoopManaged` is set — bounded, counted, and knowingly wrong.
 *
 * ── THE SHAPE (architecture C, "deferred sweep") ────────────────────────────────────────────────
 * The wrap cannot decide anything: `SwapSession.bundles` lives in Node and the prune fires inside the
 * engine with Node not in the loop. And KD offers no "what WOULD you delete?" query —
 * `KDPruneInventoryVariants` takes eight booleans and nothing else, building `found` from live globals.
 * So the wrap runs the STOCK prune, records what it deleted, and puts it all back; Node drains that
 * record after the turn and deletes only the names no other seat still references.
 *
 * The decisive property: we never re-implement KD's reachability. `_prev` still computes `found`, and
 * we only ever WITHHOLD deletions it proposed. Under-keeping — deleting a partner's live gear — is
 * therefore structurally impossible, which is the only failure direction that loses player data.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ──────────────────────────────────────────────────
 * "The partner's variant survived" is an ABSENCE-of-deletion oracle, which a prune that was broken
 * outright would also satisfy — that is exactly the false green KDM-245's own spec had to guard. So
 * every survival assertion here is PAIRED with a same-shape orphan that must DIE in the same breath.
 * If the orphan survives, the sweep did nothing and the case proved nothing.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost } = require('../../tools/mp-server/headless-host');
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KD_VARIANT_REGISTRY, decideVariantSweep } =
	require('../../tools/mp-server/kd-variant-registry');
import { descend } from './helpers/world';

const BOOT_TIMEOUT = 240_000;
const SESSION_TIMEOUT = 300_000;

describe('KDM-284 · the shared registry is swept against every seat', () => {

	/**
	 * The decision half, tested WITHOUT a world: it is a pure function of (what the prune proposed to
	 * delete, what each swapped-out seat is holding), and pinning it here is what makes the world-level
	 * case below a test of the WIRING rather than of the rule.
	 */
	describe('decideVariantSweep — the rule', () => {

		it('keeps a name a swapped-out seat still references, and sweeps one nobody does', () => {
			const pending = { restraint: ['PartnerRope1', 'OrphanRope2'], weapon: [], consumable: [] };
			// A seat's stored state as it actually travels: JSON, because `capturePlayer()` is JSON-safe
			// by construction (`headless-host.js:3276`).
			const seatB = JSON.stringify({ globals: { KinkyDungeonInventory: { PartnerRope1: { quantity: 1 } } } });

			const out = decideVariantSweep(pending, [seatB]);

			expect(out.keep.restraint, "the partner's variant must survive a descent it did not make")
				.toContain('PartnerRope1');
			// PAIRED CONTROL — same registry, same call, same shape. Without this the case passes on a
			// sweep that keeps everything, which IS the bug being fixed.
			expect(out.sweep.restraint, 'a variant no seat references is still collectable')
				.toContain('OrphanRope2');
			expect(out.keep.restraint).not.toContain('OrphanRope2');
			expect(out.sweep.restraint).not.toContain('PartnerRope1');
		});

		it('matches a QUOTED JSON token, so a name is never kept by accidental substring', () => {
			// Variant names are `prefix + template + ID + curse` (`KinkyDungeonInventory.ts:3634`), so
			// `Rope1` is a genuine prefix of `Rope12`. A naive `includes(name)` would keep `Rope1`
			// forever on the strength of an unrelated `Rope12` — a leak that never surfaces as a bug,
			// only as the registry growth this task exists to stop.
			const pending = { restraint: ['Rope1'], weapon: [], consumable: [] };
			const seat = JSON.stringify({ globals: { KinkyDungeonInventory: { Rope12: { quantity: 1 } } } });

			const out = decideVariantSweep(pending, [seat]);

			expect(out.sweep.restraint, 'Rope12 is not a reference to Rope1').toContain('Rope1');
		});

		it('finds a name held as an object KEY as readily as a string VALUE', () => {
			// The two ways a variant name reaches a seat's state, and the whole reason the test is a
			// token scan rather than a walk of KD's inventory shapes: `{"Rope1":{…}}` (a key, how
			// `KinkyDungeonInventory` holds it) and `{"name":"Rope1"}` (a value, how ground items and
			// `KDGameData.NPCRestraints` hold it). A rule that saw only one of them would delete live
			// gear held the other way.
			const pending = { restraint: ['AsKey', 'AsValue'], weapon: [], consumable: [] };
			const seat = JSON.stringify({ a: { AsKey: 1 }, b: { name: 'AsValue' } });

			const out = decideVariantSweep(pending, [seat]);

			expect(out.keep.restraint).toEqual(expect.arrayContaining(['AsKey', 'AsValue']));
			expect(out.sweep.restraint, 'nothing was unreferenced here').toEqual([]);
		});

		it('sweeps NOTHING when no seat state is available — the degraded path never loses data', () => {
			// R6. "We could not ask the other seats" and "the other seats hold nothing" must not be the
			// same answer: the first has to fall back to KDM-245's keep-everything, because the
			// alternative is deleting a partner's gear on the strength of missing information.
			const pending = { restraint: ['Something'], weapon: [], consumable: [] };

			expect(decideVariantSweep(pending, []).sweep.restraint,
				'no seat state = no evidence = no deletion').toEqual([]);
			expect(decideVariantSweep(pending, null).sweep.restraint,
				'a missing seat list is not an empty one').toEqual([]);
		});

		it('covers all three registries, not just restraints', () => {
			// The weapon and consumable tables are blacklisted and swept by the same code path
			// (`headless-host.js` GLOBAL_BLACKLIST); a fix that handled only restraints would leak two
			// tables silently, because nothing the player can see would change.
			const pending = { restraint: ['R'], weapon: ['W'], consumable: ['C'] };
			const seat = JSON.stringify({ held: ['R', 'W', 'C'] });

			const out = decideVariantSweep(pending, [seat]);

			expect(out.keep.weapon, 'a partner\'s enchanted WEAPON survives too').toContain('W');
			expect(out.keep.consumable, 'and their consumable').toContain('C');
			expect(decideVariantSweep(pending, ['{}']).sweep.weapon, 'control: unreferenced weapons go')
				.toContain('W');
		});
	});

	/**
	 * The wiring half, in a real booted world: does the wrap actually hand Node the names KD's own
	 * prune proposed, and does the world end in the state the decision says it should?
	 */
	describe('the wrap and the world', () => {
		let h: any;

		beforeAll(() => {
			h = new HeadlessHost({ id: 'kdm284-sweep' });
			h.boot();
			h.init({ seed: 'kdm284-sweep-seed' });
			h.loadMod(KD_VARIANT_REGISTRY);
		}, BOOT_TIMEOUT);

		/** A variant registered but referenced by NOTHING — the only kind the prune may take. */
		const orphan = (id: string): string => h.eval(`(function(){
			var template = null;
			KinkyDungeonRestraintsCache.forEach(function(v, k){ if (!template && v && !v.armor) template = k; });
			// KDGetInventoryVariant registers the def and RETURNS the item without adding it anywhere,
			// so it is unreferenced by construction.
			KDGetInventoryVariant({template: template, power: 1, events: []}, "", undefined, ${JSON.stringify(id)});
			return template + ${JSON.stringify(id)};
		})()`);

		const alive = (name: string): boolean =>
			h.eval(`(KinkyDungeonRestraintVariants[${JSON.stringify(name)}] !== undefined)`);

		it('a managed prune deletes nothing and REPORTS what stock KD would have deleted', () => {
			h.eval('globalThis.__kdCoopManaged = true; globalThis.__kdCoopVariantPrunesSkipped = 0;');
			const name = orphan('KDM284Reported');
			expect(alive(name), 'the variant must exist before the sweep, or the case is vacuous').toBe(true);

			h.eval('KDPruneInventoryVariants()');

			// Unchanged from KDM-245: the world is never left short, whatever Node later decides.
			expect(alive(name), 'a managed prune still deletes nothing in the world').toBe(true);
			expect(h.eval('globalThis.__kdCoopVariantPrunesSkipped'),
				'the withhold must be counted, never silent').toBe(1);

			// NEW, and the whole point: the names are no longer thrown away.
			const pending = h.takeVariantPending();
			expect(pending.restraint, 'stock KD proposed this deletion and the wrap must report it')
				.toContain(name);
			// The drain is a TAKE: a second call must not re-offer names already handed over, or every
			// sweep would re-decide the whole history of the run.
			expect(h.takeVariantPending().restraint, 'draining is destructive').not.toContain(name);
		}, BOOT_TIMEOUT);

		it('end to end: the partner\'s variant survives the descent, the orphan does not', () => {
			h.eval('globalThis.__kdCoopManaged = true;');

			// SEAT B: give the live player a variant, capture that as B's stored state, then take it
			// back off the live player. That is precisely the situation the bug describes — a variant
			// referenced only by somebody who is currently swapped OUT.
			const partnerName = h.eval(`(function(){
				var template = null;
				KinkyDungeonRestraintsCache.forEach(function(v, k){ if (!template && v && !v.armor) template = k; });
				KDGiveInventoryVariant({template: template, power: 1, events: []}, "", undefined, "KDM284Partner");
				return template + "KDM284Partner";
			})()`);
			const seatB = JSON.stringify(h.capturePlayer());
			expect(seatB, "B's stored state must actually reference the variant, or the case is vacuous")
				.toContain(`"${partnerName}"`);

			// Now A is the live seat and is NOT holding it.
			h.eval(`KinkyDungeonInventoryRemove({name: ${JSON.stringify(partnerName)}, type: LooseRestraint})`);
			const orphanName = orphan('KDM284Orphan');

			// A descends: stock prune proposes both, wrap withholds both.
			h.eval('KDPruneInventoryVariants()');
			expect(alive(partnerName)).toBe(true);
			expect(alive(orphanName)).toBe(true);

			// Node sweeps, with B's state in hand.
			const decision = decideVariantSweep(h.takeVariantPending(), [seatB]);
			h.deleteVariants(decision.sweep);

			expect(alive(partnerName),
				"a variant only the swapped-out partner holds must survive A's descent").toBe(true);
			// PAIRED CONTROL — same sweep, same call. If this is still alive the sweep is inert and the
			// assertion above is the KDM-245 debt wearing a new name.
			expect(alive(orphanName),
				'control: a variant NO seat references is finally collected again').toBe(false);
		}, BOOT_TIMEOUT);

		it('unmanaged, the world still prunes exactly as stock KD does', () => {
			// R2. The managed path is the deviation; if the unmanaged path drifted, single-player would
			// grow a registry forever and no MP test would ever notice.
			h.eval('globalThis.__kdCoopManaged = false;');
			const name = orphan('KDM284Unmanaged');
			expect(alive(name), 'the control orphan must exist before the sweep').toBe(true);

			h.eval('KDPruneInventoryVariants()');

			expect(alive(name), 'unmanaged: stock KD collects an unreferenced variant inline').toBe(false);
			expect(h.takeVariantPending().restraint,
				'an unmanaged prune withholds nothing, so it reports nothing').toEqual([]);

			h.eval('globalThis.__kdCoopManaged = true;');
		}, BOOT_TIMEOUT);
	});

	/**
	 * The whole thing, in a real two-seat session over a REAL descent.
	 *
	 * The two describes above pin the rule and the wiring in isolation, and both would stay green if
	 * `_onMapChanged` never called the sweep at all — which is the one wire that makes any of this
	 * reach a player. So this case drives KD's own `KinkyDungeonHandleStairs` -> `KDGoThruTile` and
	 * lets the session notice the transition by itself.
	 */
	describe('a real descent in a real session', () => {
		let s: any;

		beforeAll(async () => {
			s = new SwapSession({ requiredPlayers: 2, seed: 'kdm284-session', pvp: false });
			s.join('A'); s.join('B');
			await s.ready();
		}, SESSION_TIMEOUT);

		const alive = (name: string): boolean =>
			s.world.eval(`(KinkyDungeonRestraintVariants[${JSON.stringify(name)}] !== undefined)`);

		const template = (): string => s.world.eval(`(function(){
			var t = null;
			KinkyDungeonRestraintsCache.forEach(function(v, k){ if (!t && v && !v.armor) t = k; });
			return t;
		})()`);

		it("A's descent collects the orphan and spares what B alone is carrying", () => {
			const tpl = template();

			// ── B is holding an enchanted item, and is then swapped OUT. ──────────────────────────
			// This is the entire bug in three lines: after this, B's variant is referenced by nothing
			// stock KD can see, because stock KD only ever looks at whoever is swapped IN.
			s.world.restorePlayer(s.bundles.get('B'));
			const partner = s.world.eval(`(function(){
				KDGiveInventoryVariant({template: ${JSON.stringify(tpl)}, power: 1, events: []},
					"", undefined, "KDM284SessPartner");
				return ${JSON.stringify(tpl)} + "KDM284SessPartner";
			})()`);
			s.bundles.set('B', s.world.capturePlayer());
			expect(JSON.stringify(s.bundles.get('B')),
				"B's seat must really reference the variant, or this case proves nothing")
				.toContain(`"${partner}"`);

			// ── A is live, and holds an unreferenced variant of the same shape. ───────────────────
			// The PAIRED CONTROL for everything below: it must die in the same sweep that spares B's.
			s.world.restorePlayer(s.bundles.get('A'));
			const orphan = s.world.eval(`(function(){
				KDGetInventoryVariant({template: ${JSON.stringify(tpl)}, power: 1, events: []},
					"", undefined, "KDM284SessOrphan");
				return ${JSON.stringify(tpl)} + "KDM284SessOrphan";
			})()`);
			expect(alive(partner)).toBe(true);
			expect(alive(orphan)).toBe(true);

			// ── A takes the stairs. KD's prune runs for real, first statement of KDGoThruTile. ────
			expect(descend(s, 'A'), 'the descent must actually happen').toBe('ok');

			// Immediately after, NOTHING has been collected: the wrap withheld both. If this ever
			// reads false for `partner`, the prune reached the world and B's gear is already gone.
			expect(alive(partner), 'the wrap must withhold every deletion, whatever Node later decides')
				.toBe(true);
			expect(alive(orphan), 'including the ones that will turn out to be collectable').toBe(true);

			// ── One turn, so the session notices the map changed and settles the record. ──────────
			// Deliberately NOT a direct `_sweepVariants()` call: the thing under test is that a party
			// which simply plays on gets the sweep for free.
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });

			expect(alive(partner),
				"a variant only the swapped-out partner holds must survive A's descent").toBe(true);
			expect(alive(orphan),
				'control: with the sweep wired, an unreferenced variant is collected again').toBe(false);
			expect(s.world.eval('globalThis.__kdCoopVariantSwept || 0'),
				'the sweep must report what it took, never collect in silence').toBeGreaterThan(0);
		}, SESSION_TIMEOUT);
	});
});
