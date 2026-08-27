/**
 * Node-layer (Vitest) — KDM-245: giving an item to a co-op partner by DROPPING it.
 *
 * The task's route is deliberately the stock one: KD already has `KDInventoryAction["Drop"]`
 * (`KDInventoryActions.ts:155`) → `KDSendInput("drop")` → `KDDropItemInv`
 * (`KinkyDungeonInventory.ts:3084`), which pushes `{x, y, name, amount}` onto
 * `KDMapData.GroundItems`; the partner picks it up by walking the tile
 * (`KinkyDungeonTiles.ts:238` → `KinkyDungeonItemCheck`). No offer dialogue, no new wire message,
 * nothing of ours in the transfer itself. This spec pins the two properties that decision rests on.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ──────────────────────────────────────────────────
 * Two assertions are of the "absent from the bundle" / "still resolvable" shape, which a capture that
 * did nothing at all would also satisfy. So each carries a CONTROL that must move in the same breath:
 * `KinkyDungeonInventory` is captured per-player and MUST ride the bundle, and the plain template name
 * MUST stay resolvable for the partner. If a control fails, the case proved nothing.
 *
 * The conservation assertion is a DELTA, never "the item is gone": the starting loadout already
 * contains mana potions, so a drop decrements a stack rather than emptying a slot. Asserting absence
 * failed on the first run for exactly that reason — a test bug, not a game one.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost, GLOBAL_BLACKLIST, KDGAMEDATA_WORLD_KEYS, WORLD_GLOBALS_CLIENT } =
	require('../../tools/mp-server/headless-host');
const { KD_VARIANT_REGISTRY } = require('../../tools/mp-server/kd-variant-registry');

const BOOT_TIMEOUT = 240_000;

/** Deterministic name for the variant A creates, so the oracle cannot match something incidental. */
const VARIANT_ID = 'KDM245Variant';

/** A key no game code writes, so its arrival can only mean "this bundle really was restored". */
const CONTROL_GAMEDATA = '__kdm245Probe';

describe('KDM-245 · dropping an item is a transfer to whoever picks it up', () => {
	let h: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm245-drop' });
		h.boot();
		h.init({ seed: 'kdm245-drop-seed' });
	}, BOOT_TIMEOUT);

	it('the ground is WORLD state, so a dropped item is not carried in anyone\'s bundle', () => {
		// `KDMapData` is blacklisted from per-player capture (headless-host.js:42). That is the whole
		// reason this route needs no new sync: the drop lands on the one shared world.
		expect(GLOBAL_BLACKLIST, 'the ground lives inside KDMapData').toContain('KDMapData');

		// Give the player an ordinary consumable and drop it through KD's own input handler
		// (`KinkyDungeonInput.ts:247`), not by hand-editing GroundItems.
		const before = h.eval(`(function(){
			var n = "PotionMana";
			// TWO, and only one is dropped: the inventory must end DIFFERENT from the post-init
			// baseline, or the control below is self-defeating — capture is divergence-based, and
			// give-one/drop-one returns the inventory to baseline so it never enters the bundle.
			KDGiveItem(n, 2);
			var inv = KinkyDungeonInventoryGet(n);
			return {
				held: inv ? (inv.quantity || 1) : 0,
				ground: KDMapData.GroundItems.length,
				onGround: KDMapData.GroundItems.filter(function(i){ return i.name === n; }).length,
			};
		})()`);
		expect(before.held, 'KDGiveItem should have put a plain consumable in the inventory')
			.toBeGreaterThan(0);

		h.applyInput('drop', { item: 'PotionMana' });

		const after = h.eval(`(function(){
			var n = "PotionMana";
			var inv = KinkyDungeonInventoryGet(n);
			var g = KDMapData.GroundItems.filter(function(i){ return i.name === n; });
			return {
				held: inv ? (inv.quantity || 1) : 0,
				ground: KDMapData.GroundItems.length,
				onGround: g.length,
				amount: g.length ? g[g.length - 1].amount : null,
			};
		})()`);

		// Exactly once, never twice: one left the inventory, one appeared on the ground.
		expect(after.held, 'the dropper loses exactly one').toBe(before.held - 1);
		expect(after.ground).toBe(before.ground + 1);
		expect(after.onGround).toBe(before.onGround + 1);
		expect(after.amount).toBe(1);

		// …and the drop is not in the bundle, so restoring any player cannot undo or duplicate it.
		const bundle = h.capturePlayer();
		expect(Object.keys(bundle.globals || {}), 'the world must not ride a player bundle')
			.not.toContain('KDMapData');
		// CONTROL — a per-player global of comparable weight DOES ride, so "absent" above is a fact
		// about KDMapData and not about a capture that returned nothing.
		expect(Object.keys(bundle.globals || {}), 'control: the inventory is per-player')
			.toContain('KinkyDungeonInventory');
	}, BOOT_TIMEOUT);

	it('a VARIANT item dropped by one player still resolves for the partner who picks it up', () => {
		// The ground records a NAME only (`KDDropItemInv`), and a variant's name is resolved through
		// `KinkyDungeonRestraintVariants` (`KDRest`, KinkyDungeonRestraints.ts:263). That registry is
		// a bundle binding in neither GLOBAL_BLACKLIST nor KDGAMEDATA_WORLD_KEYS, so it rides the
		// generic per-player divergence path — which would mean A drops something B cannot resolve.
		// This is the one real risk in the route; the test decides it instead of arguing about it.

		// The partner's bundle, captured BEFORE the variant exists: this is B, who never saw it.
		const bundleB = h.capturePlayer();

		const made = h.eval(`(function(){
			var template = null;
			KinkyDungeonRestraintsCache.forEach(function(v, k){ if (!template && v && !v.armor) template = k; });
			if (!template) return null;
			KDGiveInventoryVariant({template: template, power: 1, events: []}, "", undefined, ${JSON.stringify(VARIANT_ID)});
			var name = template + ${JSON.stringify(VARIANT_ID)};
			return { template: template, name: name, held: !!KinkyDungeonInventoryGet(name) };
		})()`);
		expect(made, 'the restraint cache should have yielded a template').not.toBeNull();
		expect(made.held, 'A should be holding the variant it was just given').toBe(true);

		h.applyInput('drop', { item: made.name });
		const onGround = h.eval(`KDMapData.GroundItems.some(function(i){ return i.name === ${JSON.stringify(made.name)}; })`);
		expect(onGround, 'the variant should be on the ground for the partner to take').toBe(true);

		// Swap the partner in — exactly what the session does between turns.
		h.restorePlayer(bundleB);

		const forPartner = h.eval(`({
			variant: KDRest(${JSON.stringify(made.name)}) ? true : false,
			plain: KDRest(${JSON.stringify(made.template)}) ? true : false,
		})`);

		// CONTROL first: if the plain template is unresolvable too, the oracle is broken, not the game.
		expect(forPartner.plain, 'control: a stock restraint name must resolve for anyone').toBe(true);
		expect(forPartner.variant,
			'a variant dropped by one player must be resolvable by the partner who picks it up')
			.toBe(true);
	}, BOOT_TIMEOUT);

	it('the ITEM ID counter is world, so two players cannot mint the same variant name', () => {
		// Shared registries make the name the identity, and the name is built from
		// `KDGameData.ItemID` (`KDGiveInventoryVariant`, KinkyDungeonInventory.ts:3634). Two
		// per-player counters both start at 1, so the second player's variant would silently lose to
		// the first's entry under the same key.
		expect(KDGAMEDATA_WORLD_KEYS, 'ItemID mints names that live in world containers')
			.toContain('ItemID');

		// The divergence shape of mp-world-generation-keys: a STALE bundle must not move the world.
		const bundle = h.capturePlayer();
		bundle.gameData.ItemID = 1;                     // a stale counter from a player swapped out
		bundle.gameData[CONTROL_GAMEDATA] = 'kdm245';   // CONTROL: an ordinary key on the same bundle

		const worldBefore = h.eval('KDGameData.ItemID');
		h.restorePlayer(bundle);
		const after = h.eval(`({ itemId: KDGameData.ItemID, control: KDGameData[${JSON.stringify(CONTROL_GAMEDATA)}] })`);

		// CONTROL first — if the ordinary key did not land, the bundle was never restored and the
		// assertion below is vacuous.
		expect(after.control, 'control: an ordinary KDGameData key rides the bundle').toBe('kdm245');
		expect(after.itemId, 'the world keeps its own counter').toBe(worldBefore);
	}, BOOT_TIMEOUT);

	it('a managed session does not garbage-collect the shared variant registry', () => {
		// `KDPruneInventoryVariants` deletes every variant it cannot find in the LIVE player's
		// inventory or in the world's containers (KinkyDungeonInventory.ts:3261), and runs on every
		// descent (KDStairActions.ts:32). On a shared table that is one player deleting another's
		// items, so kd-variant-registry.js suppresses it while `__kdCoopManaged` is set.
		h.loadMod(KD_VARIANT_REGISTRY);

		/** Register a variant that NOTHING references — the only kind the prune is entitled to take. */
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

		// Managed → the sweep is skipped and the orphan survives.
		h.eval('globalThis.__kdCoopManaged = true; globalThis.__kdCoopVariantPrunesSkipped = 0;');
		const kept = orphan('KDM245Managed');
		expect(alive(kept), 'the orphan must exist before the sweep, or the case is vacuous').toBe(true);
		h.eval('KDPruneInventoryVariants()');
		expect(h.eval('globalThis.__kdCoopVariantPrunesSkipped'), 'the skip must be counted, never silent').toBe(1);
		expect(alive(kept), 'a managed session keeps a variant only the partner may hold').toBe(true);

		// CONTROL — unmanaged, the stock sweep still works. Without this the case above passes on a
		// prune that was broken outright, which would be a worse bug than the one being fixed.
		h.eval('globalThis.__kdCoopManaged = false;');
		const taken = orphan('KDM245Unmanaged');
		expect(alive(taken), 'the control orphan must exist before the sweep').toBe(true);
		h.eval('KDPruneInventoryVariants()');
		expect(alive(taken), 'control: unmanaged, stock KD still collects an unreferenced variant').toBe(false);

		h.eval('globalThis.__kdCoopManaged = true;');
	}, BOOT_TIMEOUT);

	it('the shared registries reach a client, which no longer receives them in its bundle', () => {
		// The other half of the classification, and the half a server-side test can miss entirely:
		// "not per-player" removed these from the per-player bundle, and the bundle was the ONLY route
		// they had to the browser. A client that cannot resolve a variant name draws an enchanted item
		// with no definition behind it — correct on the server, broken on screen.
		expect(WORLD_GLOBALS_CLIENT, 'the registries must be declared client-visible')
			.toContain('KinkyDungeonRestraintVariants');

		const name = h.eval(`(function(){
			var template = null;
			KinkyDungeonRestraintsCache.forEach(function(v, k){ if (!template && v && !v.armor) template = k; });
			KDGetInventoryVariant({template: template, power: 1, events: []}, "", undefined, "KDM245Wire");
			return template + "KDM245Wire";
		})()`);

		const snap = h.serializeRenderState();
		expect(snap.worldGlobals, 'the snapshot must carry the world-globals channel').toBeTruthy();
		expect(Object.keys(snap.worldGlobals.KinkyDungeonRestraintVariants || {}),
			'the variant must be on the wire').toContain(name);
		// …and NOT in the per-player bundle, which is what made the channel necessary.
		expect(Object.keys(h.capturePlayer().globals || {}))
			.not.toContain('KinkyDungeonRestraintVariants');

		// Round-trip: wipe the receiver's copy, apply the snapshot, and it comes back. Wiping first is
		// what stops this passing on a receiver that simply never lost the value.
		h.eval('KinkyDungeonRestraintVariants = {};');
		expect(h.eval(`(KinkyDungeonRestraintVariants[${JSON.stringify(name)}] !== undefined)`),
			'the wipe must actually have taken').toBe(false);
		h.applyRenderState(snap);
		expect(h.eval(`(KinkyDungeonRestraintVariants[${JSON.stringify(name)}] !== undefined)`),
			'applying a snapshot installs the world registries').toBe(true);
	}, BOOT_TIMEOUT);

	it('an ENCHANTED item keeps its magic bonuses through drop and pick-up', () => {
		// The question this answers: does a dropped item lose its enchantments? The ground record is
		// `{x, y, name, amount}` and nothing else, which reads like "yes" — but in KD an enchanted item
		// IS a variant, its bonuses live in the registry keyed by that very name, and the pick-up path
		// rebuilds the item from the registry rather than from the ground record:
		//   KinkyDungeonItem.ts:218 — if (KinkyDungeonRestraintVariants[Item.name])
		//                               KDGiveInventoryVariant(variant, …, variant.curse, "", Item.name, …)
		// So the bonuses survive exactly as far as the registry does — which is the whole point of
		// KDM-245 making it world state. Before that change this case could not have passed.
		const POWER = 7;
		const EVENT = 'KDM245Enchant';

		// B is a player captured BEFORE the item exists — capturing after the give would hand B a copy
		// and the pick-up would prove nothing. The guard below is what caught that on the first run.
		const bundleB = h.capturePlayer();

		const made = h.eval(`(function(){
			var template = null;
			KinkyDungeonRestraintsCache.forEach(function(v, k){ if (!template && v && !v.armor) template = k; });
			KDGiveInventoryVariant({
				template: template, power: ${POWER},
				events: [{trigger: "tick", type: ${JSON.stringify(EVENT)}}],
			}, "", undefined, "KDM245Ench");
			var name = template + "KDM245Ench";
			var held = KinkyDungeonInventoryGet(name);
			return {
				name: name,
				power: KinkyDungeonRestraintVariants[name].power,
				events: (held && held.events || []).filter(function(e){ return e.type === ${JSON.stringify(EVENT)}; }).length,
			};
		})()`);
		// The dropper really is holding an enchanted item — otherwise the round trip proves nothing.
		expect(made.power, 'A holds a +7 variant').toBe(POWER);
		expect(made.events, 'A holds the enchant event').toBe(1);


		h.applyInput('drop', { item: made.name });
		const ground = h.eval(`(function(){
			var g = KDMapData.GroundItems.filter(function(i){ return i.name === ${JSON.stringify(made.name)}; })[0];
			return g ? { x: g.x, y: g.y, keys: Object.keys(g).sort().join(",") } : null;
		})()`);
		expect(ground, 'the enchanted item is on the ground').not.toBeNull();
		// The ground record really does carry NOTHING but the name — this is what makes the claim
		// interesting rather than trivial.
		expect(ground.keys).toBe('amount,name,playerDropped,x,y');

		// Swap B in and let KD's OWN pick-up path run over that tile.
		h.restorePlayer(bundleB);
		expect(h.eval(`(!!KinkyDungeonInventoryGet(${JSON.stringify(made.name)}))`),
			'B must NOT already hold it, or the pick-up proves nothing').toBe(false);
		h.eval(`KinkyDungeonItemCheck(${ground.x}, ${ground.y}, MiniGameKinkyDungeonLevel)`);

		const got = h.eval(`(function(){
			var it = KinkyDungeonInventoryGet(${JSON.stringify(made.name)});
			var v = KinkyDungeonRestraintVariants[${JSON.stringify(made.name)}];
			return {
				// KinkyDungeonInventoryGet returns NULL, not undefined, when absent, so a "not undefined"
				// test is always true and makes any "does not hold it" guard unfalsifiable. Truthiness, always.
				// (No backticks in this comment - it lives inside a template literal. KDM-184 again.)
				held: !!it,
				power: v ? v.power : null,
				events: (it && it.events || []).filter(function(e){ return e.type === ${JSON.stringify(EVENT)}; }).length,
				stillOnGround: KDMapData.GroundItems.some(function(i){ return i.name === ${JSON.stringify(made.name)}; }),
			};
		})()`);

		expect(got.held, 'B picked the item up').toBe(true);
		expect(got.stillOnGround, 'and it left the ground — one copy, not two').toBe(false);
		expect(got.power, 'the magic bonus survived the transfer').toBe(POWER);
		expect(got.events, 'and so did the enchant event').toBe(1);
	}, BOOT_TIMEOUT);
});
