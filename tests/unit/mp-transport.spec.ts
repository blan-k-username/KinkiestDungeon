/**
 * Node-layer (Vitest) tests for the KD-081 transport boundary.
 *
 * Runs the SAME orchestrator + reconciler (mp-session.js) over each pluggable
 * transport and asserts the four KD-079 acceptance criteria still hold when the
 * world and players are driven ONLY by serialized messages — plus
 * boundary-specific checks (JSON-only payloads; separate OS process for socket).
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MPSession } = require('../../tools/mp-server/mp-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { factory } = require('../../tools/mp-server/transport');

const BOOT_TIMEOUT = 240_000;

// Transports under test. Worker + socket are added as they are implemented.
const TRANSPORTS_UNDER_TEST = ['in-process', 'worker', 'socket'];

const MOVES = [
	{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
	{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
	{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
	{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
];

for (const name of TRANSPORTS_UNDER_TEST) {
	describe(`MP transport boundary: ${name}`, () => {
		let session: any;
		let firstTurn: any;

		beforeAll(async () => {
			session = new MPSession(factory(name), { seed: 'kd-poc-seed' });
			await session.setup();
			firstTurn = await session.submitMove('A', MOVES[0].A);
			await session.submitMove('B', MOVES[0].B);
			for (let i = 1; i < MOVES.length; i++) {
				await session.submitMove('A', MOVES[i].A);
				await session.submitMove('B', MOVES[i].B);
			}
		}, BOOT_TIMEOUT);

		afterAll(async () => { if (session) await session.close(); });

		it('AC1: a turn does not advance until BOTH players have submitted', () => {
			expect(firstTurn.advanced).toBe(false);
			expect(session.turn).toBe(MOVES.length);
		});

		it('AC1: tick advances in lockstep across all three instances', () => {
			expect(session.history.length).toBe(MOVES.length + 1);
			session.history.forEach((snap: any, i: number) => {
				expect(snap.ticks.world).toBe(snap.ticks.A);
				expect(snap.ticks.A).toBe(snap.ticks.B);
				if (i > 0) expect(snap.ticks.world).toBe(i);
			});
		});

		it('AC2: enemy pos/hp consistent across all three instances each turn', () => {
			for (const snap of session.history) {
				const { world, A, B } = snap.enemyView;
				expect(world).toBeTruthy();
				expect(A).toEqual(world);
				expect(B).toEqual(world);
			}
		});

		it('AC2: the world enemy reacts (moves) under AI during the run', () => {
			const positions = session.history.map((s: any) => `${s.enemyView.world.x},${s.enemyView.world.y}`);
			expect(new Set(positions).size).toBeGreaterThan(1);
		});

		it("AC3: A's move is visible in B's instance next turn (and vice versa)", () => {
			for (let i = 1; i < session.history.length; i++) {
				const snap = session.history[i];
				expect(snap.avatars.AseenByB).toEqual({ x: snap.avatars.A.x, y: snap.avatars.A.y });
				expect(snap.avatars.BseenByA).toEqual({ x: snap.avatars.B.x, y: snap.avatars.B.y });
			}
		});

		it('AC4: player role suppresses enemy AI; world role runs it (every turn)', () => {
			for (const snap of session.history) {
				expect(snap.roles.worldRunsAI).toBe(true);
				expect(snap.roles.ARunsAI).toBe(false);
				expect(snap.roles.BRunsAI).toBe(false);
			}
		});

		it('boundary: messages actually crossed a serialized boundary', () => {
			const s = session.stats();
			expect(s.msgs).toBeGreaterThan(0);
			expect(s.bytes).toBeGreaterThan(0);
		});

		if (name === 'socket') {
			it('boundary: the world instance runs in a SEPARATE OS process', async () => {
				const remote = await session.t.world.request('pid');
				expect(typeof remote.pid).toBe('number');
				expect(remote.pid).not.toBe(process.pid);
			});
		}
	});
}
