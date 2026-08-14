/**
 * Node-layer (Vitest) — KDM-161: generic per-player capture, no hand-written whitelist.
 *
 * capturePlayer named ~20 globals by hand; that list can only ever be as complete as our knowledge of
 * a 280-file moving target, and every KDM-156 bug was a hole in it. Replace the enumeration with a
 * derived one:
 *
 *     PER_PLAYER = mutable(bundleGlobals ∪ globalThis) − GLOBAL_BLACKLIST
 *
 * Measured basis (KDM-161 probes 5–6): 2,381 top-level names exist, but only 43 CHANGE under a real
 * action mix — so a ~15-entry category blacklist replaces a 2,381-name problem. A full fingerprint
 * pass costs 109 ms, hence classification happens at boot, never per swap.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const {
	HeadlessHost, deriveBundleGlobals, GLOBAL_BLACKLIST, MIN_EXPECTED_GLOBALS,
} = require('../../tools/mp-server/headless-host');
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('KDM-161 · deriving global names from the bundle', () => {
	it('finds the top-level declarations (measured: 2,381)', () => {
		const names = deriveBundleGlobals();
		expect(names.length).toBeGreaterThanOrEqual(MIN_EXPECTED_GLOBALS);
		// spot-check a few that must exist, spanning different source files
		expect(names).toContain('KDGameData');
		expect(names).toContain('KinkyDungeonSlowLevel');
		expect(names).toContain('KinkyDungeonStruggleGroups');
	});

	it('drift assertion: a materially smaller bundle is reported, not silently accepted (AC4)', () => {
		// Simulate an upstream bundle whose shape our regex no longer matches.
		const tiny = deriveBundleGlobals('let OnlyOne = 1;\nlet AndTwo = 2;\n');
		expect(tiny.length).toBeLessThan(MIN_EXPECTED_GLOBALS);
		// the checker must flag it rather than return a plausible-looking short list
		expect(() => deriveBundleGlobals('let OnlyOne = 1;\n', { assert: true })).toThrow(/drift|expected/i);
	});

	it('blacklists by category, and does not swallow player state', () => {
		// world + render categories are excluded …
		expect(GLOBAL_BLACKLIST).toContain('KDMapData');
		expect(GLOBAL_BLACKLIST).toContain('KDDrawUpdate');
		// … but the state KDM-156 had to hand-patch must NOT be excluded: it is per-player, and
		// the whole point is that the generic mechanism carries it without anyone naming it.
		expect(GLOBAL_BLACKLIST).not.toContain('KinkyDungeonSlowLevel');
		expect(GLOBAL_BLACKLIST).not.toContain('KinkyDungeonStruggleGroups');
	});
});

describe('KDM-161 · generic capture carries state nobody enumerated', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'generic-capture' });
		h.boot();
		h.init({ seed: 'kdm161-capture' });
	}, BOOT_TIMEOUT);

	it('a bundle global that is NOT in the old whitelist survives capture -> clobber -> restore', () => {
		// KDOrigWill / KinkyDungeonSubmissiveMult were never in capturePlayer's named list; probe6
		// showed both are per-player. Under the generic mechanism they must round-trip.
		h.eval(`(function(){ KDOrigWill = 7.5; KinkyDungeonSubmissiveMult = 3.25; })()`);
		const bundle = h.capturePlayer();
		h.eval(`(function(){ KDOrigWill = 0; KinkyDungeonSubmissiveMult = 0; })()`);
		h.restorePlayer(bundle);
		expect(h.eval(`({ w: KDOrigWill, s: KinkyDungeonSubmissiveMult })`))
			.toEqual({ w: 7.5, s: 3.25 });
	}, BOOT_TIMEOUT);

	it('does NOT restore world-category globals (the shared dungeon stays shared)', () => {
		const bundle = h.capturePlayer();
		h.eval(`(function(){ KinkyDungeonEnemyID = 4242; })()`);
		h.restorePlayer(bundle);
		// the world counter must keep the world's value, not be rolled back by a player restore
		expect(h.eval('KinkyDungeonEnemyID')).toBe(4242);
	}, BOOT_TIMEOUT);
});

describe('KDM-161 · AC3 — a mod\'s new global is per-player with ZERO server changes', () => {
	it('carries a mod-declared global across the swap, and keeps it private to its owner', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'kdm161-mod' });
		s.join('A');
		s.join('B');
		// A mod that nobody wrote the server for. It declares its own per-player state on globalThis,
		// which is where CLAUDE.md tells mod authors to put their API.
		s.world.loadMod(`globalThis.MyModPlayerScore = 0;`);

		// A scores.
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval(`(function(){ globalThis.MyModPlayerScore = 99; })()`);
		s.bundles.set('A', s.world.capturePlayer());

		// B does not.
		s.world.restorePlayer(s.bundles.get('B'));
		expect(s.world.eval('globalThis.MyModPlayerScore'),
			'B must not inherit A\'s mod state').not.toBe(99);

		// A still has it after a round trip.
		s.world.restorePlayer(s.bundles.get('A'));
		expect(s.world.eval('globalThis.MyModPlayerScore')).toBe(99);
	}, BOOT_TIMEOUT);
});

/**
 * KDM-161 AC1 — Map/Set are the last thing blocking deletion of the hand-written whitelist.
 *
 * `JSON.stringify(new Map())` is `"{}"`, so a Map global is watched but can NEVER appear diverged
 * from baseline: KinkyDungeonInventory, KinkyDungeonFlags and KinkyDungeonStatsChoice are invisible
 * to the generic layer and ride entirely on `_capturePlayerNamed`. These assert against the GENERIC
 * slot (`bundle.globals`) on purpose — asserting on the bundle as a whole would pass today via the
 * named half and prove nothing.
 */
describe('KDM-161 · the generic layer carries Map and Set', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'generic-codec' });
		h.boot();
		h.init({ seed: 'kdm161-codec' });
	}, BOOT_TIMEOUT);

	it('a Map global round-trips through the generic slot and comes back a real Map', () => {
		h.eval(`(function(){ KinkyDungeonSetFlag('kdm161codec', 5); })()`);
		const bundle = h.capturePlayer();
		expect(bundle.globals, 'KinkyDungeonFlags must reach the generic slot')
			.toHaveProperty('KinkyDungeonFlags');

		h.eval(`(function(){ KinkyDungeonFlags = new Map(); })()`);
		h._restoreGlobals(bundle.globals);   // generic layer ONLY — no named fallback
		expect(h.eval(`({
			isMap: KinkyDungeonFlags instanceof Map,
			flag: KinkyDungeonFlags.get('kdm161codec'),
		})`)).toEqual({ isMap: true, flag: 5 });
	}, BOOT_TIMEOUT);

	it('a Map OF Maps (KinkyDungeonInventory) round-trips with the inner Maps intact', () => {
		h.addRestraint('DuctTapeFeet');
		const before = h.eval(`(function(){
			var o = {}; KinkyDungeonInventory.forEach(function(v, k){ o[k] = v.size; }); return o;
		})()`);
		expect(Object.keys(before).length, 'test is meaningless with an empty inventory')
			.toBeGreaterThan(0);

		const bundle = h.capturePlayer();
		expect(bundle.globals).toHaveProperty('KinkyDungeonInventory');

		h.eval(`(function(){ KinkyDungeonInventory = new Map(); })()`);
		h._restoreGlobals(bundle.globals);
		expect(h.eval(`(function(){
			var o = {}, allMaps = true;
			KinkyDungeonInventory.forEach(function(v, k){ if (!(v instanceof Map)) allMaps = false; o[k] = v.size; });
			return { outer: KinkyDungeonInventory instanceof Map, allMaps: allMaps, shape: o };
		})()`)).toEqual({ outer: true, allMaps: true, shape: before });
	}, BOOT_TIMEOUT);

	it('a mod-declared Set is carried and stays private to its owner', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'kdm161-set' });
		s.join('A');
		s.join('B');
		s.world.loadMod(`globalThis.MyModTags = new Set();`);

		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval(`(function(){ globalThis.MyModTags.add('owned-by-A'); })()`);
		s.bundles.set('A', s.world.capturePlayer());

		s.world.restorePlayer(s.bundles.get('B'));
		expect(s.world.eval(`(function(){
			return { isSet: globalThis.MyModTags instanceof Set, has: globalThis.MyModTags.has('owned-by-A') };
		})()`), 'B must not inherit A\'s Set contents').toEqual({ isSet: true, has: false });

		s.world.restorePlayer(s.bundles.get('A'));
		expect(s.world.eval(`(function(){
			return { isSet: globalThis.MyModTags instanceof Set, has: globalThis.MyModTags.has('owned-by-A') };
		})()`)).toEqual({ isSet: true, has: true });
	}, BOOT_TIMEOUT);
});

/**
 * KDM-161 AC1 — the hand-written whitelist is DELETED, not extended.
 *
 * Structural, on purpose: the behavioural guarantees are I1/I2/I3 (mp-parity-oracle,
 * mp-noninterference), which are mechanism-agnostic. This one pins the mechanism, so the named list
 * cannot quietly come back as a "just this one field" exception.
 */
describe('KDM-161 · AC1 — no hand-written player whitelist survives', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'ac1-shape' });
		h.boot();
		h.init({ seed: 'kdm161-ac1' });
	}, BOOT_TIMEOUT);

	it('capturePlayer no longer names player globals by hand', () => {
		expect(typeof h._capturePlayerNamed, '_capturePlayerNamed must be gone').toBe('undefined');
		const bundle = h.capturePlayer();
		// The generic slot plus KDGameData's declared bounded exception — nothing else.
		expect(Object.keys(bundle).sort()).toEqual(['gameData', 'globals', 'v']);
	}, BOOT_TIMEOUT);
});

/**
 * KDM-161 AC4 — the size threshold must fail LOUDLY.
 *
 * Globals whose serialised form exceeds BASELINE_MAX_LEN are dropped from the watch set on the theory
 * that they are static data tables (shared world data by definition). That is a classification, not a
 * proof, and a silently-dropped per-player global is the exact bug class this epic exists to remove —
 * so the drop is audited, on the same "report drift, never degrade quietly" contract as the
 * BUNDLE_PATCHES site counts.
 */
describe('KDM-161 · AC4 — an oversize global that mutates is REPORTED, not silently dropped', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'oversize-audit' });
		h.boot();
		h.init({ seed: 'kdm161-oversize' });
	}, BOOT_TIMEOUT);

	it('reports nothing while the excluded tables really are static', () => {
		expect(Object.keys(h._oversize).length, 'no global was excluded on size — test is vacuous')
			.toBeGreaterThan(0);
		expect(h._auditOversize(true)).toEqual([]);
	}, BOOT_TIMEOUT);

	it('names the global once it changes', () => {
		const victim = Object.keys(h._oversize)[0];
		h.eval(`(function(){ ${victim}.__kdm161AuditProbe = 1; })()`);
		expect(h._auditOversize(true)).toContain(victim);
	}, BOOT_TIMEOUT);
});
