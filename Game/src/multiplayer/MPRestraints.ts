/* =========================================================================
 * MP per-player worn restraints — storage + accessor.
 *
 * The player's worn restraints are a singular global (`KinkyDungeonInventory`,
 * read by ~135 sites across 32 files via KinkyDungeonAllRestraint /
 * KDAllRestraintDynamicList). A second player needs its own worn set. Rewriting
 * every read is infeasible and risky, so — exactly like the player slot and stats
 * modules — this establishes only per-player *storage + a read accessor*, WITHOUT
 * touching the globals, the add/remove functions, or the 135 reads. Single-player
 * is byte-identical by construction.
 *
 * STORAGE SHAPE: P2's worn restraints live as a plain ARRAY on the P2 entity
 * (`KDPlayers[slot].restraintList: item[]`), NOT a Map. A Map field would serialize
 * to `{}` (JSON drops Maps — the global inventory only round-trips because the save
 * path explicitly converts it). A plain array rides the Entities + `modified:true`
 * serialization verbatim, so P2's worn set round-trips through save/load + state_sync
 * for free. Slot 0's worn set remains the global KinkyDungeonInventory (read via
 * KinkyDungeonAllRestraint).
 * ========================================================================= */

/**
 * The worn restraints of player `slot` as a list — the per-slot analogue of
 * KinkyDungeonAllRestraint. Local/singular slot → the global worn set (unchanged
 * single-player path). A co-op slot → that avatar's own `restraintList` array
 * (lazily created). Empty list if the slot has no entity (defensive).
 */
function KDGetWornRestraintsFor(slot: number): item[] {
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	if (isLocal) {
		return (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint() : [];
	}
	const ent: any = (typeof KDPlayerById === 'function') ? KDPlayerById(slot) : undefined;
	if (!ent) return [];
	if (!Array.isArray(ent.restraintList)) ent.restraintList = [];
	return ent.restraintList;
}

/**
 * Does player `slot` have a worn restraint of group `group`? Per-slot analogue of
 * the singular group query (used by the consumer slices for ownership checks).
 */
function KDSlotHasRestraintGroup(slot: number, group: string): boolean {
	const list = KDGetWornRestraintsFor(slot);
	for (const it of list) {
		const def = (typeof KDRestraint === 'function') ? KDRestraint(it) : undefined;
		if (def && def.Group === group) return true;
	}
	return false;
}

/**
 * Seed an empty worn-restraint store on a freshly spawned co-op avatar
 * (KDSpawnPlayer2). No-op for the local/singular player, whose store is the global.
 */
function KDInitPlayerRestraints(ent: any): void {
	if (!ent) return;
	if (!Array.isArray(ent.restraintList)) ent.restraintList = [];
}
