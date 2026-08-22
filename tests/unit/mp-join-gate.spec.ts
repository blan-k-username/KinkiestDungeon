/**
 * KDM-233 — the join gate (`tools/mp-server/join-gate.js`), on its own.
 *
 * WHO IS IN THE SESSION AND WHO IS STILL ASKING. This is the pure half of "host a game and let a
 * friend join": slot ownership, the pending request, and what each of the host's two answers does.
 * No socket, no world, no game globals — same call as `peace.js` (architecture R1), so every rule
 * below is checked in milliseconds instead of behind a ~30 s session boot.
 *
 * The rules here are the ones that are easy to get subtly wrong: a declined guest that still holds a
 * slot, a second request that silently displaces the first, a build mismatch the host is asked to
 * approve anyway.
 *
 * Requirement ids refer to the `## Requirements (EARS)` section of KDM-233.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JoinGate } = require('../../tools/mp-server/join-gate');

const BUILD = 'kd-5.5.0-abc123';

describe('KDM-233 — JoinGate', () => {
	let g: any;
	beforeEach(() => { g = new JoinGate({ build: BUILD }); });

	describe('hosting (U2, S1)', () => {
		it('starts with nobody hosting and nobody pending', () => {
			expect(g.host).toBe(null);
			expect(g.guest).toBe(null);
			expect(g.pending).toBe(null);
			expect(g.players()).toEqual([]);
		});

		it('the first claim takes slot 0 and is the host', () => {
			const r = g.claimHost('H');
			expect(r.accept).toBe(true);
			expect(r.slot).toBe(0);
			expect(g.host).toBe('H');
			expect(g.players()).toEqual(['H']);
		});

		it('refuses a second host rather than silently re-seating the first', () => {
			g.claimHost('H');
			const r = g.claimHost('OTHER');
			expect(r.accept).toBe(false);
			expect(r.reason).toBe('already_hosting');
			expect(g.host, 'the sitting host is untouched').toBe('H');
		});

		it('is idempotent for the SAME host reclaiming (a reload must not lose the session)', () => {
			g.claimHost('H');
			const r = g.claimHost('H');
			expect(r.accept).toBe(true);
			expect(r.slot).toBe(0);
			expect(g.host).toBe('H');
		});
	});

	describe('a join request parks as pending — it does NOT take a slot (E1)', () => {
		beforeEach(() => { g.claimHost('H'); });

		it('parks the request, naming the requester, without seating them', () => {
			const r = g.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(r.accept, 'not admitted yet — the host has not answered').toBe(false);
			expect(r.pending).toBe(true);
			expect(g.pending).toMatchObject({ clientId: 'G', name: 'Ada' });
			expect(g.guest, 'no slot taken while pending').toBe(null);
			expect(g.players(), 'a pending guest is not a player').toEqual(['H']);
		});

		it('refuses a request when nobody is hosting', () => {
			const empty = new JoinGate({ build: BUILD });
			const r = empty.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(r.accept).toBe(false);
			expect(r.reason).toBe('no_host');
			expect(empty.pending).toBe(null);
		});

		it('carries the requester NAME to the host — with approval-only, it is all the host can judge', () => {
			g.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(g.pending.name).toBe('Ada');
		});
	});

	describe('the host answers (E2, E3)', () => {
		beforeEach(() => {
			g.claimHost('H');
			g.requestJoin('G', { name: 'Ada', build: BUILD });
		});

		it('accept seats the guest in slot 1 and clears the pending request', () => {
			const r = g.accept();
			expect(r.admitted).toBe(true);
			expect(r.clientId).toBe('G');
			expect(r.slot).toBe(1);
			expect(g.guest).toBe('G');
			expect(g.pending).toBe(null);
			expect(g.players()).toEqual(['H', 'G']);
		});

		it('decline refuses the guest, states a reason, and leaves the host untouched', () => {
			const r = g.decline();
			expect(r.admitted).toBe(false);
			expect(r.clientId).toBe('G');
			expect(r.reason).toBe('declined');
			expect(g.guest, 'no slot taken by a declined guest').toBe(null);
			expect(g.pending).toBe(null);
			expect(g.host, 'the host is untouched (E3)').toBe('H');
			expect(g.players()).toEqual(['H']);
		});

		it('answering twice is refused — an answer consumes the request', () => {
			g.accept();
			const again = g.accept();
			expect(again.admitted).toBe(false);
			expect(again.reason).toBe('not_pending');
		});

		it('answering with nothing pending is refused, not a crash', () => {
			g.decline();
			expect(g.decline()).toMatchObject({ admitted: false, reason: 'not_pending' });
		});

		it('a DECLINED guest may ask again — decline is not a ban', () => {
			g.decline();
			const r = g.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(r.pending).toBe(true);
			expect(g.pending.clientId).toBe('G');
		});
	});

	describe('one question at a time (E7)', () => {
		beforeEach(() => {
			g.claimHost('H');
			g.requestJoin('G', { name: 'Ada', build: BUILD });
		});

		it('refuses a SECOND request while one is pending, rather than queueing or displacing it', () => {
			const r = g.requestJoin('G2', { name: 'Bob', build: BUILD });
			expect(r.accept).toBe(false);
			expect(r.reason).toBe('busy');
			expect(g.pending.clientId, 'the first request still owns the dialogue').toBe('G');
			expect(g.pending.name).toBe('Ada');
		});

		it('the same guest re-asking while pending is a no-op, not a "busy" refusal', () => {
			const r = g.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(r.pending).toBe(true);
			expect(g.pending.clientId).toBe('G');
		});
	});

	describe('the session is full at two (E5)', () => {
		beforeEach(() => {
			g.claimHost('H');
			g.requestJoin('G', { name: 'Ada', build: BUILD });
			g.accept();
		});

		it('refuses a third participant outright — it never reaches the host', () => {
			const r = g.requestJoin('G3', { name: 'Cy', build: BUILD });
			expect(r.accept).toBe(false);
			expect(r.reason).toBe('session_full');
			expect(g.pending, 'the host is not asked about a request that cannot be honoured').toBe(null);
		});

		it('refuses a third host claim too', () => {
			expect(g.claimHost('X')).toMatchObject({ accept: false, reason: 'already_hosting' });
		});
	});

	describe('build mismatch is refused BEFORE the host is prompted (N1)', () => {
		beforeEach(() => { g.claimHost('H'); });

		it('refuses a differing build and does NOT park it as pending', () => {
			const r = g.requestJoin('G', { name: 'Ada', build: 'kd-5.4.0-zzz' });
			expect(r.accept).toBe(false);
			expect(r.reason).toBe('build_mismatch');
			expect(g.pending, 'the host is never asked to approve a pairing that cannot work').toBe(null);
		});

		it('reports both builds so the guest can be told WHICH side is behind', () => {
			const r = g.requestJoin('G', { name: 'Ada', build: 'kd-5.4.0-zzz' });
			expect(r.hostBuild).toBe(BUILD);
			expect(r.guestBuild).toBe('kd-5.4.0-zzz');
		});

		it('a matching build is parked normally — the control for the case above', () => {
			const r = g.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(r.pending).toBe(true);
			expect(g.pending.clientId).toBe('G');
		});

		it('a missing build is treated as a mismatch, not as a wildcard', () => {
			expect(g.requestJoin('G', { name: 'Ada' })).toMatchObject({ reason: 'build_mismatch' });
		});
	});

	describe('leaving frees the seat', () => {
		beforeEach(() => {
			g.claimHost('H');
			g.requestJoin('G', { name: 'Ada', build: BUILD });
			g.accept();
		});

		it('a guest who leaves frees slot 1 for someone else to ask', () => {
			g.release('G');
			expect(g.guest).toBe(null);
			expect(g.players()).toEqual(['H']);
			expect(g.requestJoin('G3', { name: 'Cy', build: BUILD }).pending).toBe(true);
		});

		it('the host leaving empties the session — a guest cannot inherit the host seat', () => {
			g.release('H');
			expect(g.host, 'no promotion: the world lives in the host process (KDM-244 C1/C3)').toBe(null);
			expect(g.guest).toBe('G');
			expect(g.requestJoin('G3', { name: 'Cy', build: BUILD })).toMatchObject({ reason: 'no_host' });
		});

		it('releasing an unknown id changes nothing', () => {
			g.release('NOBODY');
			expect(g.players()).toEqual(['H', 'G']);
		});

		it('releasing a PENDING requester withdraws the question', () => {
			g.release('G');
			g.requestJoin('G3', { name: 'Cy', build: BUILD });
			expect(g.pending.clientId).toBe('G3');
			g.release('G3');
			expect(g.pending, 'a requester who dropped is no longer asking').toBe(null);
		});
	});

	describe('membership', () => {
		it('knows who is in the session and who is not', () => {
			g.claimHost('H');
			expect(g.has('H')).toBe(true);
			expect(g.has('G')).toBe(false);
			g.requestJoin('G', { name: 'Ada', build: BUILD });
			expect(g.has('G'), 'pending is not membership').toBe(false);
			g.accept();
			expect(g.has('G')).toBe(true);
		});

		it('reports the slot of a member, and nothing for a stranger', () => {
			g.claimHost('H');
			g.requestJoin('G', { name: 'Ada', build: BUILD });
			g.accept();
			expect(g.slotOf('H')).toBe(0);
			expect(g.slotOf('G')).toBe(1);
			expect(g.slotOf('NOBODY')).toBe(null);
		});
	});
});

/**
 * The host defines the build the session runs at — "HOST is source of truth" (owner, 2026-08-22).
 *
 * These cover the two ways the gate can be constructed: told its build up front, or learning it from
 * whoever claims the host seat. The second is what makes N1 work without the operator configuring
 * anything, and the "unset" case is the one that could silently disable the check.
 */
describe('KDM-233 — JoinGate build ownership', () => {
	it('adopts the HOST\'s build when it was not told one, and enforces it from then on', () => {
		const g = new JoinGate({});
		g.claimHost('H', { build: 'kd-9.9.9' });
		expect(g.build).toBe('kd-9.9.9');
		expect(g.requestJoin('G', { name: 'Ada', build: 'kd-9.9.9' }).pending).toBe(true);
		g.decline();
		expect(g.requestJoin('G', { name: 'Ada', build: 'other' })).toMatchObject({ reason: 'build_mismatch' });
	});

	it('does NOT let a guest redefine the build the host already set', () => {
		const g = new JoinGate({ build: 'kd-1.0.0' });
		g.claimHost('H', { build: 'kd-2.0.0' });
		expect(g.build, 'an explicit build wins over a claim').toBe('kd-1.0.0');
	});

	it('skips the check entirely when NOBODY knows the build — and that is visible, not silent', () => {
		const g = new JoinGate({});
		g.claimHost('H');                       // no build offered anywhere
		expect(g.build).toBe('');
		const r = g.requestJoin('G', { name: 'Ada' });
		expect(r.pending, 'an unknowable build cannot be a mismatch').toBe(true);
		expect(g.buildCheckActive(), 'the spec above is only safe because this says so').toBe(false);
	});

	it('reports the check as active once a build is known — the control for the case above', () => {
		const g = new JoinGate({ build: 'kd-1.0.0' });
		expect(g.buildCheckActive()).toBe(true);
	});
});
