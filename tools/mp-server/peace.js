/**
 * tools/mp-server/peace.js  (KDM-227 / KDM-225)
 *
 * WHO IS AT WAR WITH WHOM — the co-op session's player-to-player relationship, and the offer/answer
 * handshake that changes it.
 *
 * WHY IT IS ITS OWN MODULE. Two reasons, in order.
 *
 * 1. It is the one part of this feature that is PURE. No world handle, no game globals, no `eval`.
 *    Every rule below is therefore testable in milliseconds (`tests/unit/mp-peace-registry.spec.ts`)
 *    instead of behind a ~30 s session boot, and these are exactly the rules that are easy to get
 *    subtly wrong — one-sided war, an offer that survives its answer, a split verdict.
 * 2. `swap-session.js` is already 1238 lines. Same call as `kd-codec.js` / `kd-delta.js` /
 *    `input-classifier.js`: one concern, one file.
 *
 * ⚠️ THIS IS AN MP-SPECIFIC FEATURE, AND THAT IS DELIBERATE. KDM-159's rule — *the MP server must not
 * implement features; it is a proxy* — bans the gateway from RE-IMPLEMENTING GAME mechanics. A truce
 * between two players is not one: single-player KD has no concept of it, so the gateway is its only
 * possible home (the owner's clarification, recorded in KDM-226). The rule still binds in one place
 * and the caller honours it there: the EFFECT of peace is written in KD's own entity fields
 * (`hostile`, `rage`), never as a parallel hostility model. This module holds the RELATIONSHIP; it
 * does not know what an entity is.
 *
 * THE RELATIONSHIP IS A PAIR, NOT A DIRECTION. Every key is the two ids sorted and joined, so
 * `atWar(A,B)` and `atWar(B,A)` cannot disagree — the "A thinks there is peace, B thinks there is
 * war" failure is impossible to express rather than something we remember to prevent.
 */
'use strict';

/** Order-independent key for an unordered pair. */
function pairKey(a, b) { return [String(a), String(b)].sort().join('|'); }

class PeaceRegistry {
	constructor() {
		this._war = new Set();      // pairKey
		this._peace = new Set();    // pairKey — the override that beats even the global KD_PVP flag
		this._offers = new Map();   // pairKey -> { from, to, turn }
	}

	// ----- the relationship ----------------------------------------------------------------

	atWar(a, b) { return this._war.has(pairKey(a, b)); }
	atPeace(a, b) { return this._peace.has(pairKey(a, b)); }

	/**
	 * An attack landed. Peace and war are mutually exclusive, so this ends any truce — that is
	 * R15/AC6, "the door swings both ways", and it is why the caller can route KD's own aggro
	 * straight here without asking whether a truce is in force.
	 */
	declareWar(a, b) {
		const k = pairKey(a, b);
		this._peace.delete(k);
		this._war.add(k);
		return k;
	}

	/** An accepted truce. Symmetric with declareWar: setting one clears the other. */
	makePeace(a, b) {
		const k = pairKey(a, b);
		this._war.delete(k);
		this._offers.delete(k);
		this._peace.add(k);
		return k;
	}

	// ----- the handshake -------------------------------------------------------------------

	/**
	 * R1/R2/R3 — may `from` offer peace to `to` right now?
	 *
	 * Three conditions, and the third is NOT a cooldown: D4 says declining is completely free. It is
	 * "you already asked", and it lapses the instant the other side answers.
	 */
	canOffer(from, to) {
		const k = pairKey(from, to);
		return this._war.has(k) && !this._peace.has(k) && !this._offers.has(k);
	}

	/**
	 * R4 — record an offer. Changes nothing about the war until it is answered.
	 *
	 * R17, the simultaneous case: if the other side has already asked, BOTH players have now asked for
	 * peace, which is agreement — so a counter-offer resolves as an acceptance rather than opening a
	 * second slot. One slot per pair means there is never a second offer for the two sides to disagree
	 * about; the split verdict is structurally impossible, not handled.
	 */
	offer(from, to, turn) {
		const k = pairKey(from, to);
		const open = this._offers.get(k);
		if (open) {
			if (open.from !== String(from)) {
				this.makePeace(from, to);
				return { ok: true, accepted: true };
			}
			return { ok: false, why: 'already-asked' };   // R3
		}
		if (!this._war.has(k)) return { ok: false, why: 'not-at-war' };   // R2
		this._offers.set(k, { from: String(from), to: String(to), turn });
		return { ok: true, accepted: false };
	}

	/** The offer this player owes an answer to, or null. */
	pendingFor(player) {
		for (const o of this._offers.values()) {
			if (o.to === String(player)) return { from: o.from };
		}
		return null;
	}

	/** R5 — is this player the one holding up the handshake? */
	owesAnswer(player) { return this.pendingFor(player) !== null; }

	/** Every peer this player is currently at war with (what the client needs to render the entry). */
	warPeersOf(player) {
		const me = String(player);
		const out = [];
		for (const k of this._war) {
			const [x, y] = k.split('|');
			if (x === me) out.push(y);
			else if (y === me) out.push(x);
		}
		return out;
	}

	/**
	 * R6/R7 — `player` answers the offer made TO them.
	 * Accepting makes peace; declining clears the slot and leaves the war untouched, so the offerer
	 * may ask again immediately (R8/D4).
	 */
	answer(player, accept) {
		const me = String(player);
		for (const [k, o] of this._offers.entries()) {
			if (o.to !== me) continue;
			this._offers.delete(k);
			if (accept) { this.makePeace(o.from, o.to); return { ok: true, peace: true, from: o.from }; }
			return { ok: true, peace: false, from: o.from };
		}
		return { ok: false, why: 'no-offer', peace: false };
	}

	// ----- lifetime ------------------------------------------------------------------------

	/**
	 * R18 — a player left. Drop every offer they are part of, in EITHER role: an offer to a player who
	 * is gone would block nobody, and an offer FROM a player who is gone would block someone forever.
	 * The war/peace entries are left alone — a rejoining player rejoins their relationships.
	 */
	forget(player) {
		const me = String(player);
		for (const [k, o] of this._offers.entries()) {
			if (o.from === me || o.to === me) this._offers.delete(k);
		}
	}

	/**
	 * R13/R19 — the between-floors hub. Everyone is at peace and no question is left open.
	 *
	 * Wars are cleared rather than converted into `peace` entries: `peace` exists to override the
	 * GLOBAL `KD_PVP` flag for a pair that negotiated, and the hub is not a negotiation. Under a
	 * global-PvP session the next attack should still be able to start a war normally.
	 */
	resetAll() {
		this._war.clear();
		this._offers.clear();
	}
}

module.exports = { PeaceRegistry, pairKey };
