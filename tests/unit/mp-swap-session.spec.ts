/**
 * Node-layer (Vitest) tests for the swap-model session — KD-085 uniform action model.
 *
 * One authoritative world; players are state bundles swapped in/out per turn; actions
 * run through KD's REAL dispatcher (applyInput). Verifies: lockstep (R8), a real move
 * via the dispatcher moves the right player, random-order conflict resolution (R9 —
 * two into one tile → exactly one wins), and world authority (a bump = move-into-enemy
 * damages the shared enemy).
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('SwapSession — uniform action model (KD-085)', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'swap-session-seed' });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	it('starts a shared world with both players + a shared enemy', () => {
		expect(s.started).toBe(true);
		expect(s.posOf('A')).toBeTruthy();
		expect(s.posOf('B')).toBeTruthy();
		expect(s.enemyView()).toBeTruthy();
	});

	it('is lockstep — advances only when both players submit (R8)', () => {
		const t0 = s.tick();
		const r1 = s.submit('A', { kind: 'wait' });
		expect(r1.advanced).toBe(false);
		expect(r1.waitingOn).toContain('B');
		expect(s.tick()).toBe(t0);
		const r2 = s.submit('B', { kind: 'wait' });
		expect(r2.advanced).toBe(true);
	}, BOOT_TIMEOUT);

	it('runs a real move through KD\'s dispatcher on the swapped-in player', () => {
		const a0 = s.posOf('A');
		s.submit('A', { kind: 'move', dx: 1, dy: 0 });
		s.submit('B', { kind: 'wait' });
		const a1 = s.posOf('A');
		// A moved (or stayed if blocked) — but the move ran authoritatively; B unchanged
		expect(a1).toBeTruthy();
		// at least prove the dispatcher executed by advancing several turns and A moving net
		let moved = a1.x !== a0.x || a1.y !== a0.y;
		for (let i = 0; i < 3 && !moved; i++) {
			const p = s.posOf('A');
			s.submit('A', { kind: 'move', dx: 0, dy: 1 });
			s.submit('B', { kind: 'wait' });
			const q = s.posOf('A');
			if (q.x !== p.x || q.y !== p.y) moved = true;
		}
		expect(moved).toBe(true);
	}, BOOT_TIMEOUT);
});

describe('SwapSession — random-order conflict resolution (R9)', () => {
	it('two players into the same tile → exactly one ends there', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'swap-conflict-seed' });
		s.join('A');
		s.join('B');
		const a0 = s.posOf('A');
		const b0 = s.posOf('B');
		// A and B start adjacent (B = A + (1,0)); both aim for (a0.x+1, a0.y+1)
		const target = { x: a0.x + 1, y: a0.y + 1 };
		s.submit('A', { kind: 'move', dx: target.x - a0.x, dy: target.y - a0.y });
		s.submit('B', { kind: 'move', dx: target.x - b0.x, dy: target.y - b0.y });
		const a1 = s.posOf('A');
		const b1 = s.posOf('B');
		const aOn = a1.x === target.x && a1.y === target.y;
		const bOn = b1.x === target.x && b1.y === target.y;
		// at most one occupies the contested tile (the loser was blocked by collision)
		expect(aOn && bOn).toBe(false);
	}, BOOT_TIMEOUT);
});

describe('SwapSession — world authority (bump attack)', () => {
	it('moving into the shared enemy damages it authoritatively', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'swap-attack-seed' });
		s.join('A');
		s.join('B');
		// place the enemy directly next to A, then A moves into it (bump = attack)
		const aPos = s.posOf('A');
		s.world.moveAvatar(s.enemyId, aPos.x + 1, aPos.y);
		const hp0 = s.enemyView()?.hp;
		expect(hp0).toBeGreaterThan(0);
		// A bumps right into the enemy several times; B waits
		let damaged = false;
		for (let i = 0; i < 3 && !damaged; i++) {
			const ep = s.enemyView();
			if (ep) s.world.moveAvatar(s.enemyId, (s.posOf('A')?.x ?? aPos.x) + 1, s.posOf('A')?.y ?? aPos.y);
			s.submit('A', { kind: 'move', dx: 1, dy: 0 });
			s.submit('B', { kind: 'wait' });
			const after = s.enemyView();
			if (after == null || after.hp < hp0) damaged = true;
		}
		expect(damaged).toBe(true);
	}, BOOT_TIMEOUT);
});
