/**
 * Node-layer (Vitest) tests for the PoC orchestrator + turn clock + reconciler —
 * KD-079 (KD-069/KD-070 PoC scope).
 *
 * Drives one world instance + two player instances of the stock bundle through
 * several synchronized turns in one shared scenario, asserting the four
 * acceptance criteria:
 *   AC1  lockstep turn clock — a turn advances only when both players submitted;
 *        KinkyDungeonCurrentTick advances in lockstep across all three.
 *   AC2  the enemy's position/hp is consistent across all three each turn.
 *   AC3  player A's move is visible in player B's instance next turn (and vice versa).
 *   AC4  player role suppresses enemy AI; world role runs it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Orchestrator } = require('../../tools/mp-server/orchestrator');

const BOOT_TIMEOUT = 240_000;

describe('MP server PoC orchestrator', () => {
	let orc: any;
	let firstTurn: any;       // result of the turn where only A had submitted (no advance)

	const MOVES = [
		{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
		{ A: { dx: 1, dy: 0 }, B: { dx: 0, dy: 1 } },
		{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
		{ A: { dx: 0, dy: 1 }, B: { dx: -1, dy: 0 } },
		{ A: { dx: -1, dy: 0 }, B: { dx: 0, dy: -1 } },
	];

	beforeAll(() => {
		orc = new Orchestrator({ seed: 'kd-poc-seed' });
		orc.setup();
		// Capture the "only A submitted" result of turn 1 to assert the turn clock.
		firstTurn = orc.submitMove('A', MOVES[0].A);
		orc.submitMove('B', MOVES[0].B);
		for (let i = 1; i < MOVES.length; i++) {
			orc.submitMove('A', MOVES[i].A);
			orc.submitMove('B', MOVES[i].B);
		}
	}, BOOT_TIMEOUT);

	it('AC1: a turn does not advance until BOTH players have submitted', () => {
		expect(firstTurn.advanced).toBe(false);
		// The matching B submission advanced turn 1, and we ran 5 turns total.
		expect(orc.turn).toBe(MOVES.length);
	});

	it('AC1: KinkyDungeonCurrentTick advances in lockstep across all three instances', () => {
		// One snapshot per turn (history[0] is setup).
		expect(orc.history.length).toBe(MOVES.length + 1);
		orc.history.forEach((snap: any, i: number) => {
			expect(snap.ticks.world).toBe(snap.ticks.A);
			expect(snap.ticks.A).toBe(snap.ticks.B);
			if (i > 0) expect(snap.ticks.world).toBe(i); // turn i → tick i
		});
		const t = orc.ticks();
		expect(t.world).toBe(MOVES.length);
		expect(t.A).toBe(MOVES.length);
		expect(t.B).toBe(MOVES.length);
	});

	it('AC2: the enemy position/hp is consistent across all three instances each turn', () => {
		for (const snap of orc.history) {
			const { world, A, B } = snap.enemyView;
			expect(world).toBeTruthy();
			expect(A).toEqual(world);
			expect(B).toEqual(world);
		}
	});

	it('AC2: the world enemy actually reacts (moves) under AI during the run', () => {
		const positions = orc.history.map((s: any) => `${s.enemyView.world.x},${s.enemyView.world.y}`);
		const distinct = new Set(positions);
		expect(distinct.size).toBeGreaterThan(1);
	});

	it("AC3: player A's move is visible in player B's instance next turn (and vice versa)", () => {
		// Skip setup snapshot; on each turn the reconciler injects each avatar
		// into the other's view.
		for (let i = 1; i < orc.history.length; i++) {
			const snap = orc.history[i];
			expect(snap.avatars.AseenByB).toEqual({ x: snap.avatars.A.x, y: snap.avatars.A.y });
			expect(snap.avatars.BseenByA).toEqual({ x: snap.avatars.B.x, y: snap.avatars.B.y });
		}
	});

	it('AC3: avatars actually move over the run (the visibility is non-trivial)', () => {
		const aPositions = new Set(orc.history.map((s: any) => `${s.avatars.A.x},${s.avatars.A.y}`));
		const bPositions = new Set(orc.history.map((s: any) => `${s.avatars.B.x},${s.avatars.B.y}`));
		expect(aPositions.size).toBeGreaterThan(1);
		expect(bPositions.size).toBeGreaterThan(1);
	});

	it('AC4: player role suppresses enemy AI; world role runs it (every turn)', () => {
		for (const snap of orc.history) {
			expect(snap.roles.worldRunsAI).toBe(true);
			expect(snap.roles.ARunsAI).toBe(false);
			expect(snap.roles.BRunsAI).toBe(false);
		}
	});
});
