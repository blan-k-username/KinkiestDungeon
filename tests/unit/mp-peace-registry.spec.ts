/**
 * KDM-225 — the peace/war relationship machine (`tools/mp-server/peace.js`), on its own.
 *
 * This is the pure half of the feature: who is at war with whom, who owes whom an answer, and what
 * each answer does. It touches no game and boots no world, which is why it lives apart from
 * `swap-session.js` (architecture A1) — every rule below is checked in milliseconds instead of behind
 * a 30-second session boot, and these are the rules that are easiest to get subtly wrong.
 *
 * Requirement ids refer to the `## Requirements (EARS)` section of KDM-225.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PeaceRegistry } = require('../../tools/mp-server/peace');

describe('KDM-225 — PeaceRegistry', () => {
	let r: any;
	beforeEach(() => { r = new PeaceRegistry(); });

	describe('the relationship', () => {
		it('starts at neither war nor peace, and is symmetric in both directions', () => {
			expect(r.atWar('A', 'B')).toBe(false);
			expect(r.atPeace('A', 'B')).toBe(false);
			r.declareWar('A', 'B');
			expect(r.atWar('A', 'B'), 'war A→B').toBe(true);
			expect(r.atWar('B', 'A'), 'war is a PAIR, not a direction').toBe(true);
		});

		it('peace and war are mutually exclusive — accepting a truce ends the war', () => {
			r.declareWar('A', 'B');
			r.offer('A', 'B', 1);
			r.answer('B', true);
			expect(r.atPeace('A', 'B')).toBe(true);
			expect(r.atWar('A', 'B'), 'a pair cannot be at peace AND at war').toBe(false);
		});

		it('a fresh attack after peace puts the pair back at war (R15/AC6)', () => {
			r.declareWar('A', 'B'); r.offer('A', 'B', 1); r.answer('B', true);
			expect(r.atPeace('A', 'B')).toBe(true);
			r.declareWar('A', 'B');
			expect(r.atWar('A', 'B'), 'the door swings both ways').toBe(true);
			expect(r.atPeace('A', 'B'), 'and peace is no longer claimed').toBe(false);
		});
	});

	describe('when the offer entry is available (R1, R2, R3)', () => {
		it('offers are possible only while at war (R1/R2)', () => {
			expect(r.canOffer('A', 'B'), 'R2: nothing to offer when not at war').toBe(false);
			r.declareWar('A', 'B');
			expect(r.canOffer('A', 'B'), 'R1: at war, A may offer').toBe(true);
		});

		it('R3: while an offer is unanswered A cannot offer again — and CAN the moment B answers', () => {
			r.declareWar('A', 'B');
			r.offer('A', 'B', 1);
			expect(r.canOffer('A', 'B'), 'R3: you already asked').toBe(false);
			r.answer('B', false);
			expect(r.canOffer('A', 'B'),
				'R3 is "you already asked", NOT a cooldown (D4) — a decline frees it immediately').toBe(true);
		});
	});

	describe('the handshake (R4, R6, R7, R8)', () => {
		beforeEach(() => { r.declareWar('A', 'B'); });

		it('R4: making an offer changes nothing about the war until it is answered', () => {
			r.offer('A', 'B', 1);
			expect(r.atWar('A', 'B'), 'still at war while the offer is open').toBe(true);
			expect(r.atPeace('A', 'B')).toBe(false);
			expect(r.pendingFor('B'), 'B is the one who owes an answer').toEqual({ from: 'A' });
			expect(r.pendingFor('A'), 'A owes nothing — A asked').toBeNull();
		});

		it('R5 (state half): only the answerer owes an answer', () => {
			r.offer('A', 'B', 1);
			expect(r.owesAnswer('B')).toBe(true);
			expect(r.owesAnswer('A')).toBe(false);
		});

		it('R6: confirming establishes peace and clears the offer', () => {
			r.offer('A', 'B', 1);
			const res = r.answer('B', true);
			expect(res.peace).toBe(true);
			expect(r.atPeace('A', 'B')).toBe(true);
			expect(r.owesAnswer('B'), 'the question is answered').toBe(false);
		});

		it('R7: declining leaves the war exactly as it was', () => {
			r.offer('A', 'B', 1);
			const res = r.answer('B', false);
			expect(res.peace).toBe(false);
			expect(r.atWar('A', 'B'), 'still at war').toBe(true);
			expect(r.atPeace('A', 'B'), 'and NOT at peace').toBe(false);
			expect(r.owesAnswer('B')).toBe(false);
		});

		it('R8: after a decline A may offer again immediately, with no cost and no wait', () => {
			r.offer('A', 'B', 1);
			r.answer('B', false);
			const again = r.offer('A', 'B', 2);
			expect(again.ok, 'D4 — declining is completely free, no cooldown').toBe(true);
			expect(r.pendingFor('B')).toEqual({ from: 'A' });
		});
	});

	describe('unwanted behaviour (R17, R18, R19)', () => {
		beforeEach(() => { r.declareWar('A', 'B'); });

		/**
		 * The failure this forbids is a SPLIT verdict — A believing there is peace while B believes
		 * there is war. Architecture A10 makes it structurally impossible rather than handled: one
		 * offer slot per pair, and a counter-offer read as consent.
		 */
		it('R17: simultaneous offers settle on ONE outcome — a counter-offer is consent', () => {
			r.offer('A', 'B', 1);
			const counter = r.offer('B', 'A', 1);
			expect(counter.accepted, 'both asked for peace in the same turn — that is agreement').toBe(true);
			expect(r.atPeace('A', 'B')).toBe(true);
			expect(r.atWar('A', 'B'), 'no split verdict: not simultaneously at war').toBe(false);
			expect(r.owesAnswer('A'), 'and nobody is left owing an answer').toBe(false);
			expect(r.owesAnswer('B')).toBe(false);
		});

		it('R17: there is never more than one pending offer for a pair', () => {
			r.offer('A', 'B', 1);
			r.offer('A', 'B', 1);
			expect(r.pendingFor('B')).toEqual({ from: 'A' });
			expect(r.pendingFor('A'), 'the second offer created no second slot').toBeNull();
		});

		it('R18: a player leaving discards their offer and unblocks the other side', () => {
			r.offer('A', 'B', 1);
			expect(r.owesAnswer('B')).toBe(true);
			r.forget('A');
			expect(r.owesAnswer('B'), 'B must not stay blocked on a player who is gone').toBe(false);
			expect(r.pendingFor('B')).toBeNull();
		});

		it('R18: the ANSWERER leaving also clears the slot', () => {
			r.offer('A', 'B', 1);
			r.forget('B');
			expect(r.pendingFor('B')).toBeNull();
			expect(r.canOffer('A', 'B'), 'A is not left holding an offer to nobody').toBe(true);
		});

		it('R19: the hub reset discards a pending offer along with the war', () => {
			r.offer('A', 'B', 1);
			r.resetAll();
			expect(r.atWar('A', 'B'), 'R13: everyone is at peace at the hub').toBe(false);
			expect(r.owesAnswer('B'), 'R19: the question is moot, not still open').toBe(false);
			expect(r.pendingFor('B')).toBeNull();
		});
	});
});
