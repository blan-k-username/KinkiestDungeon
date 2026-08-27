/**
 * tools/mp-server/kd-variant-registry.js  (KDM-245)
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
 * THE RULE: in a managed session the prune does not run. It is a garbage collector, not a mechanic —
 * skipping it costs a bounded amount of memory for the length of a run (one small record per item
 * ever enchanted) and changes no outcome the player can observe. Restoring it properly means unioning
 * every seat's inventory before the sweep, which is a real feature and is NOT what this task bought.
 *
 * WHY THIS IS NOT A GAME MECHANIC IN THE GATEWAY (KDM-159). Nothing here decides what an item is or
 * does. The wrap answers one question — "is this world managed by a session with more than one
 * player's state in flight?" — which is a question that only exists because there are two players.
 *
 * The wrap follows `WRAP_CONVENTION.md`: sentinel-gated so a re-eval cannot double-wrap, `_prev`
 * captured in the closure, `_kdvariant_original` published for diagnosis. Bare re-assignment, never
 * `globalThis.` — `KDPruneInventoryVariants` is a bundle binding.
 *
 * SERVER-SIDE ONLY. The prune runs in the authoritative world and only there; there is deliberately
 * no browser copy to keep in step.
 */
'use strict';

/**
 * One global forms the contract with `SwapSession`:
 *
 *   `__kdCoopManaged`   IN — written by the session at setup. `true` means "this world holds more
 *                            than one player's state". Absent is the single-player answer, so an
 *                            unmanaged world prunes exactly as stock KD does.
 */
const KD_VARIANT_REGISTRY = `
(function(){
	if (typeof KDPruneInventoryVariants !== 'function') return;
	if (KDPruneInventoryVariants._kdvariant_wrapped) return;   // idempotent: loaded once, wrapped once
	var _prev = KDPruneInventoryVariants;

	var wrapped = function () {
		// Never silent: a skipped sweep is a DECISION, and a diagnosis that cannot see it would
		// blame the registry for growing.
		if (globalThis.__kdCoopManaged === true) {
			globalThis.__kdCoopVariantPrunesSkipped = (globalThis.__kdCoopVariantPrunesSkipped || 0) + 1;
			return;
		}
		return _prev.apply(this, arguments);
	};
	wrapped._kdvariant_wrapped = true;
	KDPruneInventoryVariants = wrapped;
	KDPruneInventoryVariants._kdvariant_original = _prev;
})();
`;

module.exports = { KD_VARIANT_REGISTRY };
