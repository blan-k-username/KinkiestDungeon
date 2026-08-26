/**
 * Node-layer (Vitest) — KDM-277 slice 2: six keys that describe the MAP or its ENTITIES and were
 * being replicated per-player.
 *
 * All six were flagged by KDM-273's transition-write audit. Each is classified here against the
 * criteria stated over `KDGAMEDATA_WORLD_KEYS` in headless-host.js — (a) keyed by entity id,
 * (b) floor/dungeon generation or population state — with the evidence, not the intuition:
 *
 *   KDGameData.PersistentItems   keyed by `RoomType + "," + KDCurrentWorldSlot.x + "," + .y`
 *                                (KDMapGen.ts:70). Read by KinkyDungeonInventory.ts:3369, which
 *                                iterates every world slot's list to decide which item variants
 *                                exist. A per-player copy of a world-slot-keyed table is (a)/(b).
 *   KDCommanderRoles             `Map<number, string>` keyed by `enemy.id`
 *                                (KDCommander.ts:174/179, deleted at :205/:209). A number key in KD
 *                                is an entity id — criterion (a) verbatim, the same argument
 *                                KDIDCache and KDEntityFlagCache are already blacklisted on.
 *   KDGameData.AlreadyOpened     `{x, y}` MAP COORDINATES pushed at KinkyDungeonTilesList.ts:643/
 *                                659/687, read by `KDAlreadyOpened(x, y)` (KinkyDungeonGame.ts:381).
 *                                "Has the party opened this tile" is the direct sibling of
 *                                `ChestsGenerated`, which is already declared world.
 *   KDGameData.KeyringLocations  `{x, y}` map coordinates, read by the jail keyring placement
 *                                (KinkyDungeonJail.ts:651). Map furniture — criterion (b).
 *   KDStageBossGenerated         generation state by name and by use: set during generation
 *                                (KDMapGen.ts:239/245, KinkyDungeonSetpiece.ts:355,
 *                                KinkyDungeonAlt.ts:2504/2548) and read BY generation to decide jail
 *                                placement (KDMapGen.ts:460, :615). Criterion (b).
 *   KinkyDungeonPOI              map points of interest emitted by the generator
 *                                (KDMapGen.ts:383-384) and drawn at KinkyDungeonDraw.ts:4355.
 *                                Criterion (b).
 *
 * ── ONE FLAGGED KEY IS DELIBERATELY *NOT* HERE ────────────────────────────────────────────────────
 * `KinkyDungeonGrid_Last` was flagged alongside these on the reasoning that it is "a cache over
 * KDMapData.Grid". That reasoning was inferred from the NAME and is wrong: the global is written in
 * exactly two places (`KinkyDungeonGame.ts:72` declaring it `""`, `KDMapGen.ts:270` resetting it to
 * `""`) and **read nowhere in Game/src**. It is vestigial, it never even diverges from its baseline,
 * and the blacklist's own rule is not to add entries speculatively. It stays per-player, recorded
 * with that reason in the audit register.
 *
 * ── TWO CHANNELS, TWO SHAPES OF TEST ──────────────────────────────────────────────────────────────
 * The world/player split is applied by two different mechanisms, so the six split across two suites:
 *   - bare globals   → `_restoreGlobals` subtracts `GLOBAL_BLACKLIST`; the test is capture-side
 *                      ("does not ship") plus restore-side ("is not reset either").
 *   - KDGameData keys → `restorePlayer` subtracts `KDGAMEDATA_WORLD_KEYS`; the test is the
 *                      divergence shape of mp-room-world-state / mp-seed-world-state — a stale
 *                      bundle must not overwrite the world.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ────────────────────────────────────────────────────
 * Every assertion is either "absent from the bundle" or "the world's value is unchanged", and BOTH
 * are satisfied by a capture/restore that did nothing at all. So each case carries a CONTROL that
 * must move in the same breath: for globals, a non-blacklisted global OF THE SAME SHAPE (Map,
 * boolean, array); for KDGameData, an ordinary key planted on the same bundle.
 *
 * Baselines are MEASURED after boot, never taken from a declaration — slice 1 of this task had a
 * test pass vacuously because `KDRedrawFog`'s declared `0` is `2` after init.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost, GLOBAL_BLACKLIST, KDGAMEDATA_WORLD_KEYS } =
	require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

/** global → the same-shaped, deliberately NOT blacklisted global that proves capture is live. */
const CONTROL_FOR: Record<string, string> = {
	KDCommanderRoles: 'KinkyDungeonFlags',              // Map
	KDStageBossGenerated: 'KinkyDungeonInspect',        // boolean
	KinkyDungeonPOI: 'KinkyDungeonStruggleGroups',      // array
};

const WORLD_GAMEDATA_KEYS = ['PersistentItems', 'AlreadyOpened', 'KeyringLocations'];

/** A key no game code writes, so its arrival can only mean "this bundle really was restored". */
const CONTROL_GAMEDATA = '__kdm277Probe';

describe('KDM-277 · the classifications are declared in production code', () => {
	it('the three map/entity globals are blacklisted', () => {
		for (const g of Object.keys(CONTROL_FOR)) {
			expect(GLOBAL_BLACKLIST, `${g} describes the map or its entities`).toContain(g);
		}
	});

	it('the three map-keyed KDGameData keys are declared world', () => {
		for (const k of WORLD_GAMEDATA_KEYS) {
			expect(KDGAMEDATA_WORLD_KEYS, `KDGameData.${k} is map-keyed`).toContain(k);
		}
	});

	it('every control stays OUT of the blacklist, or the tests below are vacuous', () => {
		for (const [g, control] of Object.entries(CONTROL_FOR)) {
			expect(GLOBAL_BLACKLIST, `${control} is the control for ${g}`).not.toContain(control);
		}
	});

	it('KinkyDungeonGrid_Last is deliberately NOT declared world', () => {
		// Pins the negative decision above, so a later reader cannot quietly "complete the set".
		// It has no reader in Game/src; blacklisting it would be speculative.
		expect(GLOBAL_BLACKLIST).not.toContain('KinkyDungeonGrid_Last');
	});
});

describe('KDM-277 · map/entity globals do not ride a player bundle', () => {
	let h: any;
	const GLOBALS = Object.keys(CONTROL_FOR);
	let BASELINE: Record<string, string>;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm277-worldgen' });
		h.boot();
		h.init({ seed: 'kdm277-worldgen' });
		// Measured once, after boot — see the header note on KDRedrawFog.
		BASELINE = h.eval(`(function(){
			var b = {};
			${GLOBALS.map((g) => `b[${JSON.stringify(g)}] = JSON.stringify(${g} instanceof Map ? [...${g}] : ${g});`).join('\n\t\t\t')}
			return b;
		})()`);
	}, BOOT_TIMEOUT);

	/** Move every subject AND every control off its default, to values the game never produces. */
	function dirtyEverything() {
		h.eval(`(function(){
			KDCommanderRoles = new Map([[277277, 'kdm277Role']]);
			KDStageBossGenerated = false;   // baseline is TRUE after init — measured, not assumed
			KinkyDungeonPOI = [{ x: 277, y: 277, kdm277: true }];
			// same-shaped controls
			KinkyDungeonFlags = new Map([['kdm277Flag', 277]]);
			KinkyDungeonInspect = true;
			KinkyDungeonStruggleGroups = [{ group: 'KDM277Control' }];
		})()`);
	}

	it('CONTROL: all three same-shaped controls DO reach the wire', () => {
		dirtyEverything();
		const globals = h.capturePlayer().globals;
		for (const control of Object.values(CONTROL_FOR)) {
			expect(globals, `a diverged non-blacklisted global must be captured: ${control}`)
				.toHaveProperty(control);
		}
	}, BOOT_TIMEOUT);

	it.each(Object.entries(CONTROL_FOR))(
		'%s is not replicated, while its control %s is',
		(subject, control) => {
			dirtyEverything();
			expect(h.eval(`JSON.stringify(${subject} instanceof Map ? [...${subject}] : ${subject})`),
				`the repro must move ${subject} off its measured post-init baseline`)
				.not.toBe(BASELINE[subject]);

			const globals = h.capturePlayer().globals;
			expect(globals, `${subject} describes the shared world and must not travel per-player`)
				.not.toHaveProperty(subject);
			expect(globals, `control: the capture layer is still live (${control})`)
				.toHaveProperty(control);
		}, BOOT_TIMEOUT);

	it('restore leaves them alone — a blacklisted name is neither shipped nor reset', () => {
		// `_restoreGlobals` resets every WATCHED global the bundle does not carry back to its baseline
		// default, so while these are watched a restore drags the world back to whatever was captured.
		// The values below cannot be produced by the captured bundle, so a snap-back is visible.
		dirtyEverything();
		const bundle = h.capturePlayer();

		h.eval(`(function(){
			KDCommanderRoles = new Map([[999999, 'worldOwnRole']]);
			KDStageBossGenerated = true;
			KinkyDungeonPOI = [{ x: 999, y: 999, worldOwn: true }];
		})()`);
		h.restorePlayer(bundle);

		expect(h.eval(`({
			commander: [...KDCommanderRoles][0][0],
			boss: KDStageBossGenerated,
			poi: KinkyDungeonPOI[0].x
		})`), "a restore must not overwrite the world's own map/entity state")
			.toEqual({ commander: 999999, boss: true, poi: 999 });

		// CONTROL, same call: a non-blacklisted global on that same bundle IS installed, so the
		// assertion above cannot be passing merely because restorePlayer did nothing.
		expect(h.eval("KinkyDungeonFlags.get('kdm277Flag')"),
			'control: the restore really ran and installed per-player state').toBe(277);
	}, BOOT_TIMEOUT);
});

describe('KDM-277 · a stale bundle does not rewrite map-keyed KDGameData', () => {
	let h: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm277-worldgen-gd' });
		h.boot();
		h.init({ seed: 'kdm277-worldgen-gd' });
	}, BOOT_TIMEOUT);

	it.each(WORLD_GAMEDATA_KEYS)(
		'KDGameData.%s keeps the world\'s value when a player bundle disagrees',
		(key) => {
			// The world's value — what a map generation would have produced.
			h.eval(`KDGameData[${JSON.stringify(key)}] = { kdm277World: true };`);

			// A bundle that disagrees, carrying an ordinary control key in the same breath.
			const bundle = h.capturePlayer();
			bundle.gameData[key] = { kdm277Stale: true };
			bundle.gameData[CONTROL_GAMEDATA] = 'restored';

			h.restorePlayer(bundle);

			const after = h.eval(`({
				subject: Object.keys(KDGameData[${JSON.stringify(key)}] || {}).join(','),
				probe: KDGameData[${JSON.stringify(CONTROL_GAMEDATA)}]
			})`);

			expect(after.probe,
				'CONTROL: an ordinary KDGameData key on the SAME bundle must be installed — without it '
				+ 'this proves only that restorePlayer did nothing')
				.toBe('restored');
			expect(after.subject,
				`KDGameData.${key} is map-keyed; a player's stale copy must not overwrite the world's`)
				.toBe('kdm277World');
		}, BOOT_TIMEOUT);
});
