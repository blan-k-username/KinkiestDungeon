/**
 * tools/mp-server/party-choice.js  (KDM-242 A1)
 *
 * PROPOSE + CONFIRM, ONCE — the rule two players use to agree on one thing.
 *
 * WHY IT EXISTS. KDM-263 built this for the journey route: either player proposes, the other agrees,
 * a disagreement re-opens the question rather than deadlocking. KDM-242 needs the identical rule for
 * the perk card, and its Notes make that an explicit DRY obligation — build the arbitration once and
 * reuse it, or say why not. Comparing the two showed only five things differ, so those five are hooks
 * and everything else lives here.
 *
 * WHY IT IS THE GATEWAY'S. "Wait for your partner to agree" cannot exist in a one-player game, which
 * is the epic's own test for what belongs in this layer. Keeping it here rather than on `KDGameData`
 * also keeps it out of the capture/restore path and out of every player bundle.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never decides on a player's behalf: there is no timeout, no
 * default and no host-wins rule. A party that never agrees simply never commits, and the game's own
 * refusal (whatever gates the choice) stays the ONE refusal path — this file adds no second one.
 *
 * THE RULES, in the order they are tested:
 *   invalid           → dropped. No proposal, no announcement.
 *   solo (1 seat)     → commit immediately. A one-player run must be indistinguishable from stock KD.
 *   your own pending  → nothing. A repeat of your own pick is not news and is not agreement.
 *   the same choice   → commit. This is the agreement.
 *   a different one   → replace the pending proposal and MAKE THE NEW PLAYER THE PROPOSER.
 *
 * That last rule is the load-bearing one. Refusing the second player's pick would also commit
 * nothing — and would be a soft-lock in which neither player can move the party. Re-opening means
 * agreement is always exactly one pick away. It applies after a commit too: the party has not acted on
 * the decision yet, so it is not final, and no player is stuck with an answer they have changed their
 * mind about. That is what `uncommit` is for.
 */
'use strict';

class PartyChoice {
	/**
	 * @param {object} h
	 * @param {string}   h.label      diagnostics only — never gameplay (epic criterion 2)
	 * @param {function} h.seats      () => number of seated players. A FUNCTION, not a number: the
	 *                                solo rule has to answer correctly for a party that lost a player
	 *                                mid-negotiation, or the survivor waits forever for nobody.
	 * @param {function} h.isValid    (choice) => boolean. The caller's own game-sourced test.
	 * @param {function} h.sameAs     (a, b) => boolean. Choices are compared by VALUE: callers hand
	 *                                out fresh objects, so `===` would make agreement impossible.
	 * @param {function} h.commit     (choice, byId) => void. The only place the world is written.
	 * @param {function} h.uncommit   () => void. Undo a commit that is being re-opened.
	 * @param {function} h.announce   (kind, choice, byId) => void. 'proposed' | 'committed'.
	 */
	constructor(h) {
		this._h = h;
		this._pending = null;
		this._proposer = null;
		this._committed = false;
	}

	/**
	 * A player picked something. Answers whether the pick was HANDLED (i.e. was a well-formed choice),
	 * not whether it committed — the caller uses it to decide whether it has consumed the input, the
	 * same contract `_settleJourneyProposalFrom` had.
	 */
	propose(clientId, choice) {
		const h = this._h;
		if (!h.isValid(choice)) return false;

		// Solo: the pick IS the decision. Checked before the pending state so a one-player run never
		// enters the negotiation at all — no proposal, no "waiting for your partner", nothing to see.
		if (h.seats() <= 1) { this._commit(choice, clientId); return true; }

		const same = this._pending != null && h.sameAs(this._pending, choice);
		if (same && this._proposer === clientId) return true;   // your own pick, again: not news
		if (same) { this._commit(choice, clientId); return true; }

		// A new question. If one was already answered, un-answer it — the party must not be able to act
		// on a decision it has stopped agreeing on.
		if (this._pending === null && this._committed) this._uncommit();
		this._pending = choice;
		this._proposer = clientId;
		h.announce('proposed', choice, clientId);
		return true;
	}

	/**
	 * The question's context is gone (the party changed map). Drop it — silently; an unanswered
	 * question is not news.
	 *
	 * It also forgets that a choice was COMMITTED, and that half is load-bearing: `uncommit` writes the
	 * WORLD, so a first pick made on the NEW map would otherwise fire it to undo a decision belonging
	 * to a map the party has already left. Not a safe no-op — a spurious write.
	 */
	reset() {
		this._pending = null;
		this._proposer = null;
		this._committed = false;
	}

	/** What is pending and who proposed it. A COPY, so a caller cannot edit what the session believes. */
	report() {
		return {
			pending: this._pending === null ? null : JSON.parse(JSON.stringify(this._pending)),
			proposer: this._proposer,
		};
	}

	get label() { return this._h.label; }

	// -- internals ---------------------------------------------------------------------------------

	_commit(choice, byId) {
		this._pending = null;
		this._proposer = null;
		this._committed = true;
		// Commit BEFORE announcing: a player told the party agreed must find it already true.
		this._h.commit(choice, byId);
		this._h.announce('committed', choice, byId);
	}

	_uncommit() {
		this._committed = false;
		this._h.uncommit();
	}
}

module.exports = { PartyChoice };
