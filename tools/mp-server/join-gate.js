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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { diffDeclarations, normalizeDeclaration } = require('./mod-sync');
// KDM-239 A5 — the host's world declaration is validated against the same classification the world
// applies, so the gate cannot accept a key the world would then drop.
const { sanitizeWorld } = require('./game-modes');

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

/**
 * KDM-238 R8 — the one place a player-supplied PERK DECLARATION is made safe to seat.
 *
 * A declaration is a list of perk KEYS the player switched on in KD's own perk screen. It reaches
 * the world as `KinkyDungeonStatsChoice` keys and then as arguments to `KDInitPerks()`, so the rules
 * are the same three the name gets — control characters stripped, trimmed, capped — plus two this
 * shape needs:
 *
 *   - **deduplicated**, because a declaration is a set. `KDInitPerks` runs a perk's start-effect
 *     once per entry, so a duplicated `Rigger` would hand out two pairs of scissors.
 *   - **capped in COUNT** (`PERKS_MAX`), so a malformed message cannot wedge the session. That is
 *     correctness, not authentication — there is nobody to authenticate against (KDM-226, LAN-only).
 *
 * ⚠️ IT DOES NOT JUDGE WHETHER A PERK EXISTS, and must not learn to. Validating a name needs a perk
 * list, and a perk list in `tools/mp-server/**` is a gameplay table in the gateway — exactly what
 * epic AC2 forbids and what the KDM-164 comment on `_setClassicHeels` was written about. KD's own
 * `KinkyDungeonStatsPresets` is the whitelist, consulted by `HeadlessHost.applyPerks`, which drops
 * anything it does not recognise. An unknown key is therefore carried politely and applied never.
 *
 * `MagicHands` is the one key removed by NAME, and it is not an exception to the rule above: it is
 * not a player choice at all. `KDInitPerks` sets it before its own loop and deletes it afterwards
 * unless the player already had it (`KinkyDungeonPerks.ts:712-715, :729-730`) — carried in as a
 * declaration it would survive that delete and silently change what KD's start scenarios do.
 */
const PERKS_MAX = 64;
const PERK_KEY_MAX = 64;
const PERK_SENTINELS = Object.freeze(['MagicHands']);

function sanitizePerks(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	const out = [];
	for (let i = 0; i < raw.length && out.length < PERKS_MAX; i++) {
		const entry = raw[i];
		if (typeof entry !== 'string') continue;
		let key = '';
		for (let j = 0; j < entry.length; j++) {
			const c = entry.charCodeAt(j);
			if (c < 0x20) continue;                 // C0 controls, incl. NUL, BEL, newline, ESC
			if (c >= 0x7f && c <= 0x9f) continue;   // DEL and the C1 block
			key += entry.charAt(j);
		}
		key = key.trim().slice(0, PERK_KEY_MAX);
		if (!key) continue;
		if (PERK_SENTINELS.indexOf(key) >= 0) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
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
		/**
		 * KDM-238 R3 — the perks each SEATED player declared, keyed by clientId.
		 *
		 * On the seat for exactly the reason the name is (see `names` above): a reconnecting player
		 * never re-seats, so a socket-scoped declaration would bring them back as a differently-built
		 * character. `release` drops it, `releasePending` does not — the same asymmetry.
		 */
		this.perks = new Map();
		/**
		 * KDM-239 R3/R5 — the WORLD the host declared: `{ modes, seed }`.
		 *
		 * A Map keyed by clientId rather than a single field, so it lives and dies with a seat exactly
		 * as `names` and `perks` do — but only ever ONE entry, the host's. A guest's declaration is
		 * dropped at `requestJoin` rather than stored and ignored later: a world has one author, and
		 * a second stored copy is the thing that would eventually get merged by accident.
		 */
		this.world = new Map();
		/**
		 * KDM-249 R2 — the SESSION's mod set, which is the host's, adopted on `claimHost`.
		 *
		 * "HOST is source of truth" (owner, 2026-08-22) implemented the same way it already is for
		 * `build` just above. Always an array, never undefined: callers iterate it, and an undefined
		 * here would surface as a crash at the far end of the handshake rather than as "no mods".
		 */
		this.mods = [];
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

	/**
	 * KDM-238 R3 — the perks this player declared, or `[]` if they declared none.
	 *
	 * A COPY, for the same reason `hostMods()` hands one back: a caller must not be able to quietly
	 * edit what the session believes a player chose. Like `nameOf`, it answers what the player said
	 * and applies no default of its own — a player who declared nothing is seated on KD's own terms,
	 * and that decision lives in `SwapSession.perksOf`, in one place.
	 */
	perksOf(clientId) { return (this.perks.get(clientId) || []).slice(); }

	/**
	 * KDM-239 R3/R5 — the world this player declared, or KD's defaults if they declared none.
	 *
	 * A fresh COPY every call, for the same reason `perksOf` hands one back. Answers
	 * `{ modes: [], seed: '' }` for everyone except the host, including for an id the gate has never
	 * seen — "declared nothing" and "is not the host" are the same answer here, and both mean
	 * "KD's own defaults".
	 */
	worldOf(clientId) {
		const w = this.world.get(clientId);
		return w ? { modes: w.modes.slice(), seed: w.seed } : { modes: [], seed: '' };
	}


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
		// KDM-238 R3 — the host declares their own perks with the same claim. Guarded on
		// `!== undefined` for the same reason `mods` is below: a claim that says nothing about perks
		// leaves what is already seated alone, while an explicit `[]` correctly means "none".
		if (info && info.perks !== undefined) this.perks.set(clientId, sanitizePerks(info.perks));
		// KDM-239 R3/R5 — and the world it is hosting, on the same terms. Only here: `requestJoin`
		// deliberately does not read `info.world`, so a guest cannot declare one at all (A5).
		if (info && info.world !== undefined) this.world.set(clientId, sanitizeWorld(info.world));
		// KDM-249 R2 — the host's declaration IS the session's. Unlike `build` above (where an
		// explicit value wins and a claim may only supply a missing one), a later claim REPLACES:
		// the host is the source of truth including when what they are running changes. Guarded on
		// `!== undefined` so a claim that says nothing about mods leaves the set alone, while an
		// explicit `[]` correctly means "I have none".
		if (info && info.mods !== undefined) this.mods = normalizeDeclaration(info.mods);
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

	/**
	 * KDM-249 R2 — the session's mod set. A COPY, so a caller cannot quietly edit what the session
	 * believes the host is running.
	 */
	hostMods() { return this.mods.slice(); }

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
		// KDM-238 R3 — sanitised HERE, where it is stored, exactly as the name is: what the host is
		// shown and what the world will seat must be the same value.
		const perks = sanitizePerks(info && info.perks);
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

		// KDM-249 R3/R4 — the diff is computed only once the join is otherwise GOING to be parked, so
		// no work is done for a join that was never going to happen, and it comes AFTER the build
		// check so a doomed pairing never reaches it.
		//
		// It is deliberately NOT a refusal input. A build mismatch cannot work and is refused
		// (KDM-233 N1); a mod difference only degrades presentation, and the remedy for it is to ship
		// the files — which is unreachable if the join was refused first.
		const modDiff = diffDeclarations(this.mods, info && info.mods);

		/*
		 * KDM-239 R4 — and the WORLD the guest is about to join, on the same message and for exactly
		 * the same reason the mod diff rides it: this is the only moment the guest can still walk
		 * away, because the session does not exist yet.
		 *
		 * Note `info.world` is NOT read here — a guest does not declare a world (A5). This is the
		 * HOST's, being shown to the guest.
		 */
		const world = this.worldOf(this.host);

		this.pending = { clientId, name, perks, build, mods: normalizeDeclaration(info && info.mods), modDiff };
		return { accept: false, pending: true, modDiff, world };
	}

	// ----- the host answers ----------------------------------------------------------------

	/** Seat the pending guest. An answer consumes the request, so answering twice is `not_pending`. */
	accept() {
		if (!this.pending) return { admitted: false, reason: 'not_pending' };
		const clientId = this.pending.clientId;
		// KDM-237 N2 — the name is promoted from the QUESTION to the SEAT, in the same statement that
		// seats them. Read before `pending` is cleared, for the obvious reason.
		const name = this.pending.name || '';
		// KDM-238 R3 — and so is the perk declaration, in the same breath. Asking is not being
		// seated: until this line the guest holds no seat, so `perksOf` answers `[]` for them.
		const perks = this.pending.perks || [];
		// KDM-249 — read alongside the name, and for the same reason: the answer CONSUMES the
		// question, so anything the caller will need afterwards must be taken before `pending` is
		// cleared. Handing it back means no caller has to have kept its own copy.
		const modDiff = this.pending.modDiff;
		this.pending = null;
		this.guest = clientId;
		if (name) this.names.set(clientId, name);
		if (perks.length) this.perks.set(clientId, perks);
		return { admitted: true, clientId, slot: GUEST_SLOT, modDiff };
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
		if (clientId === this.host) {
			this.host = null;
			// KDM-249 R2 — the session mod set goes with the HOST. Keeping it would offer the next
			// host's guests the previous host's mods, which is the wrong answer to "whose mods are
			// these".
			this.mods = [];
			// KDM-239 R3 — and so does the world declaration, for the same reason and by the same
			// rule as the perks and the name below: `release` drops it, `releasePending` does not.
			this.world.delete(clientId);
		}
		if (clientId === this.guest) this.guest = null;
		// KDM-237 P2 — the name goes with the SEAT, and only with the seat. `releasePending` above
		// deliberately does not touch it: a player who merely dropped still owns their seat (KDM-252
		// E4) and must come back as themselves rather than as `Player B`.
		this.names.delete(clientId);
		// KDM-238 R3 — the declaration goes with the SEAT, on the same terms as the name: a player
		// who merely DROPPED keeps it (releasePending does not touch this), or a reconnect would hand
		// them a differently-built character than the one they have been playing.
		this.perks.delete(clientId);
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

module.exports = { JoinGate, sanitizeName, sanitizePerks, NAME_MAX, PERKS_MAX, PERK_KEY_MAX, HOST_SLOT, GUEST_SLOT };
