/* =========================================================================
 * Plural-player foundations.
 *
 * The existing `KDPlayer()` returns `KinkyDungeonPlayerEntity` — the single
 * map-side entity representing the local user. It is called from 500+ sites.
 * For multiplayer we need to address *either* player by id, but we cannot
 * refactor every call site — and we must not change single-player behaviour.
 *
 * Design:
 *   - `KDPlayers[]` is a sparse, slot-indexed array of player entities. Slot
 *     0 is always the local player; slot 1 is the remote player when a
 *     multiplayer session is active.
 *   - `KDLocalPlayerId` is the slot the local user occupies (0 by default).
 *   - `KDPlayer()` (unchanged elsewhere in the bundle) keeps returning
 *     `KinkyDungeonPlayerEntity`. Slot 0 always points at the same entity.
 *   - `KDRegisterPlayer(id, entity)` mounts/replaces a slot. Idempotent —
 *     re-registering a slot replaces, never duplicates.
 *   - `KDUnregisterPlayer(id)` clears a slot when the session ends.
 *
 * Invariants:
 *   - Single-player: `KDPlayers[0]` === `KinkyDungeonPlayerEntity`,
 *     `KDPlayers.length` may be 1 or 2 (slot 1 unused), `KDPlayer()` works
 *     identically to before multiplayer was added.
 *   - Slot 0 is owned by the engine and is kept in sync with the local
 *     `KinkyDungeonPlayerEntity` reference via `KDSyncLocalPlayerSlot()`,
 *     which the existing code can call when it swaps the local entity.
 * ========================================================================= */

type MPPlayerId = number;

/**
 * Slot-indexed array of player entities. Slot 0 is the local player; slot 1
 * (when present) is the remote player in a multiplayer session.
 */
let KDPlayers: entity[] = [];

/**
 * Which slot in `KDPlayers` is the local user. Defaults to 0 and is changed
 * only by the multiplayer connection handshake.
 */
let KDLocalPlayerId: MPPlayerId = 0;

/**
 * Returns the player entity registered at `id`, or `undefined` if no entity
 * occupies that slot. Use this anywhere ownership matters.
 *
 * `KDPlayer()` remains the singular accessor for the local player — most
 * existing code should keep using it.
 */
function KDPlayerById(id: MPPlayerId): entity | undefined {
	return KDPlayers[id];
}

/**
 * The **local** player entity — the avatar this client controls. Returns the slot
 * at `KDLocalPlayerId`, falling back to the singular global when the slot is not
 * yet populated. In single-player `KDLocalPlayerId === 0` and slot 0 is kept in
 * lockstep with `KinkyDungeonPlayerEntity` by `KDSyncLocalPlayerSlot()`, so this
 * is the same object as the global.
 *
 * Hot paths that act on "the local player" (movement, the local-avatar draw)
 * resolve through this accessor so a multiplayer guest (`KDLocalPlayerId === 1`)
 * renders/controls its own slot rather than the host's global.
 */
function KDLocalPlayer(): entity {
	return KDPlayers[KDLocalPlayerId] || KinkyDungeonPlayerEntity;
}

/**
 * Mount `entity` at slot `id`. Replaces any prior occupant (idempotent
 * w.r.t. duplication). When `id === KDLocalPlayerId` this is also how the
 * engine keeps slot 0 in lockstep with `KinkyDungeonPlayerEntity`.
 */
function KDRegisterPlayer(id: MPPlayerId, ent: entity): void {
	KDPlayers[id] = ent;
}

/**
 * Clear slot `id`. After this call, `KDPlayerById(id)` returns `undefined`.
 * Used when a multiplayer session ends or a peer leaves.
 */
function KDUnregisterPlayer(id: MPPlayerId): void {
	delete KDPlayers[id];
}

/**
 * Mirror the engine's `KinkyDungeonPlayerEntity` reference into slot 0. Call
 * this whenever the engine reassigns `KinkyDungeonPlayerEntity` (level
 * transitions, etc.). Safe to call repeatedly.
 *
 * In single-player, the local-player slot is the only one that ever
 * changes, so a single sync point keeps `KDPlayers[0]` aligned with the rest
 * of the engine without touching the 500+ `KDPlayer()` call sites.
 */
function KDSyncLocalPlayerSlot(): void {
	// Slot 0 is ALWAYS the engine's singular player global. On the host that is the
	// host's own avatar; on the guest it is the host's avatar adopted from the
	// loaded save. We sync slot 0 to the global regardless of which slot is local.
	if (typeof KinkyDungeonPlayerEntity !== 'undefined' && KinkyDungeonPlayerEntity) {
		KDPlayers[0] = KinkyDungeonPlayerEntity;
	}
	// In a session the local identity follows MPState.playerId, and the second
	// player's slot is bound from the world (P2 is a KDMapData.Entities member
	// flagged playerSlot:1 — it rides along through save/load + state_sync).
	if (typeof MPState !== 'undefined' && MPState.active) {
		KDLocalPlayerId = (typeof MPState.playerId === 'number') ? MPState.playerId : 0;
		const p2 = KDFindPlayerSlotEntity(1);
		if (p2) KDPlayers[1] = p2;
	} else {
		KDLocalPlayerId = 0;
		if (KDPlayers[1]) delete KDPlayers[1];
		// Solo-continue of a co-op save must not leave a zombie P2 on the map. With
		// no active session, drop any second-player avatar from the world.
		KDDropCoopAvatars();
	}
}

/**
 * Remove co-op player avatars (playerSlot != null) from the current map. Used when
 * a co-op save is continued single-player so P2 doesn't linger. No-op when none
 * are present, and cheap (single pass only when one exists).
 */
function KDDropCoopAvatars(): void {
	if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.Entities)) return;
	if (!KDMapData.Entities.some((e) => e && (e as any).playerSlot != null)) return;
	KDMapData.Entities = KDMapData.Entities.filter((e) => !(e && (e as any).playerSlot != null));
	// Drop P2's render Character too, so a solo-continue doesn't leak it.
	if (typeof KDReleasePlayerCharacter === 'function') KDReleasePlayerCharacter(1);
}

/** Find the entity occupying co-op player `slot` in the current map, if any. */
function KDFindPlayerSlotEntity(slot: number): entity | undefined {
	if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.Entities)) return undefined;
	for (const e of KDMapData.Entities) {
		if (e && (e as any).playerSlot === slot) return e;
	}
	return undefined;
}

/**
 * Host-side spawn of the second player avatar (slot 1) as a real map entity near
 * the host. It rides the entity pipeline (renders, serializes, syncs via state_sync)
 * but is excluded from enemy AI (see the player/playerSlot guards in
 * KinkyDungeonUpdateEnemies). The `.Enemy` is a placeholder sprite only — full
 * player appearance is applied by the character dress pipeline.
 */
function KDSpawnPlayer2(): entity | undefined {
	if (typeof KDAddEntity !== 'function' || typeof KinkyDungeonGetNearbyPoint !== 'function') return undefined;
	const host = (typeof KDPlayer === 'function' ? KDPlayer() : KinkyDungeonPlayerEntity);
	if (!host) return undefined;
	// Prefer a free adjacent tile; fall back to a tile next to the host if the
	// picker can't satisfy (post-init test maps sometimes return null).
	const pt = KinkyDungeonGetNearbyPoint(host.x, host.y, true, undefined, true) || { x: host.x + 1, y: host.y };
	// Placeholder sprite only (real player appearance is applied separately). Clone a known
	// humanoid def for its sprite but strip behaviour tags so P2 is inert — other
	// systems (leash, tether, ally-follow) react to tags, and P2 must not be pulled
	// around. P2 is also excluded from enemy AI by the playerSlot guards.
	const baseDef = (typeof KinkyDungeonGetEnemyByName === 'function') ? KinkyDungeonGetEnemyByName('Guard') : undefined;
	const def = baseDef ? Object.assign({}, baseDef, { tags: {}, leashing: undefined, master: undefined, AI: 'guard' }) : undefined;
	const ent: any = {
		id: (typeof KinkyDungeonGetEnemyID === 'function') ? KinkyDungeonGetEnemyID() : 1,
		x: pt.x, y: pt.y,
		visual_x: pt.x, visual_y: pt.y,
		hp: (def && def.maxhp) ? def.maxhp : 10,
		Enemy: def,
		player: true,
		playerSlot: 1,
		// `modified` makes the pack/unpack path keep this custom (stripped-tags, inert)
		// Enemy def verbatim across save/load + state_sync, instead of reconstructing
		// the full leashy "Guard" def from its name.
		modified: true,
	};
	// Give P2 its own per-player stat block (rides Entities serialization).
	if (typeof KDInitPlayerStats === 'function') KDInitPlayerStats(ent);
	// Give P2 its own empty worn-restraint store (rides Entities serialization).
	if (typeof KDInitPlayerRestraints === 'function') KDInitPlayerRestraints(ent);
	// Build P2's render Character in the side map (NOT on the entity, to keep the
	// circular-ref Character out of the entity's JSON save).
	if (typeof KDEnsurePlayerCharacter === 'function') KDEnsurePlayerCharacter(1, 'P2');
	// Compose P2's appearance (base body/dress + its own worn restraints) so it
	// is ready to render. Re-run when P2's restraints change.
	if (typeof KDDressPlayerSlot === 'function') KDDressPlayerSlot(1);
	KDAddEntity(ent, false, false, true);
	KDRegisterPlayer(1, ent);
	return ent;
}

/**
 * Idempotent per-turn hook (host). Keeps `KDLocalPlayerId` aligned with the session
 * and spawns the second avatar once a peer is connected and slot 1 is empty.
 */
function KDEnsureCoopPlayers(): void {
	if (typeof MPState === 'undefined' || !MPState.active) { KDLocalPlayerId = 0; return; }
	KDLocalPlayerId = (typeof MPState.playerId === 'number') ? MPState.playerId : 0;
	if (MPState.playerId === 0 && MPState.peerConnected && !KDFindPlayerSlotEntity(1)) {
		KDSpawnPlayer2();
	}
}
