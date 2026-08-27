/**
 * tools/mp-server/kd-variant-registry.js  (KDM-245, swept by KDM-284)
 *
 * THE ITEM VARIANT REGISTRIES ARE SHARED, SO NOBODY MAY GARBAGE-COLLECT THEM ALONE.
 *
 * THE PROBLEM. KDM-245 made `KinkyDungeonRestraintVariants` / `…WeaponVariants` /
 * `…ConsumableVariants` world state (GLOBAL_BLACKLIST, headless-host.js), because a dropped item
 * records only a NAME and those tables are what turn that name back into an item. But KD prunes them:
 * `KDPruneInventoryVariants` (`KinkyDungeonInventory.ts:3261`) walks the live player's worn / loose /
 * lost / hotbar inventory plus the world's own containers, and DELETES every variant it did not find.
 * It runs on every descent — `KDGoThruTile` calls it as its first statement (`KDStairActions.ts:32`).
 *
 * In the swap-session model exactly one player is swapped in at a time, so "the live player's
 * inventory" is one player's. A descent by A would therefore delete every variant that only B is
 * carrying, and B's enchanted gear would resolve to `undefined` on the next floor. The prune is
 * correct single-player and unsound the moment the table is shared.
 *
 * ── KDM-245's ANSWER, AND WHY IT WAS DEBT ───────────────────────────────────────────────────────
 * KDM-245 suppressed the prune outright in a managed session: bounded (one small record per item ever
 * enchanted), counted, never silent — but the registry then only ever grew, for the length of a run.
 *
 * ── KDM-284's ANSWER: THE DEFERRED SWEEP ────────────────────────────────────────────────────────
 * The wrap CANNOT decide this by itself, and that constraint is what dictates the shape:
 *
 *   · the other seats' state lives in `SwapSession.bundles`, in NODE, and the prune fires inside the
 *     engine as the first statement of a descent — Node is not in the loop at that instant; and
 *   · KD offers no "what WOULD you delete?" query. `KDPruneInventoryVariants` takes eight booleans and
 *     nothing else, building its `found` set from live globals. Handing it a keep-set — which is what
 *     KDM-284 was originally written to do — would mean editing the game tree.
 *
 * So the work is split at the only seam that exists. THE WRAP runs the STOCK prune against a snapshot,
 * records every name it deleted into `__kdCoopVariantPending`, and puts them all back. NODE drains that
 * record after the turn — when it is in the loop and every seat's state is fresh by definition — and
 * deletes only the names no other seat still references (`decideVariantSweep`, below).
 *
 * THE PROPERTY THAT MAKES THIS SAFE. We never re-implement KD's reachability. `_prev` still computes
 * `found`; we only ever WITHHOLD deletions it proposed. So the wrap can decline to delete, and can do
 * nothing else — under-keeping, the one failure mode that destroys a player's enchanted gear, is
 * structurally unreachable. Every ambiguous case costs bounded memory instead.
 *
 * AND THE DEGRADED PATH IS THE OLD BEHAVIOUR. If Node never drains (contract absent, sweep not wired,
 * a path that reaches a descent without one), the pending list simply grows and nothing is deleted —
 * exactly KDM-245, counted, never a new regression.
 *
 * WHY THIS IS NOT A GAME MECHANIC IN THE GATEWAY (KDM-159). Nothing here decides what an item is or
 * does. The wrap answers one question — "is this world managed by a session with more than one
 * player's state in flight?" — which is a question that only exists because there are two players.
 *
 * The wrap follows `WRAP_CONVENTION.md`: sentinel-gated so a re-eval cannot double-wrap, `_prev`
 * captured in closure, `_kdvariant_original` published for diagnosis. Bare re-assignment, never
 * `globalThis.` — `KDPruneInventoryVariants` is a bundle binding.
 *
 * SERVER-SIDE ONLY. The prune runs in the authoritative world and only there; there is deliberately
 * no browser copy to keep in step.
 */
'use strict';

/**
 * The three registries, in the key order the pending record and the sweep both use. One list, so the
 * wrap, the drain and the decision can never disagree about which tables exist — a fix that handled
 * only restraints would leak the other two in silence, because nothing the player sees would change.
 */
const VARIANT_KINDS = Object.freeze(['restraint', 'weapon', 'consumable']);

/** An empty pending record. Shared shape, never a shared object — callers mutate what they get. */
function emptyPending() {
	return { restraint: [], weapon: [], consumable: [] };
}

/**
 * KDM-284 — decide which withheld names may finally go.
 *
 * PURE, and in Node on purpose: it is a function of (what stock KD proposed to delete, what each
 * swapped-out seat is holding), and neither half is knowable from inside the engine.
 *
 * ── WHY A JSON-TOKEN TEST AND NOT A WALK OF THE SEAT'S INVENTORY ────────────────────────────────
 * The obvious alternative is to re-derive, over a seat's stored state, what the prune derives over
 * live globals: worn (`KinkyDungeonAllRestraintDynamic`), loose / weapon / consumable, hotbar
 * (`KinkyDungeon{Weapon,Armor,Consumable}Choices`), lost (`KinkyDungeonLostItems`), plus the
 * `KDGameData` sub-trees `NPCRestraints` and `Containers`. That is eight KD-internal shapes
 * re-implemented in the gateway, every one of which upstream is free to move — and it fails SILENTLY
 * AND IN THE DANGEROUS DIRECTION, because a shape we forgot to walk is a live variant deleted.
 *
 * A variant name reaches a seat's state in exactly two forms, and both serialise identically:
 *
 *   {"EnchantedRope42": {…}}     an object KEY   — how `KinkyDungeonInventory` holds it
 *   {"name": "EnchantedRope42"}  a string VALUE  — how ground items / NPCRestraints hold it
 *
 * So the test is "does `"<name>"` occur in this seat's JSON", which knows nothing about KD's shapes
 * and cannot be broken by upstream moving them. Its only failure mode is a FALSE POSITIVE — some
 * unrelated string that happens to equal the name — which over-keeps, degrading toward KDM-245's
 * behaviour rather than toward loss.
 *
 * The quoting is not decoration. Variant names are `prefix + template + ID + curse`
 * (`KinkyDungeonInventory.ts:3634`), so `Rope1` is a genuine prefix of `Rope12`: a bare
 * `includes(name)` would keep `Rope1` alive forever on the strength of an unrelated `Rope12`, and that
 * leak never surfaces as a bug — only as the unbounded growth this task exists to stop. `JSON.stringify`
 * rather than `'"' + name + '"'` so a name needing escapes is matched as it was actually serialised.
 *
 * @param {{restraint:string[], weapon:string[], consumable:string[]}} pending  drained from the world
 * @param {string[]} seatJson  each swapped-out seat's state, JSON — `JSON.stringify(capturePlayer())`
 * @returns {{keep: object, sweep: object}} both in the `pending` shape
 */
function decideVariantSweep(pending, seatJson) {
	const p = pending || {};
	const keep = emptyPending();
	const sweep = emptyPending();
	const seats = Array.isArray(seatJson) ? seatJson.filter((s) => typeof s === 'string' && s) : [];

	// R6 — "we could not ask the other seats" and "the other seats hold nothing" must NOT be the same
	// answer. With no seat state there is no evidence, and deleting a partner's gear on the strength of
	// missing information is the one outcome this whole design exists to prevent. Keep everything.
	const haveEvidence = seats.length > 0;

	for (const kind of VARIANT_KINDS) {
		const names = Array.isArray(p[kind]) ? p[kind] : [];
		for (const name of names) {
			if (typeof name !== 'string' || !name) continue;
			const token = JSON.stringify(name);
			const referenced = !haveEvidence || seats.some((s) => s.indexOf(token) >= 0);
			(referenced ? keep : sweep)[kind].push(name);
		}
	}
	return { keep, sweep };
}

/**
 * One global forms the IN contract with `SwapSession`; the rest are OUT, for Node and for diagnosis.
 *
 *   `__kdCoopManaged`              IN  — written by the session at setup. `true` means "this world
 *                                        holds more than one player's state". Absent is the
 *                                        single-player answer, so an unmanaged world prunes exactly as
 *                                        stock KD does.
 *   `__kdCoopVariantPending`       OUT — names stock KD deleted and the wrap put back, awaiting Node's
 *                                        verdict. Drained destructively by `takeVariantPending()`.
 *   `__kdCoopVariantPrunesSkipped` OUT — how many managed prunes were withheld. Never silent: a
 *                                        registry that refuses to shrink must be diagnosable.
 */
const KD_VARIANT_REGISTRY = `
(function(){
	if (typeof KDPruneInventoryVariants !== 'function') return;
	if (KDPruneInventoryVariants._kdvariant_wrapped) return;   // idempotent: loaded once, wrapped once
	var _prev = KDPruneInventoryVariants;
	var KINDS = ${JSON.stringify(VARIANT_KINDS)};

	/**
	 * The live tables, re-read on every call. NOT captured once: these are compiled bindings, and a
	 * reference cached at wrap time would survive a reassignment we cannot see.
	 */
	function tables() {
		return {
			restraint:  (typeof KinkyDungeonRestraintVariants  !== 'undefined') ? KinkyDungeonRestraintVariants  : null,
			weapon:     (typeof KinkyDungeonWeaponVariants     !== 'undefined') ? KinkyDungeonWeaponVariants     : null,
			consumable: (typeof KinkyDungeonConsumableVariants !== 'undefined') ? KinkyDungeonConsumableVariants : null,
		};
	}

	var wrapped = function () {
		if (globalThis.__kdCoopManaged !== true) return _prev.apply(this, arguments);

		// KD deletes IN PLACE (KDRemoveInventoryVariant et al, KinkyDungeonInventory.ts:3236-3250 are
		// each a bare \`delete\`), so a shallow key copy is a sound "before" and the object identities
		// in it are the REAL definitions — which is what lets the restore below put back the very
		// object anything holding a reference is already pointing at, rather than an equal clone.
		var t = tables();
		var before = {};
		for (var i = 0; i < KINDS.length; i++) {
			var k = KINDS[i];
			if (!t[k]) continue;
			var snap = {};
			for (var n in t[k]) snap[n] = t[k][n];
			before[k] = snap;
		}

		// Stock KD decides. We are only ever the thing that declines to carry the decision out.
		var ret = _prev.apply(this, arguments);

		var pending = globalThis.__kdCoopVariantPending;
		if (!pending) pending = { restraint: [], weapon: [], consumable: [] };
		for (var j = 0; j < KINDS.length; j++) {
			var kind = KINDS[j];
			var live = t[kind], was = before[kind];
			if (!live || !was) continue;
			if (!pending[kind]) pending[kind] = [];
			for (var name in was) {
				if (live[name] !== undefined) continue;         // survived the prune: nothing to do
				live[name] = was[name];                          // put the ORIGINAL definition back
				if (pending[kind].indexOf(name) < 0) pending[kind].push(name);
			}
		}
		globalThis.__kdCoopVariantPending = pending;

		// Never silent: a withheld sweep is a DECISION, and a diagnosis that cannot see it would blame
		// the registry for growing.
		globalThis.__kdCoopVariantPrunesSkipped = (globalThis.__kdCoopVariantPrunesSkipped || 0) + 1;
		return ret;
	};
	wrapped._kdvariant_wrapped = true;
	KDPruneInventoryVariants = wrapped;
	KDPruneInventoryVariants._kdvariant_original = _prev;
})();
`;

module.exports = { KD_VARIANT_REGISTRY, decideVariantSweep, VARIANT_KINDS, emptyPending };
