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

/** Per-method escape-progress field on a worn item (mirrors the engine's fields). */
function KDStruggleProgressKey(type: string): string {
	switch (type) {
		case 'Cut': return 'cutProgress';
		case 'Pick': return 'pickProgress';
		case 'Unlock': return 'unlockProgress';
		default: return 'struggleProgress';   // Struggle / Remove
	}
}

/**
 * Let player `slot` attempt to escape the restraint worn on `group` — the per-slot
 * analogue of KinkyDungeonStruggle, operating on that avatar's OWN restraints + stats.
 *
 * - Local/singular slot → defer to the unchanged engine `KinkyDungeonStruggle`
 *   (single-player byte-identical; also the only path that handles linked/index>0 items).
 * - Co-op slot → a faithful-but-minimal escape loop on P2's own state:
 *     stamina-gate → roll the restraint's `escapeChance[type]` → accumulate the matching
 *     progress field on the item → remove it from the slot's `restraintList` on success.
 *   Progress lives on the worn item, so it rides Entities serialization (save/load +
 *   state_sync); guest sends the input, host applies it (like movement).
 *
 * Deliberately a per-slot apply primitive, NOT a slot threaded through the ~570-line
 * KinkyDungeonStruggle (global stats / PlayerEntity / delayed actions / perks). Returns
 * the engine's result vocabulary: "Success" | "Fail".
 */
function KDStrugglePlayerSlot(slot: number, group: string, type: string, index?: number): string {
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	if (isLocal) {
		return (typeof KinkyDungeonStruggle === 'function')
			? KinkyDungeonStruggle(group, type, index || 0)
			: 'Fail';
	}
	if (typeof KDGetPlayerStat !== 'function' || typeof KDSetPlayerStat !== 'function') return 'Fail';
	const worn = KDGetWornRestraintsFor(slot);
	if (!Array.isArray(worn)) return 'Fail';
	// Top-level worn item for the group (P2's restraints are one-per-group, no dynamicLink).
	const idx = worn.findIndex((it: any) => {
		const def = (typeof KDRestraint === 'function') ? KDRestraint(it) : undefined;
		return def && def.Group === group;
	});
	if (idx < 0) return 'Fail';
	const item: any = worn[idx];
	const def: any = (typeof KDRestraint === 'function') ? KDRestraint(item) : undefined;

	// Stamina gate — an exhausted player can't act (mirrors KinkyDungeonHasStamina).
	const cost = 1;
	if (((KDGetPlayerStat(slot, 'stamina') as number) || 0) < cost) return 'Fail';

	const chance = (def && def.escapeChance && typeof def.escapeChance[type] === 'number')
		? def.escapeChance[type] : (type === 'Struggle' ? 0.1 : 0);

	// Spend stamina on every genuine attempt.
	KDSetPlayerStat(slot, 'stamina', Math.max(0, ((KDGetPlayerStat(slot, 'stamina') as number) || 0) - cost));

	// Negative/zero chance → this method can't make headway (e.g. needs Cut/Remove/keys).
	if (chance <= 0) return 'Fail';

	const key = KDStruggleProgressKey(type);
	const minSpeed = 0.05;
	item[key] = ((typeof item[key] === 'number') ? item[key] : 0) + Math.max(minSpeed, chance);
	if (item[key] >= 1) {
		worn.splice(idx, 1);   // escaped — remove from the slot's own worn set
		return 'Success';
	}
	return 'Fail';   // progress made, still bound
}
