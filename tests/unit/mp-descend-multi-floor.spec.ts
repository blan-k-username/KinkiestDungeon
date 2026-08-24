/**
 * Node-layer (Vitest) — KDM-265: a co-op party can actually descend more than one floor.
 *
 * Two defects, found while trying to write KDM-262's reachability test. Both are invisible to the
 * existing suite because `mp-party-lands-together.spec.ts` does exactly ONE descent, and that one
 * happens to take the instant branch.
 *
 * ── B1: the deferred map generation never runs ────────────────────────────────────────────────────
 * `KDGoThruTile` does not always generate the new map inline. When
 * `!forceInstant && level < maxLevel-1 && …` it instead sets `KinkyDungeonState = "GenMap"` and parks
 * the work in `KDGenMapCallback` (`KDStairActions.ts:251-258`). The ONLY thing that ever runs it is
 * the draw loop: `if (KDGenMapCallback) setTimeout(RunGenMapCallback, 100)` (`KinkyDungeon.ts:2858`).
 * The server has no draw loop. Measured: four consecutive real descents left the callback set and the
 * session in `GenMap` with the map unchanged — and since KDM-239 R7 the client ADOPTS the server's
 * screen, so both players would sit on a `GenMap` screen forever.
 *
 * ── B2: the party's floor is per-player ───────────────────────────────────────────────────────────
 * `MiniGameKinkyDungeonLevel` was not in `GLOBAL_BLACKLIST`, and `JourneyX`/`JourneyY` /
 * `HighestLevelCurrent` were not in `KDGAMEDATA_WORLD_KEYS`. Each turn's `restorePlayer` installs the
 * acting player's copy and their turn captures it straight back, so once two bundles disagree the
 * world flips between them forever.
 *
 * ── WHY THE B2 TESTS LOOK PARANOID ────────────────────────────────────────────────────────────────
 * Widening the world set is a NO-OP in ordinary play: every bundle is captured from the same world
 * after the same turn, so they already agree. A test that does not first make the bundles DISAGREE
 * passes identically on a fixed and a broken build. So each case here plants a disagreement AND a
 * CONTROL key on the same bundle in the same breath — the control must come through, or "the world
 * key held its ground" is indistinguishable from "the restore did nothing at all". That pairing is
 * KDM-228's, and it is the only thing that makes these assertions mean anything.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KDGAMEDATA_WORLD_KEYS } = require('../../tools/mp-server/headless-host');
import { mapId, descend } from './helpers/world';

const BOOT_TIMEOUT = 300_000;

/** A key no game code writes, so its arrival can only mean "this bundle really was restored". */
const CONTROL_KEY = '__kdm265RestoreProbe';

describe('KDM-265 — the party descends', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'descend-multi', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
	function world() {
		return s.world.eval(`(function(){
			return {
				level: MiniGameKinkyDungeonLevel,
				jx: KDGameData.JourneyX, jy: KDGameData.JourneyY,
				highest: KDGameData.HighestLevelCurrent,
				state: typeof KinkyDungeonState !== 'undefined' ? KinkyDungeonState : null,
				pendingGen: typeof KDGenMapCallback !== 'undefined' && !!KDGenMapCallback,
				probe: KDGameData[${JSON.stringify(CONTROL_KEY)}],
			};
		})()`);
	}

	// ── B1 ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * R1's oracle, and it is deliberately NOT "did the map change" — the map changes either way on the
	 * instant branch, which is exactly how this hid. The question is whether any WORK WAS LEFT
	 * PENDING. (The oracle KDM-240's notes already recommended.)
	 */
	it('R1: no descent leaves map generation pending', () => {
		for (let i = 1; i <= 4; i++) {
			expect(descend(s), `descent ${i} did not throw`).toBe('ok');
			turn();
			const w = world();
			expect(w.pendingGen, `descent ${i}: KDGenMapCallback must not still be armed`).toBe(false);
			expect(w.state, `descent ${i}: the session must not be parked in GenMap`).not.toBe('GenMap');
		}
	}, BOOT_TIMEOUT);

	/**
	 * The two call sites of `runDeferredMapGen` (applyInput and applyInputObserved) must not drift.
	 * Driven directly, because the turn loop only ever exercises the observed one.
	 */
	it('R1: BOTH apply paths run the deferred generation', () => {
		for (const path of ['applyInput', 'applyInputObserved']) {
			s.world.restorePlayer(s.bundles.get('A'));
			// Arm a callback the way a deferred transition does, then push any input through.
			s.world.eval(`(function(){
				globalThis.__kdm265Ran = 0;
				KDGenMapCallback = function(){ globalThis.__kdm265Ran += 1; return 'Game'; };
				KinkyDungeonState = 'GenMap';
			})()`);
			(s.world as any)[path]('wait', {});
			const out = s.world.eval(`(function(){ return {
				ran: globalThis.__kdm265Ran,
				pending: !!KDGenMapCallback,
				state: KinkyDungeonState,
			}; })()`);
			expect(out.ran, `${path}: the deferred callback must have been run exactly once`).toBe(1);
			expect(out.pending, `${path}: and cleared`).toBe(false);
			expect(out.state, `${path}: and its return adopted as the screen`).toBe('Game');
		}
	}, BOOT_TIMEOUT);

	/**
	 * KDM-240's lesson, pinned: a callback that THROWS must still be cleared, or it poisons every
	 * later turn. Clear-then-call is what buys that; call-then-clear would leave it armed.
	 */
	it('R1: a throwing callback is still cleared', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval(`(function(){
			KDGenMapCallback = function(){ throw new Error('kdm265 boom'); };
			KinkyDungeonState = 'GenMap';
		})()`);
		s.world.applyInputObserved('wait', {});
		expect(s.world.eval('!!KDGenMapCallback'),
			'a throw must cost one transition, not the whole session').toBe(false);
	}, BOOT_TIMEOUT);

	// ── B2 ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * THE DIVERGENCE TEST. Plants a disagreement on every bundle — not just the actor's, because with
	 * one stale bundle the other player's turn would restore the right value and the world would end
	 * the turn correct anyway, i.e. a green produced by the fixture rather than by the code.
	 */
	function makeBundlesStale(patch: Record<string, any>, gamePatch: Record<string, any>) {
		for (const [id, b] of s.bundles) {
			if (!b || !b.gameData) throw new Error(`precondition: ${id} has no captured gameData`);
			for (const [k, v] of Object.entries(gamePatch)) b.gameData[k] = v;
			b.gameData[CONTROL_KEY] = 'from-' + id;          // the control, same bundle, same breath
			for (const [k, v] of Object.entries(patch)) b.globals[k] = v;
		}
	}

	it('R2: a stale bundle cannot move the party to another floor', () => {
		expect(descend(s), 'precondition: get off the boot room').toBe('ok');
		turn();
		const here = world();
		makeBundlesStale(
			{ MiniGameKinkyDungeonLevel: here.level + 7 },
			{ JourneyX: 99, JourneyY: 99, HighestLevelCurrent: 99 });
		turn();
		const after = world();
		expect(after.probe, 'CONTROL: the bundles really were restored — else this proves nothing')
			.toMatch(/^from-/);
		expect(after.level, 'the floor is the world\'s, not a player\'s copy').toBe(here.level);
		expect(after.jx, 'and so is the journey position').toBe(here.jx);
		expect(after.jy, 'and so is the journey position').toBe(here.jy);
		expect(after.highest, 'and so is how deep the run has been').toBe(here.highest);
	}, BOOT_TIMEOUT);

	/** The classification is a named list in production code, not a wildcard. */
	it('R2: the journey position and run depth are declared world keys', () => {
		for (const k of ['JourneyX', 'JourneyY', 'HighestLevelCurrent', 'HighestLevel']) {
			expect(KDGAMEDATA_WORLD_KEYS, `${k} must be declared world scope`).toContain(k);
		}
	});

	// ── R3 ────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * The end-to-end claim, and the one the whole task exists for: repeated real descents make
	 * PROGRESS. Asserts the floor strictly increases rather than merely "the map changed" — the
	 * oscillation this task fixes changed the map on every hop while going nowhere.
	 */
	it('R3: repeated descents reach floor 3, without going backwards', () => {
		const seen: string[] = [];
		let guard = 0;
		while (world().level < 3 && guard++ < 12) {
			const before = world().level;
			expect(descend(s), `descent ${guard} did not throw`).toBe('ok');
			turn();
			const now = world().level;
			seen.push(now + mapId(s).split("|")[1]);
			expect(now, `descent ${guard}: the party must never go back up (${before} -> ${now})`)
				.toBeGreaterThanOrEqual(before);
		}
		expect(world().level, `reached floors: ${seen.join(',')} in ${guard} descents`)
			.toBeGreaterThanOrEqual(3);
		expect(mapId(s), 'and the map id reflects it').toContain('3|');
	}, BOOT_TIMEOUT);
});
