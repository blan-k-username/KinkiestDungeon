/**
 * Node-layer (Vitest) tests for the production SessionOrchestrator — KD-069.
 *
 * KD-069 scope = the global TURN CLOCK with a submit-barrier over a world instance
 * + N player instances, in-process. The reconciler (KD-070) is a pluggable hook
 * (no-op here); session join (KD-084) builds on addPlayer/removePlayer. These tests
 * assert ONLY the turn-clock contract: roles, lockstep ticks, and the barrier.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SessionOrchestrator } = require('../../tools/mp-server/session-orchestrator');

const BOOT_TIMEOUT = 240_000;

describe('SessionOrchestrator turn clock (KD-069)', () => {
	let s: any;

	beforeAll(() => {
		s = new SessionOrchestrator({ seed: 'session-orch-seed', playerIds: ['A', 'B'] });
		s.setup();
	}, BOOT_TIMEOUT);

	it('boots a world + N player instances with correct roles', () => {
		expect(s.world.getServerRole()).toBe('world');
		expect(s.world.runsEnemyAI()).toBe(true);
		for (const id of s.playerIds) {
			expect(s.players.get(id).getServerRole()).toBe('player');
			expect(s.players.get(id).runsEnemyAI()).toBe(false);
		}
	});

	it('starts in lockstep (all instances at the same tick)', () => {
		expect(s.lockstep()).toBe(true);
	});

	it('does NOT advance until every player has submitted (barrier)', () => {
		const t0 = s.ticks();
		const r1 = s.submit('A', { dx: 1, dy: 0 });
		expect(r1.advanced).toBe(false);
		expect(r1.waitingOn).toContain('B');
		// No instance advanced on a partial submit.
		expect(s.ticks()).toEqual(t0);
		expect(s.world.tick()).toBe(t0.world);
	});

	it('advances ALL instances exactly once when the barrier completes', () => {
		const t0 = s.ticks();
		const r2 = s.submit('B', { dx: 0, dy: 1 });
		expect(r2.advanced).toBe(true);
		const t1 = s.ticks();
		expect(t1.world).toBe(t0.world + 1);
		expect(t1.A).toBe(t0.A + 1);
		expect(t1.B).toBe(t0.B + 1);
		expect(s.lockstep()).toBe(true);
	});

	it('stays in lockstep across several barrier-gated turns', () => {
		for (let i = 0; i < 4; i++) {
			s.submit('A', { dx: 0, dy: 0 });
			const r = s.submit('B', { dx: 0, dy: 0 });
			expect(r.advanced).toBe(true);
			expect(s.lockstep()).toBe(true);
		}
	});

	it('clears pending after a turn (re-arms the barrier)', () => {
		const r = s.submit('A', { dx: 0, dy: 0 });
		expect(r.advanced).toBe(false); // B not in yet → barrier holds again
		s.submit('B', { dx: 0, dy: 0 });
	});

	it('invokes the reconcile hook each turn (pluggable for KD-070)', () => {
		const phases: string[] = [];
		const s2 = new SessionOrchestrator({
			seed: 'session-orch-hook',
			playerIds: ['A', 'B'],
			reconcile: (_orch: any, ctx: any) => { phases.push(ctx.phase); },
		});
		s2.setup();
		s2.submit('A', { dx: 0, dy: 0 });
		s2.submit('B', { dx: 0, dy: 0 });
		expect(phases).toContain('setup');
		expect(phases).toContain('pre-step');
		expect(phases).toContain('post-step');
	}, BOOT_TIMEOUT);
});

describe('SessionOrchestrator dynamic membership (KD-069 → KD-084)', () => {
	it('supports N>2 and adjusts the barrier set when a player is added', () => {
		const s = new SessionOrchestrator({ seed: 'session-orch-N', playerIds: ['A', 'B'] });
		s.setup();
		// A 3rd player joins → the barrier now needs all three.
		s.addPlayer('C');
		expect(s.playerIds.sort()).toEqual(['A', 'B', 'C']);
		expect(s.players.get('C').getServerRole()).toBe('player');

		const t0 = s.ticks();
		expect(s.submit('A', { dx: 0, dy: 0 }).advanced).toBe(false);
		expect(s.submit('B', { dx: 0, dy: 0 }).advanced).toBe(false); // C still missing
		expect(s.ticks().world).toBe(t0.world);
		const r = s.submit('C', { dx: 0, dy: 0 });
		expect(r.advanced).toBe(true);
		expect(s.lockstep()).toBe(true);
		expect(s.ticks().world).toBe(t0.world + 1);
	}, BOOT_TIMEOUT);
});
