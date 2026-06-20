/**
 * Node-layer (Vitest) tests for the per-player state-swap model — KD-085 foundation.
 *
 * The uniform action architecture: ONE authoritative world; players are STATE
 * BUNDLES swapped in/out per turn; every action runs through KD's REAL dispatcher
 * (KDSendInput/KDProcessInput). These prove the mechanism: bundle round-trip with
 * NO leakage between players, the real dispatcher executes on the swapped-in player,
 * and world state (enemy HP) persists across player swaps.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 180_000;

describe('swap model — per-player state bundle (KD-085)', () => {
	let w: any;
	let A: any;
	let B: any;

	beforeAll(() => {
		w = new HeadlessHost({ id: 'swap-world' });
		w.boot();
		w.init({ seed: 'swap-model-seed' });
		const t = w.findOpenTile();
		w.placePlayer(t.x, t.y);

		const base = w.capturePlayer();
		// player A: bound + hurt
		w.addRestraint('DuctTapeHands');
		w.dealDamage(3, 'pain');
		A = w.capturePlayer();
		// player B: fresh baseline, different damage
		w.restorePlayer(base);
		w.dealDamage(1, 'pain');
		B = w.capturePlayer();
	}, BOOT_TIMEOUT);

	it('captures a JSON-safe, versioned bundle excluding map/poses', () => {
		expect(A.v).toBe(1);
		expect(() => JSON.parse(JSON.stringify(A))).not.toThrow();
		const json = JSON.stringify(A);
		expect(json).not.toContain('Poses');
		expect(A).not.toHaveProperty('map');
	});

	it('restores each player independently — no state leakage', () => {
		w.restorePlayer(A);
		const a1 = { r: w.eval('KinkyDungeonAllRestraint().length'), will: w.eval('KinkyDungeonStatWill') };
		w.restorePlayer(B);
		const b1 = { r: w.eval('KinkyDungeonAllRestraint().length'), will: w.eval('KinkyDungeonStatWill') };
		w.restorePlayer(A);
		const a2 = { r: w.eval('KinkyDungeonAllRestraint().length'), will: w.eval('KinkyDungeonStatWill') };

		expect(a1.r).toBe(1);        // A is bound
		expect(b1.r).toBe(0);        // B is NOT bound (A's restraint didn't leak)
		expect(a1.will).not.toBe(b1.will); // independent stats
		expect(a2).toEqual(a1);      // A intact after swapping through B
	});

	it('runs a real KD action via the dispatcher on the swapped-in player', () => {
		w.restorePlayer(B);
		const t0 = w.tick();
		w.applyInput('tick', { delta: 1 }); // KD's real "advance time" input
		expect(w.tick()).toBe(t0 + 1);      // the real pipeline executed
	});

	it('keeps world state (enemy HP) authoritative across a player swap', () => {
		const t = w.findOpenTile();
		w.summonEnemy(t.x + 2, t.y, 'Bat', { rad: 5 });
		const e0 = w.getRealEnemy(0);
		expect(e0).toBeTruthy();
		w.damageEnemy(e0.id, { damage: 0, type: 'pain' }); // 0 dmg → hp unchanged, but proves path
		const hpBefore = w.getRealEnemy(0) ? w.getRealEnemy(0).hp : null;
		w.restorePlayer(A); // swap player
		const hpAfter = w.getRealEnemy(0) ? w.getRealEnemy(0).hp : null;
		expect(hpAfter).toBe(hpBefore); // the player swap did NOT touch the world enemy
	});
});
