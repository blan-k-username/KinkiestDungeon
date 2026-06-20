/**
 * Node-layer (Vitest) tests for the minimal 2-player session join — KD-084.
 *
 * The SMALLEST session-join for the co-op MVP (explicitly NOT the full lobby,
 * KD-072): two clients register, each is assigned its own player instance, and
 * the shared world + turn clock start only once BOTH have joined.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CoopSession } = require('../../tools/mp-server/coop-session');

const BOOT_TIMEOUT = 240_000;

describe('CoopSession — minimal 2-player join (KD-084)', () => {
	it('does NOT start the world/turn clock until both players have joined', () => {
		const s = new CoopSession({ requiredPlayers: 2, seed: 'coop-join-seed' });
		const r1 = s.join('A');
		expect(r1.started).toBe(false);
		expect(r1.joined).toEqual(['A']);
		expect(s.started).toBe(false);
		// the turn clock is unavailable before start
		expect(() => s.submit('A', { dx: 0, dy: 0 })).toThrow();
	});

	it('rejects duplicate joins', () => {
		const s = new CoopSession({ requiredPlayers: 2 });
		s.join('A');
		expect(() => s.join('A')).toThrow();
	});

	describe('once both join', () => {
		let s: any;
		let joinB: any;

		beforeAll(() => {
			s = new CoopSession({ requiredPlayers: 2, seed: 'coop-join-seed' });
			s.join('A');
			joinB = s.join('B');
		}, BOOT_TIMEOUT);

		it('starts the session and assigns each client its own instance', () => {
			expect(joinB.started).toBe(true);
			expect(s.started).toBe(true);
			expect(s.players.sort()).toEqual(['A', 'B']);
			expect(s.instanceOf('A')).toBeTruthy();
			expect(s.instanceOf('B')).toBeTruthy();
			expect(s.instanceOf('A')).not.toBe(s.instanceOf('B')); // distinct instances
		});

		it('assigns correct roles (world + two player instances)', () => {
			expect(s.orch.world.getServerRole()).toBe('world');
			expect(s.instanceOf('A').getServerRole()).toBe('player');
			expect(s.instanceOf('B').getServerRole()).toBe('player');
		});

		it('shares ONE world: both players adopt the world map + see the shared enemy', () => {
			const worldGrid = s.orch.world.eval('KDMapData.Grid');
			expect(s.instanceOf('A').eval('KDMapData.Grid')).toBe(worldGrid);
			expect(s.instanceOf('B').eval('KDMapData.Grid')).toBe(worldGrid);
			// the world-owned enemy is present in both instances (reconciler transmitted it)
			expect(s.instanceOf('A').listEntities().some((e: any) => e.name === 'Rat')).toBe(true);
			expect(s.instanceOf('B').listEntities().some((e: any) => e.name === 'Rat')).toBe(true);
		});

		it('runs the turn clock once started (lockstep, barrier-gated)', () => {
			const t0 = s.orch.ticks();
			expect(s.submit('A', { dx: 0, dy: 0 }).advanced).toBe(false); // barrier holds
			const r = s.submit('B', { dx: 0, dy: 0 });
			expect(r.advanced).toBe(true);
			expect(s.orch.lockstep()).toBe(true);
			expect(s.orch.ticks().world).toBe(t0.world + 1);
		});

		it('rejects joins after the session has started', () => {
			expect(() => s.join('C')).toThrow();
		});
	});
});
