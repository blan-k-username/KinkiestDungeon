/**
 * tools/mp-server/join-gate.js  (KDM-233)
 *
 * WHO IS IN THE SESSION, AND WHO IS STILL ASKING.
 *
 * Two seats — host (slot 0) and guest (slot 1) — plus the one question the host has not answered
 * yet. Everything here is a rule about membership; nothing here touches a socket, a world, or a game
 * global.
 *
 * WHY IT IS ITS OWN MODULE. Same call as `peace.js`: this is the PURE half of "host a game and let a
 * friend join", so its rules are checked in milliseconds (`tests/unit/mp-join-gate.spec.ts`) instead
 * of behind a ~30 s session boot — and these are exactly the rules that are easy to get subtly
 * wrong. `swap-session.js` is already 1600 lines; one concern, one file.
 *
 * ⚠️ MP-SPECIFIC BY CONSTRUCTION. A one-player game has no seats, no join request and no host to ask
 * (KDM-226's test), so the gateway is this feature's only possible home. It re-implements no game
 * mechanic: it decides membership and hands the answer back to the caller.
 *
 * THE PENDING REQUEST DOES NOT HOLD A SEAT. That is the whole point of approval-only joining
 * (KDM-233 R2 — there is no join code; the host IS the gate). A request that is parked, declined, or
 * dropped must leave the session exactly as it found it, which is why `guest` is only ever written
 * by `accept()`. The failure this shape makes unrepresentable: a declined guest that still occupies
 * slot 1 and blocks the next friend.
 *
 * ONE QUESTION AT A TIME. A second requester is refused `busy` rather than queued behind the first
 * (E7). Queueing would mean the host answers a dialogue about Ada and silently admits Bob.
 *
 * BUILD MISMATCH IS REFUSED BEFORE THE HOST IS PROMPTED (N1). The guest runs its OWN copy of the
 * bundle and only repoints its socket, so two different builds desync — and the host should never be
 * asked to approve a pairing that cannot work. Note this is the *correctness* check that survived
 * the LAN-only security posture (KDM-226): it is not authentication, and it is not trying to stop a
 * liar. A peer that misreports its build gets a broken session, which is its own problem.
 */
'use strict';

const HOST_SLOT = 0;
const GUEST_SLOT = 1;

/**
 * KDM-237 N4 — the one place a player-supplied name is made safe to seat and to draw.
 *
 * Server-side, because a client may send anything: the lobby field's own `maxlength` is a courtesy
 * to the person typing, not a constraint on the wire. Three rules, and no more —
 *
 *   - **control characters are removed**, not escaped. They carry no meaning in a KD label, and a
 *     stray ESC reaches a draw call and a log line alike.
 *   - **trimmed**, so `'  '` reads as "no name given" rather than as a name made of spaces.
 *   - **capped at `NAME_MAX`**, matching the lobby field, so what a player typed is what they get.
 *
 * A name is NOT an identity, and this deliberately does not make it one: it does not uniquify,
 * reject duplicates or reserve anything. `clientId` is the identity (KDM-252), and two players are
 * perfectly entitled to both be called Ada.
 *
 * Answers `''` for anything that survives none of the above — the single value every caller reads as
 * "unnamed", which is what keeps the legacy `Player <id>` label reachable (NF2).
 *
 * Written as a char-code scan rather than a regex on purpose: the alternative needs a class of
 * escaped control codepoints, and an escape lost to an edit is invisible in review and silently
 * stops filtering. Order matters — strip THEN trim, or a name of one bell character survives as
 * whitespace that looks real.
 */
const NAME_MAX = 24;

function sanitizeName(raw) {
	if (raw === undefined || raw === null) return '';
	const s = String(raw);
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20) continue;                 // C0 controls, incl. NUL, BEL, newline, ESC
		if (c >= 0x7f && c <= 0x9f) continue;   // DEL and the C1 block
		out += s.charAt(i);
	}
	return out.trim().slice(0, NAME_MAX);
}

class JoinGate {
	/** @param {{build?: string}} opts — `build` is this host's build id; guests must match it. */
	constructor(opts) {
		this.build = (opts && opts.build) || '';
		/** clientId of the host, or null. */
		this.host = null;
		/** clientId of the seated guest, or null. A PENDING requester is not seated. */
		this.guest = null;
		/** `{ clientId, name, build }` awaiting the host's answer, or null. */
		this.pending = null;
		/**
		 * KDM-237 — the display name of each SEATED player, keyed by clientId.
		 *
		 * On the seat rather than on the socket, because the seat is what survives a drop: a
		 * reconnecting player never re-seats (`ws-bridge.js` answers a known id with a bare
		 * `joined`), so a socket-scoped name would bring them back as `Player B`. See `release` vs
		 * `releasePending` below — the same asymmetry that holds the seat holds the name.
		 */
		this.names = new Map();
	}

	// ----- membership ----------------------------------------------------------------------

	/** Seated players, host first. A pending requester is deliberately absent. */
	players() {
		const out = [];
		if (this.host) out.push(this.host);
		if (this.guest) out.push(this.guest);
		return out;
	}

	has(clientId) { return clientId === this.host || clientId === this.guest; }

	/**
	 * KDM-237 — the name this player chose, or `''` if they gave none.
	 *
	 * Deliberately NOT a fallback: it answers what the player said and nothing else. The one place
	 * that turns an absent name into a label is `SwapSession.displayNameOf`, and keeping that
	 * decision in exactly one place is what guarantees the `#coop=` path keeps its legacy
	 * `Player <id>` strings byte-for-byte (NF2).
	 */
	nameOf(clientId) { return this.names.get(clientId) || ''; }


	slotOf(clientId) {
		if (clientId && clientId === this.host) return HOST_SLOT;
		if (clientId && clientId === this.guest) return GUEST_SLOT;
		return null;
	}

	// ----- hosting -------------------------------------------------------------------------

	/**
	 * Claim slot 0. Idempotent for the SAME id, because a host reloading their tab must not lose the
	 * session — but a DIFFERENT id is refused rather than silently re-seating, so a stray connection
	 * can never evict the person whose machine owns the world.
	 */
	claimHost(clientId, info) {
		if (this.host && this.host !== clientId) return { accept: false, reason: 'already_hosting' };
		this.host = clientId;
		// "HOST is source of truth" (owner, 2026-08-22): when nobody configured a build, the host's is
		// the session's, so N1 works without the operator setting anything. An EXPLICIT build wins —
		// a claim can supply the answer, never overrule one already given.
		if (!this.build && info && info.build) this.build = String(info.build);
		// KDM-237 N1/N3 — the host names themselves too. An absent name is left absent rather than
		// defaulted here: `SwapSession.displayNameOf` owns the one fallback (NF2).
		if (info && info.name !== undefined) this.names.set(clientId, sanitizeName(info.name));
		return { accept: true, slot: HOST_SLOT };
	}

	/**
	 * Is the build check actually doing anything? If no build is known — nobody configured one and the
	 * host never stated one — then a mismatch is not merely allowed, it is *unknowable*, and refusing
	 * every guest would be worse than refusing none.
	 *
	 * This is exported rather than left implicit precisely because a check that silently does nothing
	 * is how N1 would rot: the "skip" test is only meaningful because a test can see the skip.
	 */
	buildCheckActive() { return !!this.build; }

	// ----- asking to join ------------------------------------------------------------------

	/**
	 * Park a join request for the host to answer. Returns `{accept:false, pending:true}` on success —
	 * "not refused, not admitted either". Every refusal carries a `reason` the caller can show
	 * verbatim (E6: a join failure must arrive in words).
	 *
	 * Order matters: the cheap structural refusals come before the build check, and the build check
	 * comes before parking, so nothing that cannot work ever reaches the host's dialogue (N1).
	 */
	requestJoin(clientId, info) {
		// KDM-237 N2 — sanitised HERE, where it is stored, so the host's accept prompt shows exactly
		// the string the world will seat. Two spellings of one name is a bug report waiting to happen.
		const name = sanitizeName(info && info.name);
		const build = (info && info.build) || '';

		if (!this.host) return { accept: false, reason: 'no_host' };
		if (clientId === this.host) return { accept: false, reason: 'already_hosting' };
		if (clientId === this.guest) return { accept: true, slot: GUEST_SLOT };   // already in
		if (this.guest) return { accept: false, reason: 'session_full' };

		// Missing is NOT a wildcard — a guest that cannot state its build is as unusable as one that
		// states the wrong build, and treating absence as "fine" is how a skewed pair slips through.
		// The one exception is a session that does not know its OWN build (`buildCheckActive`): there
		// is nothing to compare against, so the check stands down rather than refusing everyone.
		if (this.buildCheckActive() && (!build || build !== this.build)) {
			return { accept: false, reason: 'build_mismatch', hostBuild: this.build, guestBuild: build };
		}

		if (this.pending && this.pending.clientId !== clientId) return { accept: false, reason: 'busy' };

		this.pending = { clientId, name, build };
		return { accept: false, pending: true };
	}

	// ----- the host answers ----------------------------------------------------------------

	/** Seat the pending guest. An answer consumes the request, so answering twice is `not_pending`. */
	accept() {
		if (!this.pending) return { admitted: false, reason: 'not_pending' };
		const clientId = this.pending.clientId;
		// KDM-237 N2 — the name is promoted from the QUESTION to the SEAT, in the same statement that
		// seats them. Read before `pending` is cleared, for the obvious reason.
		const name = this.pending.name || '';
		this.pending = null;
		this.guest = clientId;
		if (name) this.names.set(clientId, name);
		return { admitted: true, clientId, slot: GUEST_SLOT };
	}

	/**
	 * Refuse the pending guest. Deliberately NOT a ban: the same person may ask again (they may have
	 * mistyped a name, or the host may have mis-clicked). With no accounts and no codes there is
	 * nothing to ban anyway — LAN-only, per KDM-226.
	 */
	decline() {
		if (!this.pending) return { admitted: false, reason: 'not_pending' };
		const clientId = this.pending.clientId;
		this.pending = null;
		return { admitted: false, clientId, reason: 'declined' };
	}

	// ----- leaving -------------------------------------------------------------------------

	/**
	 * Free whatever this id held — a seat, or an unanswered question. A requester who dropped is no
	 * longer asking, so their pending request goes with them; otherwise the host is left staring at a
	 * dialogue about someone who has gone.
	 *
	 * The host leaving does NOT promote the guest. The authoritative world lives in the host's
	 * process, so there is nothing for a promoted guest to own (KDM-244 C1/C3) — the guest waits, and
	 * that is all (KDM-234 D5/D7).
	 */
	release(clientId) {
		this.releasePending(clientId);
		if (clientId === this.host) this.host = null;
		if (clientId === this.guest) this.guest = null;
		// KDM-237 P2 — the name goes with the SEAT, and only with the seat. `releasePending` above
		// deliberately does not touch it: a player who merely dropped still owns their seat (KDM-252
		// E4) and must come back as themselves rather than as `Player B`.
		this.names.delete(clientId);
	}

	/**
	 * KDM-252 — drop an unanswered QUESTION without giving up the SEAT.
	 *
	 * Once the session is running, a dropped socket is a player who may still come back, and E4 says
	 * they come back to *their own* seat. Freeing slot 0 the moment the host's Wi-Fi blinked would
	 * let a stranger claim the host slot of a game already in progress — and would hand the returning
	 * host a refusal instead of their character. So the bridge releases the whole seat only before
	 * the session starts; afterwards the seat is held by `presence`, and it is released when that
	 * seat goes `gone` (the survivor's decision, never a timer — KDM-234 D7).
	 *
	 * A pending REQUEST is different and is dropped either way: someone who disconnected mid-question
	 * is no longer asking, and leaving it would park the host in front of a dialogue about a person
	 * who has gone.
	 */
	releasePending(clientId) {
		if (this.pending && this.pending.clientId === clientId) this.pending = null;
	}
}

module.exports = { JoinGate, sanitizeName, NAME_MAX, HOST_SLOT, GUEST_SLOT };
