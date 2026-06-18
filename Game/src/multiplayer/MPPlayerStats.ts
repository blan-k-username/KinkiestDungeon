/* =========================================================================
 * Per-player core stats.
 *
 * The engine's survival stats are global singletons (KinkyDungeonStatStamina,
 * …Mana, …Will, …Distraction, + Max companions) with ~662 references. A second
 * co-op player needs its own stat block. This module adds per-player STORAGE +
 * a read/write accessor WITHOUT touching the globals, the change functions, the
 * per-tick update, or the 662 reads — so single-player is byte-identical.
 *
 *   - Slot 0 (the engine's singular player on every client) reads/writes the
 *     globals directly via a name→global switch.
 *   - Any other slot reads/writes fields on that player's entity (KDPlayers[slot]).
 *     P2 is a KDMapData.Entities member with `modified:true`, so its stat fields
 *     serialize + round-trip via save/load and state_sync for free — no new save
 *     path.
 *
 * Routing the engine's stat operations through a chosen slot (so P2 actually
 * regens, takes damage, renders a bar) is handled by the combat consumer slices.
 * ========================================================================= */

/** The per-player stat fields this accessor supports (current + Max companions),
 *  including the per-player status stats the full damage model needs:
 *  blind/freeze/bind + MovePoints (the move/stun-lock budget on KDGameData). */
const KDStatNames: string[] = [
	'stamina', 'staminaMax',
	'mana', 'manaMax',
	'manapool', 'manapoolMax',
	'will', 'willMax',
	'distraction', 'distractionMax', 'distractionlower',
	// status stats (global singletons today; per-player here).
	'blind', 'freeze', 'bind', 'movePoints',
];

/** Read a slot-0 (singular-player) stat from its global. */
function KDGetGlobalStat(name: string): number | undefined {
	switch (name) {
		case 'stamina': return KinkyDungeonStatStamina;
		case 'staminaMax': return KinkyDungeonStatStaminaMax;
		case 'mana': return KinkyDungeonStatMana;
		case 'manaMax': return KinkyDungeonStatManaMax;
		case 'manapool': return KinkyDungeonStatManaPool;
		case 'manapoolMax': return KinkyDungeonStatManaPoolMax;
		case 'will': return KinkyDungeonStatWill;
		case 'willMax': return KinkyDungeonStatWillMax;
		case 'distraction': return KinkyDungeonStatDistraction;
		case 'distractionMax': return KinkyDungeonStatDistractionMax;
		case 'distractionlower': return KinkyDungeonStatDistractionLower;
		// status stats:
		case 'blind': return KinkyDungeonStatBlind;
		case 'freeze': return KinkyDungeonStatFreeze;
		case 'bind': return KinkyDungeonStatBind;
		case 'movePoints': return (typeof KDGameData !== 'undefined' && KDGameData) ? KDGameData.MovePoints : 0;
	}
	return undefined;
}

/** Write a slot-0 (singular-player) stat to its global. */
function KDSetGlobalStat(name: string, value: number): void {
	switch (name) {
		case 'stamina': KinkyDungeonStatStamina = value; return;
		case 'staminaMax': KinkyDungeonStatStaminaMax = value; return;
		case 'mana': KinkyDungeonStatMana = value; return;
		case 'manaMax': KinkyDungeonStatManaMax = value; return;
		case 'manapool': KinkyDungeonStatManaPool = value; return;
		case 'manapoolMax': KinkyDungeonStatManaPoolMax = value; return;
		case 'will': KinkyDungeonStatWill = value; return;
		case 'willMax': KinkyDungeonStatWillMax = value; return;
		case 'distraction': KinkyDungeonStatDistraction = value; return;
		case 'distractionMax': KinkyDungeonStatDistractionMax = value; return;
		case 'distractionlower': KinkyDungeonStatDistractionLower = value; return;
		// status stats:
		case 'blind': KinkyDungeonStatBlind = value; return;
		case 'freeze': KinkyDungeonStatFreeze = value; return;
		case 'bind': KinkyDungeonStatBind = value; return;
		case 'movePoints': if (typeof KDGameData !== 'undefined' && KDGameData) KDGameData.MovePoints = value; return;
	}
}

/**
 * The entity-field name a co-op slot stores a stat under. The status stats
 * (blind/freeze/bind/movePoints) collide with real *enemy* entity fields
 * (`enemy.movePoints`, `enemy.blind`, … which the load/AI reset), so they store
 * under a `kd`-prefixed field. Core stats (stamina/will/…) have no such collision
 * and keep their bare name.
 */
function KDPlayerStatField(name: string): string {
	switch (name) {
		case 'blind': return 'kdBlind';
		case 'freeze': return 'kdFreeze';
		case 'bind': return 'kdBind';
		case 'movePoints': return 'kdMovePoints';
	}
	return name;
}

/**
 * Read a player's stat. `slot === 0` (the local/singular player on every client)
 * reads the live global; any other slot reads the field on that player's entity.
 * Returns `undefined` when the slot/field is absent.
 */
function KDGetPlayerStat(slot: number, name: string): number | undefined {
	if (slot === 0) return KDGetGlobalStat(name);
	const e = (typeof KDPlayerById === 'function') ? KDPlayerById(slot) : undefined;
	return e ? (e as any)[KDPlayerStatField(name)] : undefined;
}

/**
 * Write a player's stat. `slot === 0` writes the live global; any other slot
 * writes the field on that player's entity (no-op if the slot is empty).
 */
function KDSetPlayerStat(slot: number, name: string, value: number): void {
	if (slot === 0) { KDSetGlobalStat(name, value); return; }
	const e = (typeof KDPlayerById === 'function') ? KDPlayerById(slot) : undefined;
	if (e) (e as any)[KDPlayerStatField(name)] = value;
}

/**
 * Seed an entity's per-player stat fields from the start defaults (used when the
 * host spawns P2). Current = max for stamina/mana/will; distraction starts at 0.
 */
function KDInitPlayerStats(ent: entity): void {
	if (!ent) return;
	const e = ent as any;
	const base = (typeof KDMaxStatStart === 'number') ? KDMaxStatStart : 10;
	const pool = (typeof KDMaxStatStartPool === 'number') ? KDMaxStatStartPool : 40;
	e.staminaMax = base; e.stamina = base;
	e.manaMax = base; e.mana = base;
	e.manapoolMax = pool; e.manapool = pool;
	e.willMax = base; e.will = base;
	e.distractionMax = base; e.distraction = 0;
	e.distractionlower = 0;
	// status stats start clear (kd-prefixed fields, see KDPlayerStatField).
	e.kdBlind = 0; e.kdFreeze = 0; e.kdBind = 0; e.kdMovePoints = 0;
}
