/**
 * tools/mp-server/presence.js  (KDM-250, epic mp-coop-features / KDM-226)
 *
 * WHO IS STILL HERE.
 *
 * Three states per seat — `connected`, `missing`, `gone` — plus the two latches that stop the
 * machine firing at the wrong moment. Everything here is a rule about liveness; nothing here touches
 * a socket, a world, or a game global.
 *
 *                     saw() / back()
 *      ┌──────────────────────────────────────────┐
 *      │                                          │
 *      ▼      sweep() past hbTimeoutMs, or lost()  │
 *   connected ─────────────────────────────► missing ──── remove() ───► gone
 *      │                                                                 ▲
 *      └───────────────────── remove() ──────────────────────────────────┘
 *
 * WHY IT IS ITS OWN MODULE. Same call as `join-gate.js` and `peace.js`: this is the PURE half of "a
 * dropped connection must not freeze the game", so its rules are checked in milliseconds
 * (`tests/unit/mp-presence.spec.ts`) instead of behind a ~30 s session boot — and these are exactly
 * the rules that are easy to get subtly wrong. `ws-bridge.js` is already 700 lines and owns the
 * transport; one concern, one file.
 *
 * ⚠️ MP-SPECIFIC BY CONSTRUCTION. A one-player game has no peer to lose, no seat to hold and nobody
 * to tell (KDM-226's test), so the gateway is this feature's only possible home. It re-implements no
 * game mechanic: it decides who is present and hands the answer back to the caller.
 *
 * `gone` IS TERMINAL. That is the whole point of E6. Once the survivor has decided to play on without
 * someone, a late reconnect of that clientId must be refused in words rather than walked back into a
 * session that has moved on — the failure this shape makes unrepresentable is a ghost re-taking a
 * seat whose character has already been dismantled.
 *
 * `paused` IS DERIVED, NEVER STORED. Two booleans that mean the same thing drift, and the one that
 * drifts here freezes somebody's game. There is exactly one source of truth: is any seat `missing`.
 * Note a `gone` seat does NOT pause — it is resolved, not pending.
 *
 * TIME IS INJECTED, NEVER READ. Every method that cares takes an explicit `t` in monotonic
 * milliseconds. Two reasons: the tests are then deterministic rather than timer-raced, and the
 * bridge can feed the same `process.hrtime` clock it already uses for latency. `Date.now()` would
 * be wrong here for the same reason it is wrong there — a wall-clock jump would silently declare a
 * live player dead.
 */
'use strict';

/** No reply for this long ⇒ the seat is missing. Generous on purpose: see the note in `sweep`. */
const DEFAULT_HB_TIMEOUT_MS = 30000;

class Presence {
	/** @param {{hbTimeoutMs?: number}} opts */
	constructor(opts) {
		this.hbTimeoutMs = (opts && opts.hbTimeoutMs != null) ? opts.hbTimeoutMs : DEFAULT_HB_TIMEOUT_MS;
		/**
		 * How often the caller INTENDS to sweep. Not used to schedule anything — `sweep` compares it
		 * against how late a sweep actually was, so the server can tell its own downtime apart from a
		 * client's silence. See the credit rule in `sweep`.
		 */
		this.hbIntervalMs = (opts && opts.hbIntervalMs != null) ? opts.hbIntervalMs : 0;
		this._lastSweepAt = null;
		/** clientId -> { role, state, lastSeen } */
		this._seats = new Map();
		/**
		 * N2 — the never-connected latch, ported from `MPDisconnect.ts:26`'s `peerEverConnected`.
		 *
		 * Without it, "the peer is not connected" is indistinguishable from "the peer has left", and
		 * the disconnect modal fires during the initial handshake — before anyone has actually gone
		 * anywhere. Latched, not recomputed: once two people have been in a room together, a later
		 * departure is a departure forever after.
		 */
		this.everPaired = false;
	}

	// ----- seats ---------------------------------------------------------------------------

	/**
	 * Seat a player as connected. Idempotent for the same id (a reload must not duplicate a seat).
	 *
	 * Refused for a `gone` seat, for the same reason `back` is: `gone` is terminal (E6), and seating
	 * is the OTHER door into `connected`. Guarding only one of the two doors would leave the ghost a
	 * way back in through a plain re-join.
	 */
	seat(clientId, role, t) {
		if (!clientId) return false;
		const s = this._seats.get(clientId);
		if (s && s.state === 'gone') return false;
		if (s) { s.state = 'connected'; s.lastSeen = t; }
		else this._seats.set(clientId, { role: role || null, state: 'connected', lastSeen: t });
		this._latch();
		return true;
	}

	seats() { return [...this._seats.keys()]; }

	state(clientId) {
		const s = this._seats.get(clientId);
		return s ? s.state : null;
	}

	roleOf(clientId) {
		const s = this._seats.get(clientId);
		return s ? s.role : null;
	}

	/** Seats being waited for, with the role each held — the survivor needs both (E3). */
	missing() {
		const out = [];
		for (const [clientId, s] of this._seats) {
			if (s.state === 'missing') out.push({ clientId, role: s.role });
		}
		return out;
	}

	/** True while anybody is being waited for. Derived — see the header. */
	get paused() {
		for (const s of this._seats.values()) if (s.state === 'missing') return true;
		return false;
	}

	// ----- liveness ------------------------------------------------------------------------

	/** Record that we heard from this seat. Any inbound message counts, not just a `pong`. */
	saw(clientId, t) {
		const s = this._seats.get(clientId);
		if (!s || s.state === 'gone') return false;
		s.lastSeen = t;
		return true;
	}

	/**
	 * E1 — mark every seat that has gone quiet for longer than `hbTimeoutMs`.
	 *
	 * Returns the ids that changed state on THIS call, so the caller reports each drop once instead
	 * of once per tick. A seat already `missing` (or `gone`) is skipped: it has been reported, and
	 * re-reporting it would put a fresh dialogue in front of the survivor every few seconds.
	 *
	 * WHY THE DEFAULT WINDOW IS GENEROUS. What this catches is a peer whose JS main loop is wedged —
	 * and a main loop that is merely BUSY looks identical for as long as it is busy. A tight window
	 * would declare a player dead for the crime of a long garbage collection or a slow frame.
	 */
	sweep(t) {
		/*
		 * KDM-251 — DO NOT BILL THE CLIENT FOR OUR OWN DOWNTIME.
		 *
		 * Both halves of `t - lastSeen` are read on the SERVER, so when the server's own event loop
		 * stalls — a GC pause, a blocking operation, a loaded host — every seat goes silent at once
		 * through no fault of any client, and the naive rule declares the whole session dead.
		 *
		 * Measured, not theorised: the full unit suite stalled this loop 1.47 s
		 * (`loopLag max=1469.6ms` in the mp-stats line), which blew a 200 ms window and paused a
		 * session whose peers were both healthy. Under KDM-250 that cost a wrong overlay line; under
		 * KDM-251 it stops the game.
		 *
		 * So credit everyone with however late this sweep was. Not a skip: a genuinely dead peer is
		 * still caught, it just takes `hbTimeoutMs + the stall` — which is the honest answer, because
		 * for the duration of the stall we had no evidence about anyone either way.
		 */
		if (this.hbIntervalMs > 0 && this._lastSweepAt != null) {
			const late = Math.max(0, (t - this._lastSweepAt) - this.hbIntervalMs);
			if (late > 0) {
				for (const s of this._seats.values()) {
					if (s.state === 'connected') s.lastSeen += late;
				}
			}
		}
		this._lastSweepAt = t;
		const lost = [];
		for (const [clientId, s] of this._seats) {
			if (s.state !== 'connected') continue;
			if ((t - s.lastSeen) > this.hbTimeoutMs) { s.state = 'missing'; lost.push(clientId); }
		}
		return lost;
	}

	/**
	 * E2 — the socket closed or errored. No need to wait out the heartbeat: this IS the evidence.
	 * Returns whether anything changed, so a close following an error reports nothing new.
	 */
	lost(clientId) {
		const s = this._seats.get(clientId);
		if (!s || s.state !== 'connected') return false;
		s.state = 'missing';
		return true;
	}

	/** The same player is back. Refused for a `gone` seat — E6, and the reason `gone` is terminal. */
	back(clientId, t) {
		const s = this._seats.get(clientId);
		if (!s || s.state === 'gone') return false;
		s.state = 'connected';
		s.lastSeen = t;
		this._latch();
		return true;
	}

	/** The survivor has decided to play on without them. Terminal. */
	remove(clientId) {
		const s = this._seats.get(clientId);
		if (!s || s.state === 'gone') return false;
		s.state = 'gone';
		return true;
	}

	// ----- internals -----------------------------------------------------------------------

	/** Close the N2 latch the first moment two seats are connected AT ONCE. */
	_latch() {
		if (this.everPaired) return;
		let live = 0;
		for (const s of this._seats.values()) if (s.state === 'connected') live++;
		if (live >= 2) this.everPaired = true;
	}
}

module.exports = { Presence, DEFAULT_HB_TIMEOUT_MS };
