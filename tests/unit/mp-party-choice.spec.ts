/**
 * KDM-242 A1 — the propose/confirm state machine, extracted so it exists ONCE.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────────
 * KDM-263 built "either player proposes, the other agrees" for the journey route. KDM-242 needs the
 * identical rules for the perk card. The task's own Notes call that out as a DRY obligation: build the
 * arbitration once and reuse it, or say why not. `PartyChoice` is the once — five hooks (`isValid`,
 * `sameAs`, `commit`, `uncommit`, `announce`) are all that differed between the two.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. Every rule is asserted through its OBSERVABLE EFFECT — the recorded `commit`/`uncommit`/
 *     `announce` calls — not through the internal `pending`/`proposer` fields. A state machine that
 *     tracked its fields correctly and never committed would pass a field-only check.
 *  2. The disagreement rule (R7) is asserted as "the proposal MOVED", not merely "nothing committed".
 *     Refusing the second player's pick outright also commits nothing, and that is the soft-lock this
 *     rule exists to prevent — so the proposer identity is checked too.
 *  3. `seats` is read through a FUNCTION rather than frozen at construction, because the solo rule
 *     (R8) has to answer correctly for a party that has just lost a player mid-negotiation.
 *  4. The idempotence case (re-picking your own pending) is paired with a CONTROL that the same input
 *     from the OTHER player does commit — otherwise "nothing happened" is indistinguishable from a
 *     machine that ignores every second input.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { PartyChoice } = require('../../tools/mp-server/party-choice');

type Ev = { kind: string; choice: any; by: string | null };

/** A choice type with structure, so `sameAs` is doing real work rather than `===` on a primitive. */
const ONE = { id: 1 };
const TWO = { id: 2 };
const BAD = { id: 99 };

function make(seatCount = 2) {
	const events: Ev[] = [];
	let seats = seatCount;
	const pc = new PartyChoice({
		label: 'TEST',
		seats: () => seats,
		isValid: (c: any) => !!c && (c.id === 1 || c.id === 2),
		sameAs: (a: any, b: any) => !!a && !!b && a.id === b.id,
		commit: (c: any, by: string) => { events.push({ kind: 'commit', choice: c, by }); },
		uncommit: () => { events.push({ kind: 'uncommit', choice: null, by: null }); },
		announce: (kind: string, c: any, by: string | null) => { events.push({ kind: 'announce:' + kind, choice: c, by }); },
	});
	return {
		pc, events,
		setSeats: (n: number) => { seats = n; },
		commits: () => events.filter((e) => e.kind === 'commit'),
		uncommits: () => events.filter((e) => e.kind === 'uncommit'),
	};
}

describe('KDM-242 A1 — PartyChoice', () => {
	let t: ReturnType<typeof make>;
	beforeEach(() => { t = make(2); });

	describe('validity — one refusal path, and it is the caller\'s', () => {
		it('an invalid choice is dropped: nothing pending, nothing committed, nothing announced', () => {
			expect(t.pc.propose('A', BAD)).toBe(false);
			expect(t.pc.report().pending, 'an invalid pick must not become the pending proposal').toBe(null);
			expect(t.events, 'and it must not announce — KD\'s own refusal is the only one').toEqual([]);
		});

		it('CONTROL: the same call with a VALID choice does land, so the check above is not vacuous', () => {
			expect(t.pc.propose('A', ONE)).toBe(true);
			expect(t.pc.report().pending).toEqual(ONE);
		});
	});

	describe('R4/R5 — one pending proposal, and who made it', () => {
		it('a first pick is PROPOSED, not committed, and both players are told', () => {
			t.pc.propose('A', ONE);
			expect(t.commits(), 'one player must not decide for the party').toEqual([]);
			expect(t.pc.report()).toEqual({ pending: ONE, proposer: 'A' });
			expect(t.events.map((e) => e.kind)).toEqual(['announce:proposed']);
			expect(t.events[0].by, 'the announcement must name the proposer, or the partner cannot answer it').toBe('A');
		});

		it('re-picking your OWN pending proposal changes nothing and re-announces nothing', () => {
			t.pc.propose('A', ONE);
			const before = t.events.length;
			expect(t.pc.propose('A', ONE)).toBe(true);
			expect(t.events.length, 'a repeat of your own pick is not news').toBe(before);
			expect(t.commits(), 'and it certainly is not agreement with yourself').toEqual([]);
		});

		it('CONTROL: the SAME choice from the OTHER player DOES commit — so the case above is a rule, not a dead input', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', ONE);
			expect(t.commits().length).toBe(1);
		});
	});

	describe('R6 — agreement commits', () => {
		it('the other player picking the same choice commits it, and clears the negotiation', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', ONE);
			expect(t.commits()).toEqual([{ kind: 'commit', choice: ONE, by: 'B' }]);
			expect(t.pc.report(), 'a committed choice is no longer pending').toEqual({ pending: null, proposer: null });
			expect(t.events.map((e) => e.kind)).toEqual(['announce:proposed', 'commit', 'announce:committed']);
		});

		it('the commit fires BEFORE its announcement — a player told the party agreed must find it true', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', ONE);
			const kinds = t.events.map((e) => e.kind);
			expect(kinds.indexOf('commit')).toBeLessThan(kinds.indexOf('announce:committed'));
		});
	});

	describe('R7 — disagreement RE-OPENS, it does not deadlock', () => {
		it('a different pick from the other player replaces the proposal AND flips the proposer', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', TWO);
			expect(t.commits(), 'disagreement is not agreement').toEqual([]);
			expect(t.pc.report(), 'the question must MOVE — refusing B\'s pick is the soft-lock this rule prevents')
				.toEqual({ pending: TWO, proposer: 'B' });
		});

		it('…so A can now agree to B\'s choice, and the party is never stuck', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', TWO);
			t.pc.propose('A', TWO);
			expect(t.commits()).toEqual([{ kind: 'commit', choice: TWO, by: 'A' }]);
		});

		it('a proposal after a COMMIT re-opens it and un-commits — the party has not left yet', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', ONE);
			t.pc.propose('A', TWO);
			expect(t.uncommits().length, 'a re-opened question must not leave the old answer armed').toBe(1);
			expect(t.pc.report()).toEqual({ pending: TWO, proposer: 'A' });
		});
	});

	describe('R8 — one seat is stock KD', () => {
		it('a solo player\'s pick IS the decision: no proposal step, no confirmation', () => {
			t.setSeats(1);
			t.pc.propose('A', ONE);
			expect(t.commits()).toEqual([{ kind: 'commit', choice: ONE, by: 'A' }]);
			expect(t.events.map((e) => e.kind), 'a solo run must never see "waiting for your partner"')
				.toEqual(['commit', 'announce:committed']);
		});

		it('seats are read LIVE, so a partner dropping mid-negotiation unblocks the survivor', () => {
			t.pc.propose('A', ONE);
			expect(t.commits()).toEqual([]);
			t.setSeats(1);
			t.pc.propose('A', TWO);
			expect(t.commits(), 'the survivor must not be stuck waiting for a player who has gone')
				.toEqual([{ kind: 'commit', choice: TWO, by: 'A' }]);
		});
	});

	describe('reset — the question dies with its context', () => {
		it('reset drops a pending proposal without committing or un-committing it', () => {
			t.pc.propose('A', ONE);
			const before = t.events.length;
			t.pc.reset();
			expect(t.pc.report()).toEqual({ pending: null, proposer: null });
			expect(t.commits()).toEqual([]);
			expect(t.events.length, 'dropping an unanswered question is not an event the players need')
				.toBe(before);
		});

		it('reset with nothing pending is a no-op', () => {
			t.pc.reset();
			expect(t.events).toEqual([]);
		});
	});

	describe('the report is a COPY — a caller cannot edit what the session believes', () => {
		it('mutating the report does not move the pending proposal', () => {
			t.pc.propose('A', ONE);
			const r: any = t.pc.report();
			r.pending.id = 42;
			r.proposer = 'Z';
			expect(t.pc.report()).toEqual({ pending: ONE, proposer: 'A' });
		});
	});

	describe('reset also forgets that a choice was COMMITTED', () => {
		it('a fresh proposal on a new map does not un-commit an answer from the old one', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', ONE);           // committed on the old map
			t.pc.reset();                      // the party moved
			const before = t.uncommits().length;
			t.pc.propose('A', TWO);            // first pick in the NEW context
			expect(t.uncommits().length,
				'uncommit writes the WORLD; firing it for a decision that belongs to a map the party '
				+ 'has already left is a spurious write, not a safe no-op').toBe(before);
		});

		it('CONTROL: without a reset, the same sequence DOES un-commit — so the case above is a rule', () => {
			t.pc.propose('A', ONE);
			t.pc.propose('B', ONE);
			const before = t.uncommits().length;
			t.pc.propose('A', TWO);
			expect(t.uncommits().length).toBe(before + 1);
		});
	});
});
