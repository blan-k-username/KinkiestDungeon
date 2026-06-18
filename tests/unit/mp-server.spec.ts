/**
 * Unit tests for tools/mp-server.js.
 *
 * Tests the pure protocol-handler functions in isolation (no sockets, no
 * actual server boot). The functions are exported when `require.main !==
 * module`, which is exactly what Vitest does.
 *
 * What we cover here:
 *   - Two-player turn-batching: both submit → broadcast contains both, in
 *     deterministic playerId order, and `currentTurn` advances.
 *   - Single submission keeps the server waiting (returns null).
 *   - Wrong-turn / duplicate-submission errors are reported back to sender.
 *   - State-hash exchange: matching → silent; mismatching → desync broadcast.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mp = require('../../tools/mp-server.js');

describe('handleAction — turn batching', () => {
	let session: any;
	beforeEach(() => {
		session = mp.createSession();
	});

	it('returns null when only one player has submitted', () => {
		const out = mp.handleAction(session, 0, { type: 'action', turn: 1, action: { type: 'move' } });
		expect(out).toBeNull();
		expect(session.pendingActions[0]).toEqual({ type: 'move' });
		expect(session.pendingActions[1]).toBeNull();
		expect(session.currentTurn).toBe(1);
	});

	it('returns a broadcast once both players have submitted, with playerId-ordered actions', () => {
		mp.handleAction(session, 1, { type: 'action', turn: 1, action: { type: 'wait' } });
		const out = mp.handleAction(session, 0, { type: 'action', turn: 1, action: { type: 'move' } });
		expect(out).not.toBeNull();
		expect(out.kind).toBe('broadcast');
		expect(out.message.type).toBe('turn');
		expect(out.message.turn).toBe(1);
		expect(out.message.actions).toEqual([
			{ playerId: 0, action: { type: 'move' } },
			{ playerId: 1, action: { type: 'wait' } },
		]);
	});

	it('advances currentTurn and clears pending after broadcasting', () => {
		mp.handleAction(session, 0, { type: 'action', turn: 1, action: 'a' });
		mp.handleAction(session, 1, { type: 'action', turn: 1, action: 'b' });
		expect(session.currentTurn).toBe(2);
		expect(session.pendingActions).toEqual([null, null]);
	});

	it('rejects a submission for the wrong turn with `wrong_turn` and does not mutate state', () => {
		const out = mp.handleAction(session, 0, { type: 'action', turn: 5, action: {} });
		expect(out.kind).toBe('reply');
		expect(out.message.type).toBe('error');
		expect(out.message.code).toBe('wrong_turn');
		expect(out.message.expected).toBe(1);
		expect(session.pendingActions[0]).toBeNull();
	});

	it('rejects a duplicate submission with `duplicate_submission` and keeps the original', () => {
		mp.handleAction(session, 0, { type: 'action', turn: 1, action: 'first' });
		const out = mp.handleAction(session, 0, { type: 'action', turn: 1, action: 'second' });
		expect(out.kind).toBe('reply');
		expect(out.message.code).toBe('duplicate_submission');
		expect(session.pendingActions[0]).toBe('first');
	});
});

describe('parseConnectIntent — connect URL classification', () => {
	const intent = (u: string) => mp.parseConnectIntent(new URL(u, 'http://x'));

	it('classifies ?role=host as a host claim', () => {
		expect(intent('/mp?role=host')).toEqual({ kind: 'host' });
	});

	it('classifies ?code=NNNN as a guest join carrying the code', () => {
		expect(intent('/mp?code=1234')).toEqual({ kind: 'guest', code: '1234' });
	});

	it('classifies ?session=&player= as a code-free rejoin', () => {
		expect(intent('/mp?session=abc&player=1')).toEqual({ kind: 'rejoin', session: 'abc', player: 1 });
	});

	it('classifies a bare /mp (no credentials) as invalid', () => {
		expect(intent('/mp')).toEqual({ kind: 'invalid' });
	});
});

describe('mintJoinCode — 4-digit code', () => {
	it('always returns a 4-character numeric string', () => {
		for (let i = 0; i < 50; i++) {
			expect(mp.mintJoinCode()).toMatch(/^\d{4}$/);
		}
	});
});

describe('evaluateConnect — slot assignment + reject reasons', () => {
	let session: any;
	beforeEach(() => {
		session = mp.createSession();
	});

	it('admits a host to slot 0 on a fresh session and flags code minting', () => {
		const out = mp.evaluateConnect(session, { kind: 'host' });
		expect(out).toMatchObject({ accept: true, slot: 0, host: true });
	});

	it('rejects a second host with already_hosting', () => {
		session.clients[0] = {};
		const out = mp.evaluateConnect(session, { kind: 'host' });
		expect(out).toEqual({ reject: true, reason: 'already_hosting' });
	});

	it('admits a guest to slot 1 when the code matches while the host waits', () => {
		session.clients[0] = {};
		session.joinCode = '1234';
		const out = mp.evaluateConnect(session, { kind: 'guest', code: '1234' });
		expect(out).toMatchObject({ accept: true, slot: 1 });
	});

	it('rejects a wrong code with bad_code', () => {
		session.clients[0] = {};
		session.joinCode = '1234';
		const out = mp.evaluateConnect(session, { kind: 'guest', code: '0000' });
		expect(out).toEqual({ reject: true, reason: 'bad_code' });
	});

	it('rejects a guest when no host is waiting with not_waiting', () => {
		const out = mp.evaluateConnect(session, { kind: 'guest', code: '1234' });
		expect(out).toEqual({ reject: true, reason: 'not_waiting' });
	});

	it('rejects a guest when slot 1 is already filled with slot_taken', () => {
		session.clients[0] = {};
		session.clients[1] = {};
		const out = mp.evaluateConnect(session, { kind: 'guest', code: '1234' });
		expect(out).toEqual({ reject: true, reason: 'slot_taken' });
	});

	it('rejects a credential-less connect with missing_credentials', () => {
		const out = mp.evaluateConnect(session, { kind: 'invalid' });
		expect(out).toEqual({ reject: true, reason: 'missing_credentials' });
	});

	it('admits a rejoin to its own free slot without a code', () => {
		session.clients[0] = {};
		const out = mp.evaluateConnect(session, { kind: 'rejoin', session: session.id, player: 1 });
		expect(out).toMatchObject({ accept: true, slot: 1 });
	});

	it('rejects a rejoin for a stale session id with session_gone', () => {
		const out = mp.evaluateConnect(session, { kind: 'rejoin', session: 'nope', player: 0 });
		expect(out).toEqual({ reject: true, reason: 'session_gone' });
	});

	it('rejects a rejoin into an occupied slot with slot_taken', () => {
		session.clients[1] = {};
		const out = mp.evaluateConnect(session, { kind: 'rejoin', session: session.id, player: 1 });
		expect(out).toEqual({ reject: true, reason: 'slot_taken' });
	});
});

describe('evaluateConnect — brute-force lock-out', () => {
	let session: any;
	beforeEach(() => {
		session = mp.createSession();
		session.clients[0] = {};      // a host is waiting
		session.joinCode = '1234';
	});

	it('counts failed bad_code attempts on the session', () => {
		mp.evaluateConnect(session, { kind: 'guest', code: '0000' }, 1000);
		mp.evaluateConnect(session, { kind: 'guest', code: '0001' }, 1000);
		expect(session.failedAttempts).toBe(2);
	});

	it('still returns bad_code below the threshold', () => {
		for (let i = 0; i < 4; i++) {
			const out = mp.evaluateConnect(session, { kind: 'guest', code: '0000' }, 1000);
			expect(out).toEqual({ reject: true, reason: 'bad_code' });
		}
		expect(session.lockedUntil).toBe(0);
	});

	it('flips to locked_out once the threshold (5) is reached and sets a cooldown', () => {
		let out;
		for (let i = 0; i < 5; i++) {
			out = mp.evaluateConnect(session, { kind: 'guest', code: '0000' }, 1000);
		}
		expect(out).toEqual({ reject: true, reason: 'locked_out' });
		expect(session.lockedUntil).toBeGreaterThan(1000);
	});

	it('rejects even a correct code while locked out', () => {
		for (let i = 0; i < 5; i++) mp.evaluateConnect(session, { kind: 'guest', code: '0000' }, 1000);
		const out = mp.evaluateConnect(session, { kind: 'guest', code: '1234' }, 2000); // within cooldown
		expect(out).toEqual({ reject: true, reason: 'locked_out' });
	});

	it('admits a correct code again once the cooldown has elapsed', () => {
		for (let i = 0; i < 5; i++) mp.evaluateConnect(session, { kind: 'guest', code: '0000' }, 1000);
		const lockedUntil = session.lockedUntil;
		const out = mp.evaluateConnect(session, { kind: 'guest', code: '1234' }, lockedUntil + 1);
		expect(out).toMatchObject({ accept: true, slot: 1 });
		expect(session.failedAttempts).toBe(0);   // counter reset on success
	});

	it('resets the lock-out when a new host claims the session', () => {
		for (let i = 0; i < 5; i++) mp.evaluateConnect(session, { kind: 'guest', code: '0000' }, 1000);
		expect(session.lockedUntil).toBeGreaterThan(0);
		session.clients[0] = null;                 // prior host left
		const out = mp.evaluateConnect(session, { kind: 'host' }, 5000);
		expect(out).toMatchObject({ accept: true, slot: 0, host: true });
		expect(session.failedAttempts).toBe(0);
		expect(session.lockedUntil).toBe(0);
	});
});

describe('handleStateHash — desync detection', () => {
	let session: any;
	beforeEach(() => {
		session = mp.createSession();
	});

	it('emits nothing when only one client has submitted a hash', () => {
		const out = mp.handleStateHash(session, 0, { type: 'state_hash', turn: 1, hash: 'abc' });
		expect(out).toBeNull();
	});

	it('emits nothing when both hashes match', () => {
		mp.handleStateHash(session, 0, { type: 'state_hash', turn: 1, hash: 'abc' });
		const out = mp.handleStateHash(session, 1, { type: 'state_hash', turn: 1, hash: 'abc' });
		expect(out).toBeNull();
	});

	it('broadcasts a `desync` message when hashes differ', () => {
		mp.handleStateHash(session, 0, { type: 'state_hash', turn: 1, hash: 'abc' });
		const out = mp.handleStateHash(session, 1, { type: 'state_hash', turn: 1, hash: 'def' });
		expect(out).not.toBeNull();
		expect(out.kind).toBe('broadcast');
		expect(out.message.type).toBe('desync');
		expect(out.message.turn).toBe(1);
		expect(out.message.hashes).toEqual({ 0: 'abc', 1: 'def' });
	});

	it('only compares hashes for the same turn — out-of-order is ignored', () => {
		mp.handleStateHash(session, 0, { type: 'state_hash', turn: 1, hash: 'a' });
		const out = mp.handleStateHash(session, 1, { type: 'state_hash', turn: 2, hash: 'b' });
		expect(out).toBeNull();
	});
});
