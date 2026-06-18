/* =========================================================================
 * MP per-player BC Character — binds a BC Character to co-op slot P2.
 *
 * P2 renders as a *regular player* — body + dress + restraint layers via the
 * same player pipeline. The player's visual is a BC `Character`
 * (`KinkyDungeonPlayer`), separate from the map entity. This gives P2 its own
 * `Character` so it can be dressed and drawn with the existing generic functions
 * (`KinkyDungeonDressPlayer(C, …, customInventory)`, `KDDrawChibi(C, x, y, zoom)`).
 *
 * WHY A PARALLEL MAP, NOT `ent.Character`:
 *   A BC `Character` has circular references / non-serializable bits. P2's entity
 *   is JSON-serialized into the save (it lives in `KDMapData.Entities`), so hanging
 *   the Character off the entity would break the save round-trip + state_sync.
 *   The Character is a *render-time* object kept in `KDPlayerCharacters` (keyed by
 *   slot) and rebuilt on demand; only the extracted appearance fields get persisted
 *   into the entity. This mirrors BC's own `KDCurrentModels` side map.
 * ========================================================================= */

/** Render-time BC Character per co-op slot (1 = P2). Kept OUT of the entity so the
 *  save (which serializes the entity) never tries to JSON a circular Character. */
let KDPlayerCharacters: Map<number, Character> = new Map();

/** Stable BC Character id for a co-op slot — high to avoid colliding with the
 *  singular player (id 0) and dialogue NPC characters. */
function KDPlayerCharacterId(slot: number): number {
	return 9000 + slot;
}

/**
 * The render Character for player `slot`. Local/singular slot → the global
 * `KinkyDungeonPlayer` (unchanged). A co-op slot → its entry in the side map, or
 * `undefined` if not yet built (call KDEnsurePlayerCharacter first).
 */
function KDGetPlayerCharacter(slot: number): Character | undefined {
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	if (isLocal) return (typeof KinkyDungeonPlayer !== 'undefined') ? KinkyDungeonPlayer : undefined;
	return KDPlayerCharacters.get(slot);
}

/**
 * Idempotently ensure a co-op slot has a render Character. Builds one via BC's
 * `CharacterLoadNPC` on first call and caches it. No-op (returns the global) for
 * the local/singular slot. Returns the Character, or undefined if BC isn't loaded.
 */
function KDEnsurePlayerCharacter(slot: number, name?: string): Character | undefined {
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	if (isLocal) return (typeof KinkyDungeonPlayer !== 'undefined') ? KinkyDungeonPlayer : undefined;
	let c = KDPlayerCharacters.get(slot);
	if (c) return c;
	if (typeof CharacterLoadNPC !== 'function') return undefined;
	c = CharacterLoadNPC(KDPlayerCharacterId(slot), name || ('P' + (slot + 1)));
	KDPlayerCharacters.set(slot, c);
	return c;
}

/** Drop a co-op slot's render Character (co-op teardown / solo-continue). */
function KDReleasePlayerCharacter(slot: number): void {
	KDPlayerCharacters.delete(slot);
}

/**
 * Stamp each co-op slot entity with its Character's appearance fields
 * (`{charAppearance, charPoses, charPalette, charMetadata}`) so they ride the
 * entity through `save.KDMapData` + state_sync. The Character itself stays
 * in the side map (never serialized — it has circular refs). Mirrors how the
 * singular player saves `{appearance, poses, Palette, metadata}`. Called from
 * KinkyDungeonGenerateSaveData before the map is serialized.
 */
function KDStampCoopAppearance(): void {
	if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.Entities)) return;
	for (const ent of KDMapData.Entities) {
		const slot = ent && (ent as any).playerSlot;
		if (slot == null) continue;
		const c: any = KDGetPlayerCharacter(slot);
		if (!c || !c.Appearance) continue;
		try {
			(ent as any).charAppearance = JSON.parse(JSON.stringify(c.Appearance));
			const model: any = (typeof KDCurrentModels !== 'undefined' && KDCurrentModels) ? KDCurrentModels.get(c) : null;
			(ent as any).charPoses = (model && model.Poses) ? JSON.parse(JSON.stringify(model.Poses)) : undefined;
			(ent as any).charPalette = c.Palette;
			(ent as any).charMetadata = c.metadata;
		} catch (_) { /* appearance not serializable — skip this slot's stamp */ }
	}
}

/**
 * Rebuild each co-op slot entity's render Character from its stamped appearance
 * after a load / state_sync. Ensures the side-map Character, restores its
 * Appearance/Poses/Palette/metadata (the singular-player restore path applied to a
 * non-player Character), and refreshes its model. Called after the post-load
 * KDSyncLocalPlayerSlot. This is how a fresh/reloaded client (and the guest, on
 * every state_sync) reconstructs P2's look from the host's bytes.
 */
function KDRestoreCoopCharacters(): void {
	if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.Entities)) return;
	if (typeof AppearanceItemParse !== 'function') return;
	for (const ent of KDMapData.Entities) {
		const slot = ent && (ent as any).playerSlot;
		if (slot == null || !(ent as any).charAppearance) continue;
		const c: any = KDEnsurePlayerCharacter(slot, 'P' + (slot + 1));
		if (!c) continue;
		try {
			c.Appearance = AppearanceItemParse(JSON.stringify((ent as any).charAppearance));
			if (typeof KDRefreshSelectedModel === 'function') KDRefreshSelectedModel(c);
			const model: any = (typeof KDCurrentModels !== 'undefined' && KDCurrentModels) ? KDCurrentModels.get(c) : null;
			if (model && (ent as any).charPoses) model.Poses = (ent as any).charPoses;
			if ((ent as any).charPalette !== undefined) c.Palette = (ent as any).charPalette;
			if ((ent as any).charMetadata !== undefined) c.metadata = (ent as any).charMetadata;
			if (typeof UpdateModels === 'function') UpdateModels(c);
		} catch (_) { /* keep whatever the Character had */ }
	}
}

/**
 * Draw all co-op player slots via the player Character pipeline.
 *
 * Mirrors the singular-player chibi draw (KinkyDungeonDraw.ts ~1787) for each
 * co-op slot entity, using that slot's own dressed Character + the entity's
 * interpolated visual position. P2's placeholder enemy sprite is suppressed in
 * KinkyDungeonDrawEnemies (the `playerSlot` skip), so this is the only thing that
 * renders P2. No-op in single-player (no playerSlot entities) ⇒ SP draw unchanged.
 *
 * The camera/transform args are passed in from the player-draw block so we reuse
 * its exact mapping. Works on both clients: the host draws slot 1 (the guest's
 * avatar) in addition to its own KinkyDungeonPlayerEntity; the guest draws slot 1
 * (its own avatar) in addition to the host's adopted KinkyDungeonPlayerEntity. */
function KDDrawCoopPlayers(
	canvasOffsetX: number, canvasOffsetY: number,
	CamX: number, CamY: number, CamXoffVis: number, CamYoffVis: number,
): void {
	if (typeof KDFindPlayerSlotEntity !== 'function' || typeof KDDrawChibi !== 'function') return;
	if (typeof KDMapData === 'undefined' || !KDMapData || !Array.isArray(KDMapData.Entities)) return;
	const grid = (typeof KinkyDungeonGridSizeDisplay === 'number') ? KinkyDungeonGridSizeDisplay : 0;
	for (const ent of KDMapData.Entities) {
		const slot = ent && (ent as any).playerSlot;
		if (slot == null) continue;
		const c = KDGetPlayerCharacter(slot);
		if (!c) continue;
		const model: any = (typeof KDCurrentModels !== 'undefined' && KDCurrentModels) ? KDCurrentModels.get(c) : null;
		const drawC: any = (model && model.Character) ? model.Character : c;
		const zoom = (typeof KDPlayerZoom === 'function') ? KDPlayerZoom(model) : 1;
		const vx = (typeof (ent as any).visual_x === 'number') ? (ent as any).visual_x : (ent as any).x;
		const vy = (typeof (ent as any).visual_y === 'number') ? (ent as any).visual_y : (ent as any).y;
		KDDrawChibi(drawC,
			canvasOffsetX + (vx - CamX - CamXoffVis) * grid + (grid / 4),
			canvasOffsetY + (vy - CamY - CamYoffVis) * grid + (grid / 6),
			zoom);
	}
}

/**
 * Compose a player slot's appearance onto its render Character. Slot-local → the
 * unchanged singular-player dress. A co-op slot → base body/dress + its OWN worn
 * restraints, never P1's.
 *
 * `KinkyDungeonDressPlayer` on a fresh `CharacterLoadNPC` yields an EMPTY
 * appearance unless a base dress is set first. For a non-player Character the
 * dresser reads its base dress from `KDCharacterDress.get(Character)`
 * (KinkyDungeonDress.ts:166). So we set that (to P2's own dress name — falling
 * back to the player's current dress so a real body composes), flag a refresh,
 * then dress with P2's own `customInventory` (`KDGetWornRestraintsFor`)
 * so P2's restraints layer onto P2 — never onto P1.
 */
function KDDressPlayerSlot(slot: number, force?: boolean): Character | undefined {
	if (typeof KinkyDungeonDressPlayer !== 'function') return undefined;
	const isLocal = (typeof KDLocalPlayerId === 'number') ? slot === KDLocalPlayerId : slot === 0;
	if (isLocal) {
		KinkyDungeonDressPlayer();                       // unchanged singular-player path
		return (typeof KinkyDungeonPlayer !== 'undefined') ? KinkyDungeonPlayer : undefined;
	}
	const c = KDEnsurePlayerCharacter(slot, 'P' + (slot + 1));
	if (!c) return undefined;
	const ent: any = (typeof KDPlayerById === 'function') ? KDPlayerById(slot) : undefined;
	// P2's base dress: its own when set, else the player's
	// current dress so a real clothed body composes for now.
	const dressName = (ent && ent.dress)
		|| (typeof KinkyDungeonCurrentDress !== 'undefined' ? KinkyDungeonCurrentDress : 'Default');
	if (typeof KDCharacterDress !== 'undefined' && KDCharacterDress) KDCharacterDress.set(c, dressName);
	if (typeof KDRefreshCharacter !== 'undefined' && KDRefreshCharacter) KDRefreshCharacter.set(c, true);
	const worn = (typeof KDGetWornRestraintsFor === 'function') ? KDGetWornRestraintsFor(slot) : [];
	// (Character, NoRestraints, Force, npcRestraints, customInventory)
	KinkyDungeonDressPlayer(c, false, force === undefined ? true : force, undefined, worn);
	return c;
}
