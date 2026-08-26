/**
 * Node-layer (Vitest) — KDM-273: the map-generation SEED is world state, not per-player.
 *
 * `KinkyDungeonSeed` decides what the NEXT floor looks like. `KDInitTempValues` re-randomises it per
 * map and stores the value it used as `KDGameData.LastMapSeed` (`KinkyDungeonGame.ts:960-970`), and
 * KD's save loader re-seeds the RNG from that pair (`KinkyDungeon.ts:7116`, `:7379`). One party, one
 * world, one next floor.
 *
 * Both are classified world today — `KinkyDungeonSeed` in `GLOBAL_BLACKLIST`, `LastMapSeed` in
 * `KDGAMEDATA_WORLD_KEYS` — and this spec is the pin that was missing.
 *
 * ── WHY THIS SPEC EXISTS WHEN THE FIX ALREADY LANDED ──────────────────────────────────────────────
 * KDM-243 found the defect while importing a single-player save: after the import the world's seed
 * was correct and the guest's first `restorePlayer` reverted it to the pre-import value. It is pinned
 * by `mp-save-import.spec.ts` — but only INDIRECTLY, through an import.
 *
 * The defect predates the import and does not need one. In any session the seed re-randomises per
 * map, so which floor the party generates next has always depended on whose bundle happened to be
 * swapped in; it is invisible without an import only because every player starts from the same world
 * and the copies therefore agree. Nothing pinned the plain swap case the bug actually lives in, which
 * is what this file adds. Deleting the `KinkyDungeonSeed` entry from `GLOBAL_BLACKLIST` must turn
 * something red without an import in the path.
 *
 * ── WHY IT IS BENIGN UNTIL IT IS NOT ──────────────────────────────────────────────────────────────
 * Same shape as KDM-228's room classification: in ordinary play every bundle is captured from the
 * same world after the same transition, so they all agree and the restore is a no-op. The bug needs
 * the copies to DIVERGE — a rejoin, a stale capture, a bundle that outlives the build that made it
 * (exactly the case `_restoreGlobals` calls out at `headless-host.js:2972-2979`). That is the case
 * this spec constructs, because the happy path where everyone agrees cannot tell a fixed build from
 * a broken one.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ────────────────────────────────────────────────────
 * "The world's seed survived a restore" is also exactly what you would see if the restore had done
 * nothing at all — an empty bundle, a wedged session, a `restorePlayer` that had silently become a
 * no-op. So every case carries CONTROLS, and the pair is the assertion: the world's value held its
 * ground *while* an ordinary value on the same bundle was installed.
 *
 * There are TWO controls, not one, because the two halves of the pair are subtracted by two different
 * code paths that can fail independently:
 *   - `bundle.globals`  → `_restoreGlobals`, which subtracts `GLOBAL_BLACKLIST`  (headless-host.js:2981)
 *   - `bundle.gameData` → `restorePlayer`,   which subtracts `KDGAMEDATA_WORLD_KEYS` (:3082)
 * A single control would leave one of the two channels unproven.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KDGAMEDATA_WORLD_KEYS, GLOBAL_BLACKLIST } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

/**
 * The two controls — one per restore channel.
 *
 * The `gameData` control is an invented key, because `KDGameData` is a plain object and an unknown
 * property on it is just a property.
 *
 * The `globals` control CANNOT be invented, and finding that out is worth recording: `_restoreGlobals`
 * installs a name with `eval(n + ' = …')` inside a `try`, and for a name that was never declared that
 * assignment throws and is swallowed. A made-up global therefore never arrives, and the "control"
 * would fail on a perfectly healthy build — a false red that looks exactly like a broken restore. So
 * the globals control is a REAL declared per-player global instead: `KinkyDungeonShopIndex`
 * (`KinkyDungeonShrine.ts:36`), which nothing outside the shop code writes and which no turn driven
 * here can touch.
 */
const CONTROL_GLOBAL = 'KinkyDungeonShopIndex';
const CONTROL_GAMEDATA = '__kdm273GameDataProbe';
/** Per-player magic values for the globals control — distinct, and impossible to produce by chance. */
const SHOP_INDEX_OF: Record<string, number> = { A: 27301, B: 27302 };

/** Values chosen to be recognisable and impossible to produce by chance. */
const WORLD_SEED = 273_000_001;
const STALE_SEED = 273_999_999;

describe('KDM-273 — the map generation seed is world state', () => {
	let s: any;

	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'seed-classification', pvp: false });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	/** Read the world's own values — not any player's copy. */
	function world(): { seed: number; lastMapSeed: number; gProbe: any; gdProbe: any } {
		return s.world.eval(`(function(){
			return {
				seed: KinkyDungeonSeed,
				lastMapSeed: KDGameData.LastMapSeed,
				gProbe: (typeof ${CONTROL_GLOBAL} !== 'undefined') ? ${CONTROL_GLOBAL} : undefined,
				gdProbe: KDGameData[${JSON.stringify(CONTROL_GAMEDATA)}]
			};
		})()`);
	}

	/**
	 * Set the world's seed pair the way `KDInitTempValues` does — the world, and only the world.
	 * (`KDrandomizeSeed` then `KDGameData.LastMapSeed = KinkyDungeonSeed`, KinkyDungeonGame.ts:962-970.)
	 */
	function setWorldSeed(seed: number) {
		s.world.eval(`(function(){
			KinkyDungeonSeed = ${seed};
			KDGameData.LastMapSeed = ${seed};
		})()`);
	}

	/**
	 * Make EVERY player's captured bundle disagree with the world about the seed, and stamp a control
	 * on each of the two restore channels at the same time.
	 *
	 * Every bundle, not just the actor's: with only one stale bundle the other player's turn would
	 * restore the correct value and the world would end the turn right anyway — a green produced by
	 * the fixture rather than by the code.
	 *
	 * Planting `KinkyDungeonSeed` on `bundle.globals` is not an artificial shape. A blacklisted name is
	 * no longer PRODUCED by capture, but a bundle outlives the build that made it — a reconnect, a
	 * stored bundle, a client-supplied one — which is precisely why `_restoreGlobals` subtracts the
	 * blacklist on the way back in as well.
	 */
	function makeBundlesStale(seed: number) {
		let n = 0;
		for (const [id, b] of s.bundles) {
			if (!b || !b.gameData) throw new Error(`precondition: ${id} has no captured gameData`);
			if (!b.globals) throw new Error(`precondition: ${id} has no captured globals`);
			b.globals.KinkyDungeonSeed = seed;
			if (SHOP_INDEX_OF[id] === undefined) throw new Error(`no control value for player ${id}`);
			b.globals[CONTROL_GLOBAL] = SHOP_INDEX_OF[id];
			b.gameData.LastMapSeed = seed;
			b.gameData[CONTROL_GAMEDATA] = `restored-from-${id}`;
			n++;
		}
		// Assert the fixture actually did something, outside the loop: a session that had somehow
		// produced zero bundles would make every case below pass for the wrong reason.
		expect(n, 'precondition: both players must have a captured bundle to make stale').toBe(2);
	}

	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

	it('a stale bundle does not rewrite the seed the next floor will be generated from', () => {
		setWorldSeed(WORLD_SEED);
		makeBundlesStale(STALE_SEED);

		// The deciding layer: restorePlayer is where the world/player split is applied.
		s.world.restorePlayer(s.bundles.get('A'));

		const after = world();

		expect(after.gProbe,
			'CONTROL (globals channel): an ordinary global on the SAME bundle must be installed — '
			+ 'without it this test proves only that _restoreGlobals did nothing at all')
			.toBe(SHOP_INDEX_OF.A);
		expect(after.gdProbe,
			'CONTROL (gameData channel): an ordinary KDGameData key on the SAME bundle must be '
			+ 'installed — without it this test proves only that restorePlayer did nothing at all')
			.toBe('restored-from-A');

		expect(after.seed,
			'R1: the world owns the map seed; a player\'s stale copy must not overwrite it')
			.toBe(WORLD_SEED);
		expect(after.lastMapSeed,
			'R1: LastMapSeed is written by the same statement as KinkyDungeonSeed and classifies with '
			+ 'it — splitting the pair would leave it half-classified')
			.toBe(WORLD_SEED);
	}, BOOT_TIMEOUT);

	it('…and it survives a whole real turn, with both players disagreeing', () => {
		setWorldSeed(WORLD_SEED);
		makeBundlesStale(STALE_SEED);

		turn();

		const after = world();
		expect(Object.values(SHOP_INDEX_OF),
			'CONTROL: the turn really did restore player bundles (globals)').toContain(after.gProbe);
		expect(after.gdProbe, 'CONTROL: the turn really did restore player bundles (gameData)')
			.toMatch(/^restored-from-/);
		expect(after.seed, 'R1: after a full turn the world still owns the seed').toBe(WORLD_SEED);
		expect(after.lastMapSeed, 'R1: …and the LastMapSeed with it').toBe(WORLD_SEED);
	}, BOOT_TIMEOUT);

	it('capture does not hand the seed back out again', () => {
		// The other half of the round trip. Restore subtracting the blacklist is only half a fix if
		// capture keeps minting fresh per-player copies for the next bundle to carry.
		setWorldSeed(WORLD_SEED);
		const bundle = s.world.capturePlayer();

		expect(bundle.globals, 'R1: a freshly captured bundle must not carry the world\'s seed')
			.not.toHaveProperty('KinkyDungeonSeed');
		// Paired with a same-shape CONTROL: `globals` is a real, populated object, so the absence
		// above is a decision and not an empty container. (A bare not.toHaveProperty passes just as
		// happily against `{}`.)
		expect(Object.keys(bundle.globals).length,
			'CONTROL: the captured globals must be non-empty, or the absence above proves nothing')
			.toBeGreaterThan(0);
		expect(bundle.gameData,
			'CONTROL: gameData IS captured whole — LastMapSeed is subtracted on RESTORE, not on '
			+ 'capture, so its presence here is correct and shows the capture ran')
			.toHaveProperty('LastMapSeed');
	}, BOOT_TIMEOUT);

	it('the classification is declared in production code, not inferred by this test', () => {
		// Same rule mp-noninterference and mp-room-world-state state: the world/player split lives in
		// ONE named list in production code. If someone "fixes" the behaviour above by special-casing
		// the seed somewhere else, this fails and says so.
		expect(GLOBAL_BLACKLIST, 'KinkyDungeonSeed must be declared world-scoped')
			.toContain('KinkyDungeonSeed');
		expect(KDGAMEDATA_WORLD_KEYS, 'LastMapSeed must be declared world-scoped')
			.toContain('LastMapSeed');
	});
});
