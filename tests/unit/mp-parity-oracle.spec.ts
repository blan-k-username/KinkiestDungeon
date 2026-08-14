/**
 * Node-layer (Vitest) — KDM-160: the parity oracle (I1 + I3).
 *
 * The instrument is KD's OWN save format (KinkyDungeonGenerateSaveData, KinkyDungeon.ts:6925):
 * an upstream-maintained, versioned, complete definition of what a player IS (56 top-level keys)
 * versus the ~20 our bundle hand-picks. `player = save - WORLD_KEYS`.
 *
 *   I1 fixpoint — capture(restore(b)) === b. The swap must not LOSE state.
 *   I3 parity   — a reference single-player host and a 1-player SwapSession, same seed and the same
 *                 input sequence, must hold identical saves.
 *
 * ⚠️ I3 detects LOSS, not LEAKAGE: with one player there is no other player to leak from. Measured
 * during assessment: a 1-player parity run scored 49/50 identical while 86 KDGameData fields were
 * leaking between players. Cross-player contamination is mp-noninterference.spec.ts (I2).
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost, WORLD_KEYS } = require('../../tools/mp-server/headless-host');
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const SEED = 'kdm160-parity';

/**
 * Keys excluded from the parity diff. R7: named individually with a reason — never a wildcard.
 * `id` = KinkyDungeonEnemyID. SwapSession._start spawns a peer avatar and summons the shared enemy,
 * consuming entity IDs the reference single-player run never allocates. Structural, not a leak.
 */
const NAMED_EXCLUSIONS: Record<string, string> = {
	id: 'KinkyDungeonEnemyID — session start allocates avatar + shared-enemy IDs (assessment §A3)',
};

function diffKeys(a: any, b: any): string[] {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	return keys.filter((k) => !(k in NAMED_EXCLUSIONS))
		.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

describe('KDM-160 · I1 — swap fixpoint (no state LOST across a swap)', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'i1' });
		h.boot();
		h.init({ seed: SEED });
	}, BOOT_TIMEOUT);

	it('capture -> restore -> capture is a fixed point', () => {
		const b1 = h.capturePlayer();
		h.restorePlayer(b1);
		const b2 = h.capturePlayer();
		expect(b2).toEqual(b1);
	}, BOOT_TIMEOUT);

	it('a mutated KDGameData field survives capture -> clobber -> restore', () => {
		// Guilt is per-player and NOT in the old 12-key whitelist (assessment §A4).
		h.eval(`(function(){ KDGameData.Guilt = 42; KDGameData.CollectedOrbs = 7; })()`);
		const bundle = h.capturePlayer();
		h.eval(`(function(){ KDGameData.Guilt = 0; KDGameData.CollectedOrbs = 0; })()`);
		h.restorePlayer(bundle);
		expect(h.eval(`({ g: KDGameData.Guilt, o: KDGameData.CollectedOrbs })`))
			.toEqual({ g: 42, o: 7 });
	}, BOOT_TIMEOUT);
});

describe('KDM-160 · saveOf — the measuring instrument (R1/R2/R3)', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'saveof' });
		h.boot();
		h.init({ seed: SEED });
	}, BOOT_TIMEOUT);

	it('runs headless and omits every WORLD_KEY', () => {
		const s = h.saveOf();
		expect(s).toBeTruthy();
		// sanity: it is the real save shape, not a stub
		expect(Object.keys(s).length).toBeGreaterThan(40);
		expect(s.KinkyDungeonPlayerEntity).toBeTruthy();
		for (const k of WORLD_KEYS) expect(s).not.toHaveProperty(k);
	}, BOOT_TIMEOUT);

	it('is stable — two consecutive calls with no action between them are identical (R2)', () => {
		expect(h.saveOf()).toEqual(h.saveOf());
	}, BOOT_TIMEOUT);

	it('does not observably change the session (R2/R3)', () => {
		const probe = `({ tick: KinkyDungeonCurrentTick, px: KinkyDungeonPlayerEntity.x,
			py: KinkyDungeonPlayerEntity.y, ents: KDMapData.Entities.length, enemyId: KinkyDungeonEnemyID })`;
		const before = h.eval(probe);
		h.saveOf();
		expect(h.eval(probe)).toEqual(before);
	}, BOOT_TIMEOUT);
});

describe('KDM-160 · I3 — single-player parity oracle', () => {
	it('a 1-player session matches a reference single-player run over 50 turns', () => {
		const ref = new HeadlessHost({ id: 'ref' });
		ref.boot();
		ref.init({ seed: SEED });
		const base = ref.findOpenTile();
		ref.placePlayer(base.x, base.y);

		const sub = new SwapSession({ requiredPlayers: 1, seed: SEED });
		sub.join('A');
		// both runs must start on the same tile or the comparison is meaningless
		expect(sub.startOf.get('A')).toEqual(base);

		// R8: the input sequence is DATA, so a later slice can fuzz it without touching the harness.
		const INPUTS = Array.from({ length: 50 }, () => ({ kdType: 'tick', data: { delta: 1 } }));
		for (const step of INPUTS) {
			ref.applyInput(step.kdType, step.data);
			sub.submit('A', { kdType: step.kdType, data: step.data });
		}
		expect(ref.tick()).toBe(sub.tick());

		sub.world.restorePlayer(sub.bundles.get('A'));
		const differing = diffKeys(ref.saveOf(), sub.world.saveOf());
		expect(differing).toEqual([]);
	}, BOOT_TIMEOUT);
});
