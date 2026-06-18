/* =========================================================================
 * Player-scoped ownership.
 *
 * The engine globals `KinkyDungeonInventory`, restraint state, and perks
 * are de facto "the local player's" stores. For multiplayer we need to
 * address either player's stores by id; for single-player we must not
 * change any existing call site.
 *
 * Strategy:
 *   - Slot KDLocalPlayerId (default 0) is backed by the existing engine
 *     globals. Accessors for that slot return those globals directly, so
 *     single-player code paths are untouched.
 *   - Slot != KDLocalPlayerId is a per-id container created on demand.
 *     The multiplayer flow is wired through these accessors so a connected
 *     partner's actions affect *their* stores.
 *   - `KDPlayerFactionRelation` is the single flag that flips co-op behaviour
 *     into PvP behaviour. Default is 'ally' (co-op); flipping it to 'hostile'
 *     enables PvP without hardcoding mutual allyship.
 *
 * This file deliberately defines accessors only; nothing else in the engine
 * needs to change until multiplayer-aware code paths are wired through them.
 * ========================================================================= */

type MPFactionRelation = 'ally' | 'hostile';

/**
 * Per-slot inventory storage for non-local players. The local player's slot
 * is backed by the engine global `KinkyDungeonInventory` (see
 * `KDGetInventoryFor`).
 */
let KDRemoteInventories: Map<number, Map<string, Map<string, item>>> = new Map();

/**
 * Relationship between connected players. 'ally' is co-op.
 * Flipping this to 'hostile' enables PvP.
 */
let KDPlayerFactionRelation: MPFactionRelation = 'ally';

/**
 * Returns the inventory map for `playerId`. For the local player this is
 * the engine global `KinkyDungeonInventory`. For any other slot, a
 * per-slot map is created on first access.
 */
function KDGetInventoryFor(playerId: number): Map<string, Map<string, item>> {
	if (playerId === KDLocalPlayerId) return KinkyDungeonInventory;
	let inv = KDRemoteInventories.get(playerId);
	if (!inv) {
		inv = new Map();
		KDRemoteInventories.set(playerId, inv);
	}
	return inv;
}

/**
 * Discards the inventory for a non-local `playerId`. Used by the multiplayer
 * session teardown flow.
 */
function KDUnregisterInventory(playerId: number): void {
	if (playerId === KDLocalPlayerId) return;  // never wipe the local engine inventory
	KDRemoteInventories.delete(playerId);
}

/**
 * True iff `playerId` is the slot the local user occupies. The cheap way for
 * existing code to ask "does the local user own this?" without thinking in
 * terms of slots.
 */
function KDIsPlayerOwnedByLocal(playerId: number): boolean {
	return playerId === KDLocalPlayerId;
}

/**
 * True iff players `a` and `b` should treat each other as enemies. In co-op
 * (the default) this is always false. PvP flips `KDPlayerFactionRelation`
 * and this becomes true for distinct slots.
 */
function KDIsPlayerHostile(a: number, b: number): boolean {
	if (a === b) return false;
	return KDPlayerFactionRelation === 'hostile';
}
