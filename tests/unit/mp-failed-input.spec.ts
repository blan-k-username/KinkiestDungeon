/**
 * KDM-268 — a dispatch that throws must not be discarded in silence.
 *
 * `applyInputObserved` catches whatever the input's dispatch throws and hands it back as `obs.error`
 * (`headless-host.js:3067`). On the TURN path that field is read in exactly one place —
 * `_learnInputKind` (`swap-session.js:1125`) — and only as a *"do not learn from this one"* signal:
 *
 *     if (!advanced && (cancelled || o.error)) return;
 *
 * Nothing logs it, nothing records it, nothing sends it. So a player's action can be aborted
 * half-way through and the session reports a perfectly normal turn.
 *
 * THIS IS THE FOURTH MEMBER OF AN EXISTING FAMILY, not a new idea. `unknownInputs` (KDM-163),
 * `replacedInputs` (KDM-163) and `cancelledMoves` (KDM-208) all exist because — in the words of
 * `cancelledMoveReport` — *"from the player's side a cancelled move and an ignored input look
 * identical"*. A thrown dispatch is the same event with a louder cause and none of the treatment.
 *
 * ⚠️ THE THROW IS INJECTED, ON PURPOSE. KDM-267 removed the one real cause we knew of (KD's own
 * autosave, at the tail of `KinkyDungeonDefeat`), so a test that waited for a NATURAL throw would now
 * be asserting on nothing — permanently green, and blind to the next engine bug. `armDispatchThrow`
 * keeps the REPORTING path under test regardless of what produces the exception.
 *
 * ⚠️ REPORTING ONLY (R6). These tests deliberately also assert that the turn still advances and the
 * player keeps a bundle, because this task must not change behaviour while adding visibility.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { armDispatchThrow, armFired } from './helpers/world';

const BOOT_TIMEOUT = 300_000;
const BOOM = 'kdm268 injected dispatch failure';

describe('KDM-268 — a thrown dispatch is recorded, not swallowed', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'failed-input', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

	/** R1 — the record exists, names the right player, and carries the error. */
	it('records the failure against the player whose input threw', () => {
		const turn0 = s.turn;
		armDispatchThrow(s, 'A', BOOM);
		turn();
		expect(armFired(s), 'the injected throw must have fired').toBe(true);

		const failed = s.failedInputReport();
		expect(failed).toHaveLength(1);
		expect(failed[0].clientId).toBe('A');
		expect(failed[0].kdType).toBe('tick');          // what {kind:'wait'} maps to
		expect(String(failed[0].error)).toContain(BOOM);
		// The record carries the turn it happened IN, not the one after it: `this.turn` is
		// incremented at the very end of `_advanceTurn` (`swap-session.js:1512`), and `cancelledMoves`
		// records the same way. Pinned so the family cannot drift into two conventions.
		expect(failed[0].turn).toBe(turn0);
		expect(s.turn).toBe(turn0 + 1);
	}, BOOT_TIMEOUT);

	/** R2 — and it reaches the client, in the snapshot, beside its three siblings. */
	it('puts the failure in the snapshot', () => {
		armDispatchThrow(s, 'A', BOOM);
		turn();
		expect(armFired(s)).toBe(true);

		for (const cid of ['A', 'B']) {
			const snap = s.snapshotFor(cid);
			expect(Array.isArray(snap.failedInputs), `${cid} snapshot carries the list`).toBe(true);
			expect(snap.failedInputs).toHaveLength(1);
			expect(String(snap.failedInputs[0].error)).toContain(BOOM);
		}
	}, BOOT_TIMEOUT);

	/**
	 * CONTROL — a clean turn records nothing.
	 *
	 * Without this, an implementation that recorded on EVERY input would pass both tests above, and
	 * "the failure is reported" would mean nothing (memory `vacuous-oracle-divergence`).
	 */
	it('records nothing when the turn is clean', () => {
		turn();
		expect(s.failedInputReport()).toHaveLength(0);
		expect(s.snapshotFor('A').failedInputs).toHaveLength(0);
	}, BOOT_TIMEOUT);

	/**
	 * R6 — visibility, not behaviour. The turn still resolves and both players stay whole; this task
	 * must not quietly start aborting turns that used to complete.
	 */
	it('changes nothing about how the turn resolves', () => {
		const turn0 = s.turn;
		armDispatchThrow(s, 'A', BOOM);
		expect(() => turn()).not.toThrow();
		expect(armFired(s)).toBe(true);
		expect(s.turn).toBeGreaterThan(turn0);
		for (const cid of ['A', 'B']) {
			expect(s.bundles.get(cid), `${cid} kept a bundle`).toBeTruthy();
			expect(s.posOf(cid), `${cid} kept an avatar`).toBeTruthy();
		}
	}, BOOT_TIMEOUT);

	/**
	 * R1 — bounded like its siblings, so a session that fails every turn cannot grow the list without
	 * limit. Driven at the recorder rather than through 200 real turns: the bound is the property
	 * under test, and booting 200 turns to prove an array cap would be a slow way to test `shift()`.
	 */
	it('bounds the list the same way the other drop reports are bounded', () => {
		for (let i = 0; i < s.maxLog + 5; i++) {
			s._noteFailedInput('A', 'tick', { error: `${BOOM} ${i}` });
		}
		expect(s.failedInputReport()).toHaveLength(s.maxLog);
		// …and it is the OLDEST that fell off, not the newest.
		const last = s.failedInputReport().pop();
		expect(String(last.error)).toContain(`${BOOM} ${s.maxLog + 4}`);
	}, BOOT_TIMEOUT);
});
