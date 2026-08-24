/**
 * tools/mp-server/game-modes.js — KDM-239 A4: which of KD's game-mode toggles describe the RUN and
 * which describe a CHARACTER.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────────
 * KD's Diff screen does not store its toggles in nine globals and read them back. It funnels every
 * one of them through `KDUpdatePlugSettings` (`Game/src/base/KinkyDungeon.ts:6114-6127`) into
 * `KinkyDungeonStatsChoice` — the same Map that holds perks:
 *
 *     KinkyDungeonStatsChoice.set("arousalMode", KinkyDungeonSexyMode ? true : undefined);
 *     KinkyDungeonStatsChoice.set("randomMode",  KinkyDungeonRandomMode ? true : undefined);
 *     …
 *
 * In single-player that is fine — one player, one map, no question to answer. In co-op the same Map
 * is captured PER PLAYER, so each of these keys has to be classified: a key that describes the world
 * must be identical for both players or they are not in the same game, while a key that describes a
 * character must be that character's own. This is the KDM-228 pattern (`KDGameData.RoomType`),
 * applied to the one Map KD uses for two different jobs.
 *
 * ── ⚠️ THESE ARE NOT PERKS, AND THAT IS THE WHOLE TRAP ────────────────────────────────────────────
 * None of these keys is in `KinkyDungeonStatsPresets` (`Game/src/player/KinkyDungeonPerks.ts:256`).
 * `HeadlessHost.applyPerks` rebuilds `KinkyDungeonStatsChoice` from scratch and re-adds a key only
 * `if (KinkyDungeonStatsPresets[k])` — so handing a mode key to it DROPS THE KEY SILENTLY, and every
 * mode the world established is wiped from the slot by the first `_seatPlayer`. That is why
 * `applyModes` exists as a separate applier and is called AFTER `applyPerks`, not instead of it.
 *
 * Kept in its own module (rather than beside `KDGAMEDATA_WORLD_KEYS` in `headless-host.js`) so the
 * lightweight `join-gate.js` can validate a declaration without loading the whole engine host.
 *
 * ── NO GAMEPLAY CONSTANTS ─────────────────────────────────────────────────────────────────────────
 * Epic AC2 (KDM-159) forbids gameplay constants here. These are not values — they are the NAMES of
 * KD's own keys, used to decide who owns which. No difficulty number, threshold or effect is
 * expressed anywhere in this file; what each mode DOES remains entirely KD's business.
 */

/**
 * Modes that describe the RUN. Both players must agree, so these come from the host once and are
 * re-applied to every seat.
 *
 * - `randomMode`    — changes map generation, so it must be set BEFORE the map is generated.
 * - `hardMode` / `extremeMode` — enemy difficulty for the shared world.
 * - `itemMode` / `itemPartialMode` — what the run's item economy is.
 * - `saveMode`      — a property of the session, not of a character.
 */
const MODE_WORLD_KEYS = Object.freeze([
	'randomMode', 'hardMode', 'extremeMode', 'itemMode', 'itemPartialMode', 'saveMode',
	// Run difficulty and the rescue rule — one world cannot be easy for one player and not the other.
	'easyMode', 'norescueMode',
	// How perks are GAINED during the run. Two players under different progression rules are not
	// playing the same game. (KDM-242 arbitrates perks gained mid-run; it may revisit this line, and
	// should say so if it does.)
	'noperks', 'perksmandatory', 'perksdebuff',
	// How the dungeon is escaped — the level goal itself, which is KDM-240's subject.
	'escapekey', 'escaperandom',
]);

/**
 * Modes that describe a CHARACTER. These stay on the per-player channel KDM-238 built and are never
 * taken from the host — the comment in `swap-session.js` that the MP layer must not choose a
 * player's perks covers these for the same reason.
 *
 * `arousalMode` in particular gates which perks are even offered (`KinkyDungeonPerks.ts:669`
 * `requireArousal`), which is exactly the kind of choice that is the player's to make.
 */
const MODE_PLAYER_KEYS = Object.freeze([
	'arousalMode', 'hardperksMode', 'vhardperksMode',
	// The third rung of the same perk-difficulty dial as the two above.
	'perksMode',
	// Whether this character's perks manifest as bondage, and whether that is shown — one is about
	// their body, the other is pure presentation. Neither is the party's business.
	'perkBondage', 'perkNoBondage', 'hideperkbondage', 'partialhideperkbondage',
	// The character's class. KDM-256 owns choosing it; it is listed here so the drift guard is
	// satisfied and so nobody later mistakes it for a world property.
	'classMode',
]);

/**
 * KDM-239 R3 — the SOURCE global each world key is derived from, and the value that produces it.
 *
 * `KDUpdatePlugSettings` is a one-way derivation: nine-ish source globals in, twenty-two
 * `KinkyDungeonStatsChoice` keys out. Two sides of this feature need that mapping — the host CLIENT
 * reads globals to say what it has chosen, and the WORLD writes globals so KD can derive the keys
 * itself. One table serves both, so a key can never be readable and unwritable (or vice versa).
 *
 * ⚠️ ORDER IS SIGNIFICANT for the multi-valued dials. `KinkyDungeonPerkProgressionMode` produces
 * `perksmandatory` at `>= 2` and `perksdebuff` at `== 3`, so a declaration naming both must end up
 * at 3. Listing the values ASCENDING and letting a later assignment win produces exactly that, with
 * no special case. Same shape for `KinkyDungeonItemMode` and `KinkyDungeonEasyMode`.
 *
 * We do not reproduce the derivation itself — `KDUpdatePlugSettings` is still what computes every
 * key. This is only the inverse of its INPUTS, which is the minimum needed to say "the host chose
 * this" across a wire.
 */
const MODE_SOURCE = Object.freeze({
	randomMode:      { global: 'KinkyDungeonRandomMode', value: true },
	hardMode:        { global: 'KinkyDungeonHardMode', value: true },
	extremeMode:     { global: 'KinkyDungeonExtremeMode', value: true },
	saveMode:        { global: 'KinkyDungeonSaveMode', value: true },
	itemMode:        { global: 'KinkyDungeonItemMode', value: 1 },
	itemPartialMode: { global: 'KinkyDungeonItemMode', value: 2 },
	easyMode:        { global: 'KinkyDungeonEasyMode', value: 1 },
	norescueMode:    { global: 'KinkyDungeonEasyMode', value: 2 },
	noperks:         { global: 'KinkyDungeonPerkProgressionMode', value: 0 },
	perksmandatory:  { global: 'KinkyDungeonPerkProgressionMode', value: 2 },
	perksdebuff:     { global: 'KinkyDungeonPerkProgressionMode', value: 3 },
	escapekey:       { global: 'KinkyDungeonProgressionMode', value: 'Key' },
	escaperandom:    { global: 'KinkyDungeonProgressionMode', value: 'Random' },
});

/** Length cap for a declared seed. LAN-only posture: not security, just "cannot wedge a session". */
const SEED_MAX = 64;

const WORLD_SET = new Set(MODE_WORLD_KEYS);
const PLAYER_SET = new Set(MODE_PLAYER_KEYS);

/** Is this one of KD's game-mode keys at all (either side of the classification)? */
function isModeKey(k) { return WORLD_SET.has(k) || PLAYER_SET.has(k); }

/**
 * Normalise a host's world declaration into `{ modes, seed }`.
 *
 * Deliberately strict and deliberately SILENT about rejects: an unknown key, or a real-but-player
 * level key like `arousalMode`, is dropped rather than refused. A host running a slightly different
 * build must still be able to start a game, and the honest fallback for "I do not know what that is"
 * is KD's own default — never "refuse the session".
 *
 * Absence and emptiness mean the same thing here (`{modes: [], seed: ''}` = "KD's defaults"), unlike
 * `mods`, where absent has to mean "needs everything". There is no dangerous reading of an empty
 * world declaration.
 */
function sanitizeWorld(raw) {
	const out = { modes: [], seed: '' };
	if (!raw || typeof raw !== 'object') return out;
	if (Array.isArray(raw.modes)) {
		const seen = new Set();
		for (const m of raw.modes) {
			if (typeof m !== 'string') continue;
			const k = m.trim();
			// Only WORLD keys. A player-level key arriving here is the host trying to choose for
			// someone else, and is dropped for the same reason a perk would be.
			if (!WORLD_SET.has(k) || seen.has(k)) continue;
			seen.add(k);
			out.modes.push(k);
		}
	}
	if (typeof raw.seed === 'string') {
		// Strip control characters BEFORE capping — the value reaches an eval as a JSON literal, and
		// "it is JSON-encoded so it is safe" is the assumption this project has been bitten by before
		// (memory: backtick-in-template-literal).
		out.seed = raw.seed.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, SEED_MAX);
	}
	return out;
}

/**
 * The browser-ready form of the table, on the same terms as `KD_DELTA_BROWSER` in `kd-delta.js`.
 *
 * The client cannot `require` this file (it is served as a plain script), and the alternative —
 * hand-copying the key→global mapping into `coop-bootstrap.js` — is precisely the drift this module
 * exists to prevent. One source of truth, two injection sites.
 */
const GAME_MODES_BROWSER = ';(typeof window !== \'undefined\' ? window : globalThis).KDGameModes = '
	+ JSON.stringify({ MODE_SOURCE, MODE_WORLD_KEYS }) + ';\n';

module.exports = {
	MODE_WORLD_KEYS, MODE_PLAYER_KEYS, MODE_SOURCE, SEED_MAX, isModeKey, sanitizeWorld,
	GAME_MODES_BROWSER,
};
