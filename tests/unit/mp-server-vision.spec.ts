/**
 * Node-layer (Vitest) — the co-op server builds the ACTING player's vision grid for turn logic.
 *
 * Single player rebuilds `KDMapExtraData.VisionGrid` from the player's position every draw frame
 * (`KinkyDungeonDraw.ts:1236` → `KDUpdateVision`). The server has no draw loop, so the grid stayed EMPTY
 * through every co-op turn and every `KinkyDungeonVisionGet` answered "unseen": spawns/despawns treated
 * every tile as out of sight, enemy AI and Senses training read nothing.
 *
 * Fix under test: `SwapSession._assertHumanContext` (run whenever a different human takes the slot) calls
 * `HeadlessHost.updateVision()`, which runs KD's own build with no camera and rolls back its other
 * writes (shared fog memory, dark adaptation, a "blinded" message, TrueSight mana): the grid is the only
 * thing that changes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { placePlayerAt, tilesAtRange } from '../helpers/session-tiles';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;
const TURNS = 3;

/** A fingerprint of a vision grid: its length, lit-cell count and a hash of lit indices + values. */
const GRID_PRINT = `function(g){
	g = g || []; var lit = 0, h = 0;
	for (var i = 0; i < g.length; i++) if (g[i] > 0) { lit++; h = (h * 31 + i * 7 + Math.round(g[i] * 100)) | 0; }
	return { len: g.length, lit: lit, hash: h };
}`;

/**
 * KD's own rebuild for whoever holds the slot right now, settled as single player's frames settle it, as
 * a REFERENCE: fingerprint it, then put back everything it touched, so measuring does not change the
 * grid or the state the game is about to read.
 */
const REFERENCE = `function(){
	var keep = { v: KDMapExtraData.VisionGrid, b: KDMapExtraData.BrightnessGrid, c: KDMapExtraData.ColorGrid,
		fg: KDMapData.FogGrid && KDMapData.FogGrid.slice(), fm: KDMapData.FogMemory && KDMapData.FogMemory.slice(),
		va: KDGameData.visionAdjust, vb: KDGameData.visionBlind, vab: KDGameData.visionAdjustBlind,
		log: KinkyDungeonMessageLog.length, vu: KDVisionUpdate, bb: KinkyDungeonBlindLevelBase };
	KDVisionUpdate = 0;
	KDSparseLightCache = {};   // no reuse of a previous brightness grid: the reference is current state only
	// Twice, like the frames single player draws before any input: one build feeds the next (NightVision).
	KDUpdateVision(); KDUpdateVision();
	var print = (${GRID_PRINT})(KDMapExtraData.VisionGrid);
	KDMapExtraData.VisionGrid = keep.v; KDMapExtraData.BrightnessGrid = keep.b; KDMapExtraData.ColorGrid = keep.c;
	KDMapData.FogGrid = keep.fg; KDMapData.FogMemory = keep.fm;
	KDGameData.visionAdjust = keep.va; KDGameData.visionBlind = keep.vb; KDGameData.visionAdjustBlind = keep.vab;
	KinkyDungeonMessageLog.length = keep.log; KDVisionUpdate = keep.vu; KinkyDungeonBlindLevelBase = keep.bb;
	return print;
}`;

describe('the server builds the acting player\'s vision grid', () => {
	let s: any;
	const seen: any[] = [];

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'server-vision', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
		// B stands a few tiles off, so the two views genuinely differ.
		const spot = tilesAtRange(s, 'A', 4, 7)[0];
		expect(spot, 'setup: no free tile 4-7 steps from A').toBeTruthy();
		placePlayerAt(s, 'B', spot.x, spot.y);
		expect(s.posOf('B'), 'setup: B stands on the chosen tile').toMatchObject({ x: spot.x, y: spot.y });
		// A node-side sink: the slot swap captures and restores in-world globals, but not this function.
		s.world._context.__visionSink = (j: string) => seen.push(JSON.parse(j));
		s.world.eval(`(function(){
			var reference = ${REFERENCE}, print = ${GRID_PRINT};
			var prev = KDTickSensesTraining;
			// KDTickSensesTraining runs once in every player's apply, and reads the grid the turn reads.
			KDTickSensesTraining = function(p){
				var pe = KinkyDungeonPlayerEntity;
				__visionSink(JSON.stringify({ x: pe.x, y: pe.y, read: print(KDMapExtraData.VisionGrid),
					own: KinkyDungeonVisionGet(pe.x, pe.y) || 0, want: reference() }));
				return prev(p);
			};
		})()`);
		for (let t = 0; t < TURNS; t++) {
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
		}
	}, BOOT_TIMEOUT);

	it('every apply reads a real grid: the one KD builds for the player acting', () => {
		const a = s.posOf('A'), b = s.posOf('B');
		const ofA = seen.filter((r) => r.x === a.x && r.y === a.y);
		const ofB = seen.filter((r) => r.x === b.x && r.y === b.y);
		// Count OUTSIDE the loop: zero recorded applies must fail, not pass vacuously.
		expect(ofA.length, `A's applies observed — ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(TURNS);
		expect(ofB.length, `B's applies observed — ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(TURNS);
		for (const r of seen) {
			expect(r.want.lit, 'reference: KD lights something around the player').toBeGreaterThan(0);
			expect(r.read, `apply at (${r.x},${r.y}) reads KD's own grid for that player`).toEqual(r.want);
			expect(r.own, `the player's own tile is lit at (${r.x},${r.y})`).toBeGreaterThan(0);
		}
		// Per-viewer, not one shared grid: A and B stand apart, so their grids differ.
		expect(ofA[0].read.hash, 'A and B read different grids').not.toBe(ofB[0].read.hash);
	});

	it('the build changes ONLY the grid: fog memory, dark adaptation, log, mana and pending blindness are rolled back', () => {
		const state = () => s.world.eval(`(function(){
			return JSON.stringify({ fg: KDMapData.FogGrid || null, fm: KDMapData.FogMemory || null,
				va: KDGameData.visionAdjust, vb: KDGameData.visionBlind, vab: KDGameData.visionAdjustBlind,
				log: KinkyDungeonMessageLog.length, mana: KinkyDungeonStatMana, blindBase: KinkyDungeonBlindLevelBase,
				truesight: KinkyDungeonFlags.get('truesight') || 0 });
		})()`);
		s.world.restorePlayer(s.bundles.get('A'));
		// A pending blindness buff mid-turn: the build must not "consume" it before stats read it.
		s.world.eval('KDMapData.FogMemory = []; KDMapData.FogGrid = []; KinkyDungeonBlindLevelBase = 2;');
		const before = state();
		const r = s.world.updateVision();
		expect(r.ok, JSON.stringify(r)).toBe(true);
		expect(r.len, 'the grid was built').toBeGreaterThan(0);
		expect(state(), 'nothing but the grid changed').toBe(before);
		// CONTROL: KD's raw build DOES write the shared fog memory on this same state, so the equality
		// above is a real rollback, not a build that happened to touch nothing.
		s.world.eval('KDVisionUpdate = 0; KDUpdateVision();');
		expect(state(), 'control: a raw KDUpdateVision writes fog memory').not.toBe(before);
	});

	it('costs little per hand-over', () => {
		const N = 20;
		let total = 0;
		for (let i = 0; i < N; i++) total += s.world.updateVision().ms;
		const mean = total / N;
		console.log(`[server-vision] updateVision mean ${mean.toFixed(2)} ms over ${N} calls`);
		// Generous ceiling: this runs a few times per player per round. A real regression is 10x, not 10%.
		// Measured 7-20 ms alone, 56 ms with the whole unit layer running beside it: the ceiling sits at
		// ~10x the quiet cost so contention cannot trip it and a real regression still does.
		expect(mean).toBeLessThan(150);
	});
});
