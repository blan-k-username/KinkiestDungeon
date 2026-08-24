/**
 * tools/mp-server/ws-bridge.js  (KD-071/KD-085, epic mp-server / KD-066)
 *
 * Minimal, dependency-free local WebSocket bridge between browser thin-clients and
 * the server-side SwapSession (the live SWAP-model session — KD-085). A browser can't
 * do in-process/worker IPC, so even on localhost the client↔server link is a
 * WebSocket. We hand-roll a tiny RFC6455 server on Node's built-in http+crypto (no
 * `ws` dependency) — text frames only, which is all the protocol needs.
 *
 * Protocol (JSON text frames):
 *   client → server : { type:'join', clientId }            register a player
 *                      { type:'input', action }             this turn's action —
 *                          KD's real input { kdType, data } (default-control path)
 *                          or a built-in helper { kind:'move'|'wait', dx, dy }
 *   server → client : { type:'joined', clientId, started }  ack
 *                      { type:'state', tick, snapshot }      this client's render-state
 *                      { type:'waiting', waitingOn:[...] }    barrier still open
 *
 * ⚠️ That list is the ORIGINAL core, not the whole protocol — the join gate (KDM-233), presence
 * (KDM-250/251/252) and the delta encoding (KDM-206) each added messages. `_handle` below is the
 * authoritative inbound dispatch; the outbound set is whatever `_send` is called with. Two
 * distinctions worth knowing before adding another:
 *   - `blocked` ≠ `waiting`. `waiting` means "your input entered lockstep" and the client stops
 *     accepting input on it; a refusal must therefore never be sent as `waiting` (KDM-225/251).
 *   - `state{kind:'push'}` ≠ `state{kind:'ui'}`. A `ui` frame is the REPLY to an input the client
 *     sent, and the client unwinds one in-flight slot for it. A `push` is server-initiated and
 *     replies to nothing (KDM-252).
 *
 * The turn advances only when EVERY player has submitted (R8 lockstep). On advance the
 * server composes each client's render-state from the ONE authoritative world + that
 * client's state bundle (SwapSession.snapshotFor) — exactly what KDRenderClient.apply()
 * consumes in the browser. `tick` is the session turn counter (+1 per resolved turn).
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { SwapSession } = require('./swap-session');
const { kdDiff } = require('./kd-delta');
const { JoinGate } = require('./join-gate');
const { ModStore } = require('./mod-sync');
const { Presence, DEFAULT_HB_TIMEOUT_MS } = require('./presence');

/**
 * KDM-206: top-level snapshot keys carried IN FULL by every delta, never diffed.
 *
 * These are CONSUME-ONCE channels: `snapshotFor` drains pending events (`_takePendingEvents`), and the
 * floating combat text / unknown-input reports are one-shot too. A one-shot value exists in exactly one
 * snapshot, so if it were diffed and its delta were lost, it would be gone for good — the anti-deletion
 * trap KDM-196 documents. Together they are ~0.1 KB, so carrying them whole costs nothing next to the
 * 26 KB this change removes.
 */
const VERBATIM_CHANNELS = ['events', 'messages', 'unknownInputs', 'replacedInputs'];

/**
 * KDM-260 — what a `join` message contributes to a SEAT, declared once per role.
 *
 * ── WHY THIS IS DATA AND NOT A HAND-WRITTEN OBJECT LITERAL ────────────────────────────────────────
 * It used to be the literal `{ name: msg.name, build: msg.build, mods: msg.mods, perks: msg.perks }`
 * at each call site. KDM-239 added `world` to the handshake and did not add it here, and the failure
 * was SILENT: the gate held an empty declaration, the session was built on KD's defaults, and all 605
 * unit tests stayed green — because every one of them calls `claimHost`/`requestJoin` directly and
 * never crosses this bridge. Only an e2e asserting what reached the guest's screen caught it.
 *
 * So: adding a handshake field is now a one-line change here, and
 * `tests/unit/mp-join-fields.spec.ts` reads the CLIENT's own `join.<field> =` assignments and fails
 * if one of them is not covered by a shape below.
 *
 * ⚠️ THE TWO LISTS DIFFER ON PURPOSE. `world` is the host's alone (KDM-239 A5): a guest must not be
 * able to declare one, and "the gate is never even told" is a stronger guarantee than "the gate drops
 * it". Do not unify these into one list with a runtime exception.
 *
 * `role`, `clientId` and `type` are deliberately ABSENT — they are routing, not declarations.
 */
const HOST_JOIN_FIELDS = Object.freeze(['name', 'build', 'mods', 'perks', 'world']);
const GUEST_JOIN_FIELDS = Object.freeze(['name', 'build', 'mods', 'perks']);

/**
 * Copy the named fields that are actually PRESENT on `msg`.
 *
 * ⚠️ `in`, not `!== undefined` on the destination: the gate distinguishes "said nothing about perks"
 * from "said I have none" with `if (info.perks !== undefined)`. Materialising every key as
 * `undefined` would collapse that distinction, and an empty declaration would start overwriting a
 * real one — the exact bug `mods_declare` (below) depends on NOT having.
 */
function pickFields(msg, fields) {
	const out = {};
	for (const f of fields) if (msg && f in msg) out[f] = msg[f];
	return out;
}

/** Monotonic milliseconds. Never Date.now(): a wall-clock jump would corrupt every latency below. */
function now() { return Number(process.hrtime.bigint()) / 1e6; }

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
	return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

/** Encode a text payload as a single unmasked server→client frame. */
function encodeFrame(str) {
	const payload = Buffer.from(str, 'utf8');
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.from([0x81, len]);
	} else if (len < 65536) {
		header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81; header[1] = 127;
		header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
		header.writeUInt32BE(len >>> 0, 6);
	}
	return Buffer.concat([header, payload]);
}

/**
 * Decode complete text frames from a buffer. Returns { messages:[str], rest:Buffer }.
 * Handles client→server masked frames (mask bit is always set by browsers).
 */
function decodeFrames(buf) {
	const messages = [];
	let offset = 0;
	while (offset + 2 <= buf.length) {
		const b0 = buf[offset];
		const b1 = buf[offset + 1];
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let len = b1 & 0x7f;
		let p = offset + 2;
		if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
		else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
		let mask = null;
		if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
		if (p + len > buf.length) break;            // incomplete frame — wait for more
		let payload = buf.slice(p, p + len);
		if (masked) {
			const out = Buffer.alloc(len);
			for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
			payload = out;
		}
		offset = p + len;
		if (opcode === 0x8) { messages.push(null); continue; }   // close
		if (opcode === 0x1 || opcode === 0x0) messages.push(payload.toString('utf8'));
		// opcode 0x9/0xA (ping/pong) ignored
	}
	return { messages, rest: buf.slice(offset) };
}

class WSBridge {
	/** @param {object} opts { requiredPlayers=2, seed, enemyType } */
	constructor(opts = {}) {
		// KDM-163 AC1: the client no longer classifies input — it routes everything — so no type may be
		// unlearned when it first arrives. Pre-seeding is what makes that affordable: without it the
		// first use of each type takes the lockstep default and costs the player a turn, which breaks
		// click-to-move (`KDFastMoveTo` dispatches through `KDSendInput`). Callers may still override.
		this.session = new SwapSession(Object.assign({ seedInputKinds: true }, opts));
		// KDM-233: WHO MAY BE IN THE SESSION — two seats and the one question the host has not answered
		// yet. Kept pure and separate (`join-gate.js`) so its rules are unit-tested in milliseconds; the
		// bridge only carries answers between it and the sockets.
		this.gate = new JoinGate({ build: opts.build || '' });
		/**
		 * KDM-249 R6 — the session's mod PAYLOADS, keyed by content hash.
		 *
		 * On the bridge because the bridge owns the session lifecycle the payloads belong to; the HTTP
		 * routes in `demo-server.js` read it through here. In memory only, and cleared with the
		 * session — a restarted gateway holds nothing and re-asks the host, which is the correct
		 * answer to "whose mods are these".
		 */
		this.mods = new ModStore();
		this.sockets = new Map();          // clientId -> socket
		this._server = null;
		this.port = null;
		// KDM-206: what each client last received, so a reply can carry a DELTA instead of a whole
		// capture. `_snapSeq` lets the client detect a gap and ask for a full resync rather than
		// silently merging onto a stale base.
		this._lastSnap = new Map();        // clientId -> last snapshot SENT
		this._snapSeq = new Map();         // clientId -> monotonically increasing state sequence
		// Demo/UAT convenience: when true, one player's move advances the turn
		// immediately (others auto-"wait"), instead of blocking on every player.
		// Real lockstep (block until all submit) stays the default for actual co-op.
		this.autoAdvance = !!opts.autoAdvance;
		// Humane lockstep (KD-087): if the submit barrier stays open longer than this,
		// the server auto-"wait"s the non-submitters so an idle/finished player doesn't
		// deadlock a partner who is still acting (e.g. walking a longer click-to-move
		// route). 0 = disabled (strict lockstep — block until ALL submit). A `wait` is
		// never a contested action, so R9 conflict resolution is unaffected.
		this.idleGraceMs = (opts.idleGraceMs != null) ? opts.idleGraceMs : 0;
		this._graceTimer = null;
		// KDM-250: WHO IS STILL HERE. Kept pure and separate (`presence.js`) so its rules are
		// unit-tested in milliseconds; the bridge only feeds it the clock and carries its answers to
		// the sockets. `hbIntervalMs: 0` disables the heartbeat entirely — the escape hatch an
		// operator (or a spec) needs, and the ONLY way to turn it off. It is on by default on
		// purpose: a safety mechanism that ships off is the exact mistake `idleGraceMs` made.
		this.hbIntervalMs = (opts.hbIntervalMs != null) ? opts.hbIntervalMs : 5000;
		this.presence = new Presence({
			hbTimeoutMs: (opts.hbTimeoutMs != null) ? opts.hbTimeoutMs : DEFAULT_HB_TIMEOUT_MS,
			// KDM-251: presence needs the INTENDED cadence so it can tell a sweep that was late
			// (our event loop stalled) from a client that went quiet. See the credit rule in `sweep`.
			hbIntervalMs: this.hbIntervalMs,
		});
		this._hbTimer = null;
		this._startHeartbeat();
		// KDM-186: the latency probe must be running before the first input arrives.
		this._startLoopLag();
		this._startStatsTicker();
	}

	listen(port = 0) {
		return new Promise((resolve) => {
			this._server = http.createServer((_req, res) => { res.writeHead(426); res.end('Upgrade Required'); });
			this.attach(this._server);
			this._server.listen(port, '127.0.0.1', () => {
				this.port = this._server.address().port;
				resolve(this.port);
			});
		});
	}

	/** Attach the WS upgrade handler to an EXISTING http server (e.g. the demo
	 *  static server) so client↔server share one port/origin. */
	attach(server) {
		server.on('upgrade', (req, socket) => this._onUpgrade(req, socket));
		return this;
	}

	_onUpgrade(req, socket) {
		const key = req.headers['sec-websocket-key'];
		if (!key) { socket.destroy(); return; }
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
		);
		let buf = Buffer.alloc(0);
		let clientId = null;
		socket.on('data', (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			const { messages, rest } = decodeFrames(buf);
			buf = rest;
			// KDM-186 queue timing: every message in this batch arrived BEFORE we handled any of them,
			// so a batch of N is N-1 messages that waited on their predecessors. `_handle` runs
			// synchronously on the event loop — there is no application queue — so this batch index and
			// the event-loop lag below are the only places a wait can hide on the server side.
			const tBatch = now();
			const parsed = messages.map((m) => {
				if (m === null) return null;
				try { return JSON.parse(m); } catch (e) { return undefined; }
			});
			const superseded = this._supersededInBatch(parsed);
			for (let bi = 0; bi < parsed.length; bi++) {
				if (messages[bi] === null) { socket.end(); return; }
				const msg = parsed[bi];
				if (!msg) continue;
				// KDM-192: a stream input that a NEWER one of the same type already supersedes — with both
				// already sitting in this same socket read — is stale before we even look at it. Applying
				// it costs a full transaction and buys nothing but latency for whatever follows.
				if (superseded.has(bi)) { this._noteCoalesced(clientId, msg); continue; }
				this._batch = { size: parsed.length, index: bi, waitMs: now() - tBatch };
				clientId = this._handle(socket, msg, clientId);
			}
			this._batch = null;
		});
		// KDM-250: an errored socket is a departed player, not a line to swallow. This used to be a
		// bare no-op, which is half of why a drop was invisible.
		socket.on('error', () => { this._dropped(clientId); });
		// KDM-233: a peer that went away releases whatever it held — a seat, or an unanswered question.
		// Without this the host is left staring at a dialogue about someone who has already gone, and
		// slot 1 stays occupied by a ghost. (Making the SESSION survive a drop is KDM-234; this is only
		// the membership bookkeeping.)
		socket.on('close', () => {
			if (!clientId) return;
			// KDM-252 E4: a RUNNING session holds the seat. Before it starts, a departure frees
			// everything (that is the lobby's whole job); after it starts, only the unanswered
			// question goes — the seat belongs to that clientId until they come back or the survivor
			// dismisses them. See `join-gate.js` → `releasePending`.
			if (this.session.started && this.gate.has(clientId)) this.gate.releasePending(clientId);
			else this.gate.release(clientId);
			if (this.sockets.get(clientId) === socket) this.sockets.delete(clientId);
			// KDM-250: and the SURVIVOR is told. Reported after the socket is dropped from the map so
			// the report is not addressed to the person who just left.
			this._dropped(clientId);
		});
	}

	/**
	 * KDM-237 N2 / KDM-238 R3 — hand what the SEAT knows about a player to the session, immediately
	 * before it seats them: the name they chose, and the perks they chose.
	 *
	 * One helper rather than copies of the same gate lookup at each site, because the three seating
	 * sites (accept, join-late, and the plain/legacy join) must not be able to disagree about where a
	 * player's identity comes from. The gate is the source; the session is told; neither invents
	 * anything. The two fields travel together for the same reason they are stored together — they
	 * are answers to "who is this player", and splitting them would let one arrive without the other.
	 *
	 * Safe on the roleless `#coop=` path (NF2/R9): `nameOf` answers `''` and `perksOf` answers `[]`
	 * for a player who declared neither, and both setters CLEAR rather than set on an empty value —
	 * so those sessions keep the legacy `Player <id>` label and KD's own default perk state.
	 */
	_carrySeat(clientId) {
		try { this.session.setPlayerName(clientId, this.gate.nameOf(clientId)); }
		catch (e) { /* a session that predates names, or an id the gate never seated */ }
		try { this.session.setPerks(clientId, this.gate.perksOf(clientId)); }
		catch (e) { /* a session that predates perk choice (KDM-238) */ }
		// KDM-239 R3/R5 — and the world this player declared. Only a HOST ever has one (the gate
		// refuses to store a guest's), so this is a no-op for everyone else and needs no role check
		// here: "who may declare a world" is answered in exactly one place, and it is not this one.
		try { this.session.setWorldOptions(clientId, this.gate.worldOf(clientId)); }
		catch (e) { /* a session that predates world declaration (KDM-239) */ }
	}

	/**
	 * KDM-186: a write that the kernel could not take immediately is queued INSIDE Node, and the
	 * client sees it whenever the socket drains — latency the server's own clock never sees. With
	 * ~40 KB snapshots this is a prime suspect for round-trips that are ~60x the measured CPU cost,
	 * so record the backlog rather than discarding `write`'s return value.
	 */
	_send(socket, obj) {
		const ok = socket.write(encodeFrame(JSON.stringify(obj)));
		const backlog = socket.writableLength || 0;
		if (!this._wr) this._wr = { writes: 0, blocked: 0, maxBacklog: 0 };
		this._wr.writes++;
		if (!ok) this._wr.blocked++;
		if (backlog > this._wr.maxBacklog) this._wr.maxBacklog = backlog;
		return ok;
	}

	/**
	 * KDM-233: refuse a join IN WORDS (E6).
	 *
	 * The reason must travel as an application message, never as a rejected upgrade. A browser cannot
	 * read an HTTP handshake rejection — it surfaces to `WebSocket` only as close 1006, with no
	 * status, headers or body — so a pre-upgrade refusal leaves the join screen with literally nothing
	 * to display. Accept the upgrade, send the typed reason, then close. (Lesson carried over from
	 * `origin/feature/multiplayer`'s `tools/mp-server.js:286-293`.)
	 */
	_reject(socket, r) {
		const out = { type: 'reject', reason: r.reason || 'refused' };
		if (r.hostBuild !== undefined) out.hostBuild = r.hostBuild;
		if (r.guestBuild !== undefined) out.guestBuild = r.guestBuild;
		try { this._send(socket, out); } catch (e) { /* socket already gone */ }
		try { socket.end(); } catch (e) { /* noop */ }
	}

	_handle(socket, msg, clientId) {
		// KDM-250: ANY inbound message is evidence the peer's event loop is turning — a `pong` is
		// merely the one we can count on when the player is doing nothing. Recorded before the
		// dispatch below so a slow handler cannot make its own sender look dead.
		if (clientId) this.presence.saw(clientId, now());
		// A `pong` is liveness and nothing else. It must NOT produce a state frame: KD's draw loop
		// already emits an input every frame, and KDM-186 measured what answering cheap traffic with
		// ~40 KB snapshots costs (809 MB egress, one core pegged, lockstep never completing).
		if (msg.type === 'pong') return clientId;
		/**
		 * KDM-249 — a HOST re-states its mod set after publishing the payloads.
		 *
		 * The declaration on `join` is whatever had been hashed by the time the socket opened. A
		 * player who picks mods from the Mods menu and then hosts would otherwise declare a stale
		 * (often empty) set — and because the session's mod set IS the host's declaration, that
		 * silently means "this session has no mods" rather than merely being out of date.
		 *
		 * Host-only by construction: `claimHost` is what adopts a declaration, and a guest saying this
		 * is ignored rather than refused — it cannot change the session, so there is nothing to
		 * report.
		 */
		if (msg.type === 'mods_declare' && clientId && clientId === this.gate.host) {
			this.gate.claimHost(clientId, { mods: msg.mods });
			return clientId;
		}
		// KDM-233: the host's answer to the one pending question (E2/E3). Only the host may answer —
		// otherwise a guest could admit itself, which is the whole gate.
		if (msg.type === 'join_answer' && clientId && clientId === this.gate.host) {
			const pendingId = this.gate.pending && this.gate.pending.clientId;
			const res = msg.accept ? this.gate.accept() : this.gate.decline();
			const guestSock = pendingId ? this.sockets.get(pendingId) : null;
			if (!res.admitted) {
				if (guestSock) this._reject(guestSock, res);
				return clientId;
			}
			try {
				this._carrySeat(res.clientId);
				const r = this.session.join(res.clientId);
				this.presence.seat(res.clientId, 'guest', now());   // KDM-250
				if (guestSock) {
					this._send(guestSock, {
						type: 'joined', clientId: res.clientId, started: r.started, players: this.session.players,
					});
				}
				if (r.started) this._broadcastState();
			} catch (e) {
				if (guestSock) this._send(guestSock, { type: 'error', error: String(e && e.message || e) });
			}
			return clientId;
		}
		if (msg.type === 'join') {
			try {
				clientId = msg.clientId;
				/*
				 * KDM-250 E6 / KDM-253 — `gone` is terminal, and it is checked HERE, before anything
				 * else, because it must hold on both roads back in.
				 *
				 * It used to be enforced inside the re-attach branch, which is gated on
				 * `session.players.includes(clientId)`. That was true while a dismissed player still
				 * held a seat — and false the moment KDM-253's teardown actually removed them, so the
				 * ghost fell through to the ORDINARY join path and got a bare `error` about a session
				 * that had already started. Presence is what decides this, not seat membership.
				 *
				 * Before the socket map, so a connection we are about to close is never registered.
				 */
				if (this.presence.state(clientId) === 'gone') {
					this._reject(socket, { reason: 'seat_gone' });
					return clientId;
				}
				this.sockets.set(clientId, socket);
				// Reload-friendly (KD-098): a KNOWN player reconnecting to an already-started
				// session just REATTACHES its new socket and re-syncs — calling join() again
				// would throw "session already started". This lets you reload a tab mid-session
				// (e.g. to re-read the diagnostics) without restarting the server.
				if (this.session.started && this.session.players.includes(clientId)) {
					// KDM-252 U1: the seat is live again. A `gone` seat cannot reach this line — it is
					// refused at the top of the join branch, which is the only place that rule lives.
					this.presence.back(clientId, now());
					this._send(socket, { type: 'joined', clientId, started: true, players: this.session.players });
					// KDM-206/KDM-252 N4: a rejoining client holds nothing we can diff against — force a
					// full snapshot AND restart its sequence, so the client has a base to count gaps from
					// instead of inheriting a number from a socket that no longer exists.
					this._resetDelta(clientId);
					try { this._send(socket, Object.assign({ type: 'state', tick: this.session.turn }, this._stateFrame(clientId))); } catch (e) { /* ignore */ }
					this._reportBack(clientId);
					return clientId;
				}
				// KDM-233: an explicit ROLE opts into the approval flow. Without one this is the legacy
				// `#coop=<id>` path, which still joins directly — the two converge in KDM-236, and until
				// then the e2e suite and `tools/coop-demo.sh` keep working unchanged.
				if (msg.role === 'host') {
					// KDM-260 — the shape is declared once, at the top of this file, so a new handshake
					// field cannot be forgotten here. `world` is in the HOST shape only (KDM-239 A5).
					const c = this.gate.claimHost(clientId, pickFields(msg, HOST_JOIN_FIELDS));
					if (!c.accept) { this._reject(socket, c); return clientId; }
				} else if (msg.role === 'guest') {
					const q = this.gate.requestJoin(clientId, pickFields(msg, GUEST_JOIN_FIELDS));
					if (q.pending) {
						// Asking is not joining: no seat is taken and the session is untouched until the
						// host answers. The guest is told it is waiting so the join screen can say so
						// rather than looking hung.
						// KDM-249 R5 — the diff rides on BOTH replies, so each side learns it before the
						// session exists. The guest needs to know what it will be missing before it
						// commits; the host needs to know what it is about to be asked to supply.
						this._send(socket, { type: 'awaiting_approval', modDiff: q.modDiff, world: q.world });
						const hostSock = this.sockets.get(this.gate.host);
						if (hostSock) this._send(hostSock, { type: 'join_pending', clientId, name: this.gate.pending.name, modDiff: q.modDiff });
						return clientId;
					}
					if (!q.accept) { this._reject(socket, q); return clientId; }
				}
				// KDM-250: seated BEFORE `session.join`, so the role is decided while this client is
				// still the newest arrival — `_roleFor`'s legacy fallback reads arrival order.
				const role = this._roleFor(clientId, msg.role);
				this.presence.seat(clientId, role, now());
				// KDM-235 — a NEW id arriving at a RUNNING session is a join-late, not an error. (A
				// known id is a reconnect and never reaches here; a dismissed one was refused at the
				// top of this branch.) `join()` is the pre-start collector and throws once started, so
				// the two cases get the two different methods they always needed.
				this._carrySeat(clientId);
				if (this.session.started) { this._joinLate(clientId); return clientId; }
				const r = this.session.join(clientId);
				this._send(socket, { type: 'joined', clientId, started: r.started, players: this.session.players });
				if (r.started) this._broadcastState();   // both in → push initial render-state
			} catch (e) {
				this._send(socket, { type: 'error', error: String(e && e.message || e) });
			}
			return clientId;
		}
		// KDM-206: the client noticed a gap in the state sequence, so whatever it holds may be stale.
		// Forget what we think it has and send a full snapshot — merging a delta onto an unknown base
		// is the one way this optimisation could corrupt state, and this is the escape hatch.
		if (msg.type === 'resync' && clientId && this.session.started) {
			this._resetDelta(clientId);
			const sock = this.sockets.get(clientId);
			if (sock) {
				try {
					this._send(sock, Object.assign({ type: 'state', tick: this.session.turn },
						this._stateFrame(clientId)));
				} catch (e) { /* ignore */ }
			}
			return clientId;
		}
		if (msg.type === 'input' && clientId && this.session.started) {
			try {
				// KDM-163 (option A): the client routes EVERY input and classifies nothing. `apply`
				// asks the GAME whether the input consumes a turn; only then does it enter lockstep.
				const tApply = now();
				let res = this.session.apply(clientId, msg.action || {});
				const applyMs = now() - tApply;
				this._noteInput(clientId, msg.action, res.kind, applyMs);   // KDM-186 telemetry
				// KDM-253: the session has READ a disconnect answer; acting on it is ours, because it
				// needs presence and seats — neither of which the session knows about. Done before the
				// reply below so the state frame that reply carries already shows the world the
				// decision produced.
				if (res.solo === true) this._goSolo(clientId);
				else if (res.quit === true) this._acceptQuit(clientId);
				if (res.kind === 'ui') {
					// A menu/UI input: applied to this player's own state, no turn consumed. Push their
					// updated snapshot straight back so the UI responds without waiting for the partner
					// — this is what keeps R6 true now that nothing runs locally on the client.
					// KDM-163: TAGGED `kind:'ui'`. Without it this is indistinguishable from a resolved
					// turn, and the client's turn bookkeeping (submitted / route / tick) fires on it.
					// That matters enormously once the client routes everything: `setMoveDirection` is
					// sent from KD's draw loop EVERY FRAME, so an untagged push would reset the
					// per-turn state ~60×/s and no click-to-move route could survive a single frame.
					// KDM-186 RULE 2 — state on CHANGE, not on input.
					// Measured: KD's draw loop emits an input every frame, so answering each one with a
					// full snapshot cost ~40 KB × ~100/s × 2 clients (809 MB egress, one core pegged).
					// The server then fell so far behind that replies stopped and lockstep never
					// completed — the turn counter never left 0 and the players could do NOTHING.
					// An input that moved no state gets a bare ack, which the client counts for its
					// in-order bookkeeping and otherwise ignores. This is a DIFF of the player's own
					// captured state — the bridge never learns which inputs are 'important'.
					if (res.changed === false) {
						this._send(socket, { type: 'ack', tick: this.session.turn, srv: this._srvStamp(applyMs) });
						return clientId;
					}
					// KDM-206: a DELTA, not a whole capture. This is the per-frame path — KD's draw loop
					// emits `setMoveDirection` every frame — so it is where the 38.3 KB reply hurt.
					this._send(socket, Object.assign({
						type: 'state', kind: 'ui', tick: this.session.turn, srv: this._srvStamp(applyMs),
					}, this._stateFrame(clientId)));
					// KDM-225: a ui action that changed SOMEONE ELSE's view (a peace offer is only
					// interesting to the person being asked) names them in `notify`. Without this the
					// peer sees nothing until the next resolved turn — and with R5 blocking their turn
					// on that very answer, that turn would never come. The bridge does not decide who
					// is affected; the session says so, and this pushes to exactly that list.
					for (const other of res.notify || []) {
						const s = this.sockets.get(other);
						if (!s || other === clientId) continue;
						try {
							this._send(s, Object.assign({ type: 'state', kind: 'ui', tick: this.session.turn },
								this._stateFrame(other)));
						} catch (e) { /* socket gone */ }
					}
					return clientId;
				}
				// KDM-225 UAT: a REFUSED action is not a queued one.
				//
				// `submit` can now decline outright (a player owing an answer to a peace offer). That
				// used to fall through to the `waiting` reply below, and `waiting` is what tells the
				// client "your input entered lockstep" — so the client set `coop.submitted = true` and
				// then suppressed every further input as already-acted. Combined with the answer prompt
				// failing to open, the player was soft-locked: every key and click did nothing, and the
				// overlay cheerfully read "your move — others ready".
				//
				// A refusal gets its own message so the client can say why and keep accepting input.
				if (res.blocked) {
					this._send(socket, { type: 'blocked', reason: res.blocked });
					return clientId;
				}
				// demo mode: auto-"wait" for any player who hasn't submitted so a single
				// player's move advances the turn (easy to validate sync solo).
				if (!res.advanced && this.autoAdvance) {
					for (const pid of res.waitingOn || []) {
						res = this.session.submit(pid, { kind: 'wait' });
						if (res.advanced) break;
					}
				}
				if (res.advanced) { this._clearGrace(); this._broadcastState(); }
				else {
					this._send(socket, { type: 'waiting', waitingOn: res.waitingOn });
					// tell the awaited players they're holding up the turn (UI can show it
					// or pass early); arm the idle-grace auto-wait so they can't deadlock us.
					for (const pid of res.waitingOn || []) {
						const s = this.sockets.get(pid);
						if (s) this._send(s, { type: 'await', waitingOn: res.waitingOn, graceMs: this.idleGraceMs });
					}
					this._armGrace();
				}
			} catch (e) {
				this._send(socket, { type: 'error', error: String(e && e.message || e) });
			}
		}
		return clientId;
	}

	/**
	 * Push each client its render-state, composed by SwapSession.snapshotFor from the
	 * ONE authoritative world + that client's state bundle: the shared world map (all
	 * enemies + every OTHER player's avatar) plus this client's own player + stats,
	 * minus this client's own avatar (they're their own global player, not an avatar).
	 * `tick` is the session turn counter (+1 per resolved turn — lockstep marker).
	 */
	_clearGrace() {
		if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
	}

	/**
	 * KDM-250 — the heartbeat: ping everybody, then sweep whoever stopped answering.
	 *
	 * WHY AN APPLICATION-LEVEL PING AND NOT RFC6455 OPCODE 0x9. A browser answers a protocol ping
	 * from its network stack, so a protocol pong proves the SOCKET is alive and says exactly nothing
	 * about a frozen JS main loop — and a wedged renderer is one of the two deaths this exists to
	 * catch (the other, a closed socket, is already covered by `_dropped` below and needs no timer).
	 * A `{type:'ping'}` message has to be answered by the page's own event loop, so silence means the
	 * page is gone in the sense the player cares about.
	 *
	 * `unref()` so the heartbeat never holds the process open — a liveness probe must not change
	 * lifetime. Same discipline as `_startLoopLag`.
	 */
	_startHeartbeat() {
		if (this._hbTimer || !(this.hbIntervalMs > 0)) return;
		this._hbTimer = setInterval(() => {
			const t = now();
			for (const [cid, sock] of this.sockets) {
				try { this._send(sock, { type: 'ping', t: Math.round(t) }); } catch (e) { this._dropped(cid); }
			}
			for (const cid of this.presence.sweep(t)) this._reportMissing(cid);
		}, this.hbIntervalMs);
		if (this._hbTimer.unref) this._hbTimer.unref();
	}

	/**
	 * A seat's socket closed or errored (E2). No need to wait out the heartbeat — this IS the
	 * evidence. `presence.lost` returns false if the seat was already missing, so an error followed
	 * by a close reports once, not twice.
	 */
	_dropped(clientId) {
		if (!clientId) return;
		if (this.presence.lost(clientId)) this._reportMissing(clientId);
	}

	/**
	 * Tell everyone still here that somebody is not (E3).
	 *
	 * The ROLE travels with the id because host and guest are not symmetric (KDM-234 D5): a guest who
	 * drops leaves the host a choice, while a host who drops leaves the guest waiting. A survivor who
	 * only learned "someone left" could not tell which of those it is in.
	 *
	 * N2 — nothing is reported until two people have actually been in the session together. Otherwise
	 * the initial handshake, where one seat is legitimately empty, is indistinguishable from a
	 * departure, and the survivor gets a disconnect dialogue about somebody who never arrived.
	 */
	_reportMissing(clientId) {
		if (!this.presence.everPaired) return;
		const role = this.presence.roleOf(clientId);
		/*
		 * KDM-251 S2 — the turn loop stops here, and this is the ONLY place presence is mapped onto
		 * session behaviour. `SwapSession` is handed an opaque reason and never learns what a seat is.
		 *
		 * Gated on `started`: before the session exists there is no turn loop to pause, and pausing a
		 * session that has not begun would refuse the joins that would start it.
		 */
		if (this.session.started) this.session.pause('peer-missing');
		const msg = { type: 'peer_missing', clientId, role };
		for (const [cid, sock] of this.sockets) {
			if (cid === clientId) continue;
			try { this._send(sock, msg); } catch (e) { /* that one is gone too */ }
			// KDM-251 S3/S5 — and the survivor is told IN THE GAME, not only in a corner overlay.
			// A guest who has lost the HOST gets the quit-only dialogue (D5/D7): they cannot continue,
			// because it is the host's process that owns the world. The host's own wait/solo choice on
			// a GUEST drop is KDM-253 — deliberately not opened here.
			if (role === 'host' && this.session.started) {
				try { this.session.openHostLostDialogue(cid); } catch (e) { /* world may be mid-teardown */ }
			}
			// KDM-253 S4/D1 — and the mirror: a HOST who has lost a guest is given the choice the
			// guest is never offered. Two options, no timeout; until they answer, the pause stands.
			if (role === 'guest' && this.session.started) {
				try { this.session.openPeerLostDialogue(cid); } catch (e) { /* world may be mid-teardown */ }
			}
		}
	}

	/**
	 * KDM-252 E4 — the mirror of `_reportMissing`: somebody who was being waited for is back.
	 *
	 * Three things happen to the SURVIVOR, in this order, and the order matters:
	 *   1. their disconnect modal is closed on their own bundle (server-side — see
	 *      `swap-session._closeOwnDialogue` for why the client cannot do this itself);
	 *   2. the session unpauses, but ONLY once every seat is back — a three-seat session missing two
	 *      people must not resume because one of them returned (`_resumeIfWhole` owns that rule);
	 *   3. and only then are they told, together with a fresh state frame. The frame is what actually
	 *      takes the modal off their screen, so sending it before step 1 would announce the return
	 *      and leave the dialogue standing.
	 *
	 * The returning player is not told about themselves, exactly as `_reportMissing` does not report
	 * a departure to the person who departed.
	 */
	_reportBack(clientId) {
		const role = this.presence.roleOf(clientId);
		// Closed on every SEAT, not on every open socket. A survivor who is themselves offline right
		// now still holds that modal in their bundle, and would be handed it back — stale — inside the
		// full snapshot they get when they in turn reconnect. Harmless where it was never open: the
		// close is guarded on the dialogue's own name.
		if (role === 'host' && this.session.started) {
			for (const cid of this.session.players) {
				if (cid === clientId) continue;
				try { this.session.closeHostLostDialogue(cid); } catch (e) { /* world may be mid-teardown */ }
			}
		}
		this._resumeIfWhole();
		const msg = { type: 'peer_back', clientId, role };
		for (const [cid, sock] of this.sockets) {
			if (cid === clientId) continue;
			try {
				this._send(sock, msg);
				// Their own bundle changed (the modal was closed on it), and a bundle change the client
				// never receives is a modal that never goes away. This is a normal delta — the survivor
				// has held an unbroken base throughout, so nothing here needs a full snapshot.
				//
				// ⚠️ `kind:'push'`, NOT `'ui'`. The client answers a `ui` frame by unwinding one slot of
				// its in-flight bookkeeping, because a `ui` frame is the REPLY to an input it sent. This
				// frame replies to nothing — the survivor pressed nothing; their peer's socket came
				// back — so tagging it `ui` would free a slot that no reply ever filled and leave the
				// queue permanently out of step with the wire (the KDM-186 Rule-1 failure).
				this._send(sock, Object.assign({ type: 'state', kind: 'push', tick: this.session.turn },
					this._stateFrame(cid)));
			} catch (e) { /* that one is gone too */ }
		}
	}

	/**
	 * KDM-253 E5/E6 — the survivor has chosen to go on alone. Give up the missing seats for good.
	 *
	 * The ONE place a seat becomes `gone`, and therefore the one place the join-gate slot is handed
	 * back: KDM-252 stopped a mid-session close from releasing it, precisely so a returning player
	 * would find their own seat, and this is where that hold finally ends. Miss the `gate.release`
	 * and slot 1 leaks for the life of the process.
	 *
	 * Every missing seat goes, not just one. With three players and two gone, "continue solo" means
	 * exactly what it says, and leaving the second one `missing` would re-pause the session the
	 * instant it resumed.
	 */
	_goSolo(deciderId) {
		const leaving = this.presence.missing().map((m) => m.clientId).filter((id) => id !== deciderId);
		if (!this._seatGone(leaving, 'dismissed')) return false;
		this.session._dbg(`SOLO — ${deciderId} continues without ${leaving.join(', ')}`);
		return true;
	}

	/**
	 * KDM-253 — a guest pressed Quit on the host-lost dialogue: they are leaving on purpose.
	 *
	 * The same departure as `_goSolo`, aimed at the person who asked rather than the person who
	 * vanished. It exists because the alternative is a "clean goodbye" that leaves a seat held for
	 * somebody who has explicitly said they are not coming back — the survivor would then be asked to
	 * keep waiting for a player who already quit.
	 */
	_acceptQuit(clientId) {
		if (!this._seatGone([clientId], 'quit')) return false;
		this.session._dbg(`QUIT — ${clientId} left deliberately`);
		return true;
	}

	/**
	 * KDM-235 A5 — admit a newcomer to a run in progress and get everyone looking at the same world.
	 *
	 * The session decides WHETHER and WHEN (it may defer the seat to the turn boundary); the bridge
	 * only carries the answer to the sockets, exactly as it does for presence and seats elsewhere.
	 *
	 * A deferred seat is told `joined` immediately — the client needs to leave its lobby screen — but
	 * its first state frame waits for the seat to actually exist, because `snapshotFor` throws for a
	 * player with no bundle. The turn that flushes the queue broadcasts to everyone anyway
	 * (`_broadcastState`), so the joiner's first frame arrives there, and `_resetDelta` guarantees it
	 * is a full snapshot (R3).
	 */
	_joinLate(clientId) {
		const sock = this.sockets.get(clientId);
		const res = this.session.joinInProgress(clientId);
		if (!res.seated) {
			if (sock) this._send(sock, { type: 'error', error: `cannot join: ${res.reason}` });
			return false;
		}
		if (sock) {
			this._send(sock, { type: 'joined', clientId, started: true, players: this.session.players });
		}
		if (res.deferred) return true;      // the flushing turn will broadcast to everyone, including them
		this._resetDelta(clientId);         // they hold nothing to diff against
		if (sock) {
			try {
				this._send(sock, Object.assign({ type: 'state', tick: this.session.turn },
					this._stateFrame(clientId)));
			} catch (e) { /* socket gone */ }
		}
		// The players already here get a new avatar in their world. `push`, not `ui`: nobody asked for
		// this frame, so it must not unwind anyone's in-flight bookkeeping (KDM-252).
		for (const [cid, s] of this.sockets) {
			if (cid === clientId) continue;
			try {
				this._send(s, { type: 'peer_joined', clientId, players: this.session.players });
				this._send(s, Object.assign({ type: 'state', kind: 'push', tick: this.session.turn },
					this._stateFrame(cid)));
			} catch (e) { /* that one is gone too */ }
		}
		return true;
	}

	/**
	 * KDM-253 E5/E6 — a departure that is FINAL. The one place a seat becomes `gone`.
	 *
	 * Shared by both ways out (the survivor dismisses a missing peer; a guest quits) because they are
	 * the same operation seen from two ends, and the two halves that are easy to forget are the same
	 * either way:
	 *
	 *   - the JOIN-GATE slot. KDM-252 stopped a mid-session close from releasing it, precisely so a
	 *     returning player would find their own seat. This is where that hold finally ends — miss it
	 *     and slot 1 leaks for the life of the process;
	 *   - TELLING THE SURVIVORS. `_goSolo` originally did not, and the server state was perfectly
	 *     correct while the host's browser sat on "your partner has disconnected — the game is
	 *     paused" forever. Caught by the e2e, invisible to a spec that only reads server state: the
	 *     decision is not delivered until the page that made it can see the result.
	 *
	 * Every missing seat goes, not just one: with three players and two gone, "continue solo" means
	 * what it says, and leaving the second `missing` would re-pause the session the instant it
	 * resumed.
	 */
	_seatGone(ids, reason) {
		const gone = [];
		for (const id of ids) {
			if (!this.presence.remove(id)) continue;   // already terminal — do not report it twice
			this.gate.release(id);
			this.session.removePlayer(id);             // everything the world knew about them
			const sock = this.sockets.get(id);
			// If they are still connected (a quit, or a peer whose socket outlived the decision), say
			// why in words before closing — the same typed refusal a later reconnect would get.
			if (sock) {
				try { this._send(sock, { type: 'reject', reason: 'seat_gone' }); sock.end(); } catch (e) { /* already gone */ }
			}
			this.sockets.delete(id);
			gone.push(id);
		}
		if (!gone.length) return false;
		this._resumeIfWhole();
		for (const [cid, sock] of this.sockets) {
			try {
				for (const id of gone) this._send(sock, { type: 'peer_gone', clientId: id, reason });
				// Their world changed — an avatar left it. `push`, not `ui`: nobody asked for this
				// frame, so it must not unwind anyone's in-flight bookkeeping (KDM-252).
				this._send(sock, Object.assign({ type: 'state', kind: 'push', tick: this.session.turn },
					this._stateFrame(cid)));
			} catch (e) { /* that one is gone too */ }
		}
		return true;
	}

	/** KDM-251: everybody is back — let the turn loop run again. */
	_resumeIfWhole() {
		if (this.presence.paused) return false;
		if (!this.session.started) return false;
		this.session.resume();
		return true;
	}

	/**
	 * Which seat is this, in the words the survivor needs? An explicit `role` from the join wins;
	 * otherwise the gate knows (slot 0 is the host); otherwise this is the legacy `#coop=<id>` path,
	 * where the first to arrive is the host by arrival order.
	 */
	_roleFor(clientId, declared) {
		if (declared === 'host' || declared === 'guest') return declared;
		const slot = this.gate.slotOf(clientId);
		if (slot === 0) return 'host';
		if (slot === 1) return 'guest';
		return this.presence.seats().length === 0 ? 'host' : 'guest';
	}

	/** Arm the idle-grace timer: after idleGraceMs, auto-"wait" the non-submitters so a
	 *  still-acting player isn't deadlocked by an idle/finished partner (KD-087). */
	_armGrace() {
		if (!(this.idleGraceMs > 0)) return;
		this._clearGrace();
		this._graceTimer = setTimeout(() => {
			this._graceTimer = null;
			let res = { advanced: false };
			// submit a wait for each still-pending player until the turn resolves
			for (const pid of this.session.waitingOn()) {
				try { res = this.session.submit(pid, { kind: 'wait' }); } catch (e) { /* noop */ }
				if (res.advanced) break;
			}
			if (res.advanced) this._broadcastState();
		}, this.idleGraceMs);
	}

	/**
	 * KDM-186 UAT telemetry: how much traffic each client actually generates between turns, how the
	 * GAME classified it, and — since the 2026-08-17 profile — WHERE THE LATENCY IS.
	 *
	 * The profile measured a `ui` transaction at ~16-20 ms of server CPU while the owner measured a
	 * 1067 ms round-trip: two orders of magnitude apart. So the wait is NOT the work, and only four
	 * places on this side can hold a message. Each is recorded here, so one UAT round decides it:
	 *
	 *   applyMs   the actual transaction (profiled at ~16-20 ms — expected to be small)
	 *   waitMs    time this message sat behind earlier messages of the SAME socket read batch
	 *   batch     how many messages arrived together (batch > 1 IS backlog: they queued in the
	 *             socket buffer while we were busy — `_handle` is synchronous, there is no app queue)
	 *   loopLag   event-loop drift: time stolen by anything else (e.g. the 90 ms oversize audit)
	 *   write     `socket.write` returning false + `writableLength` — the kernel could not take the
	 *             reply, so it is queued INSIDE Node and the client sees it whenever the socket
	 *             drains. With ~40 KB snapshots this is the prime suspect and the server's own clock
	 *             is blind to it.
	 *
	 * Costs a few counter bumps per input; the line is emitted once per turn into the existing
	 * serverLog, which the browser console already echoes.
	 */
	_noteInput(clientId, action, kind, applyMs) {
		if (!this._inputStats) this._inputStats = new Map();
		let per = this._inputStats.get(clientId);
		if (!per) {
			per = { ui: 0, turn: 0, types: {}, apply: [], wait: [], batchMax: 0, batched: 0 };
			this._inputStats.set(clientId, per);
		}
		const t = (action && (action.kdType || action.kind)) || 'unknown';
		per[kind === 'ui' ? 'ui' : 'turn']++;
		per.types[t] = (per.types[t] || 0) + 1;
		if (applyMs != null) per.apply.push(applyMs);
		const b = this._batch;
		if (b) {
			per.wait.push(b.waitMs);
			if (b.size > per.batchMax) per.batchMax = b.size;
			if (b.index > 0) per.batched++;   // this message waited on a predecessor
		}
	}

	/**
	 * Event-loop lag sampler. A 50 ms interval that reports how late it actually fired: the only way
	 * to see time stolen by synchronous work elsewhere (the oversize audit is 90 ms every ~3.3 s).
	 * `unref()` so it never holds the process open — a telemetry probe must not change lifetime.
	 */
	_startLoopLag() {
		if (this._lagTimer) return;
		const EVERY = 50;
		let last = now();
		this._lag = { max: 0, n: 0, sum: 0 };
		this._lagTimer = setInterval(() => {
			const t = now();
			const late = Math.max(0, (t - last) - EVERY);
			last = t;
			this._lag.n++; this._lag.sum += late;
			if (late > this._lag.max) this._lag.max = late;
		}, EVERY);
		if (this._lagTimer.unref) this._lagTimer.unref();
	}

	/**
	 * KDM-186: emit the latency line at 1 Hz, to BOTH the server stdout and the browser console.
	 *
	 * The first version drained per resolved turn. That is the wrong clock: under strict lockstep
	 * (idleGraceMs=0, the demo default) a turn stalls until BOTH humans act, so the telemetry went
	 * silent for precisely the stall it was added to explain. A wall-clock tick also makes the counts
	 * rates rather than per-turn totals, which is what a per-frame input stream needs.
	 *
	 * Also reports the lockstep barrier: a stalled turn must SAY who it is waiting on, or "nothing is
	 * happening" is indistinguishable from "the transport is broken" — a confusion that has already
	 * cost this task several hypotheses.
	 */
	_startStatsTicker() {
		if (this._statsTimer) return;
		this._statsLog = [];
		this._statsTimer = setInterval(() => {
			const line = this._drainInputStats();
			const waiting = this._barrierLine();
			for (const l of [line, waiting]) {
				if (!l) continue;
				// eslint-disable-next-line no-console
				console.log("[mp-stats] " + l);
				this._statsLog.push(l);
			}
			if (this._statsLog.length > 8) this._statsLog = this._statsLog.slice(-8);
		}, 1000);
		if (this._statsTimer.unref) this._statsTimer.unref();
	}

	/** Who is the lockstep barrier still waiting on, and for how long (null when no turn is open). */
	_barrierLine() {
		const s = this.session;
		if (!s || !s.started) return null;
		let pending = [];
		// Use the session's own barrier accessor — never re-derive it from `_pending` here, or this line
		// can disagree with the barrier it is describing.
		try { pending = (typeof s.waitingOn === "function") ? s.waitingOn() : []; }
		catch (e) { return null; }
		if (!pending.length || pending.length === (s.players || []).length) {
			this._barrierSince = null;
			return null;
		}
		if (!this._barrierSince) this._barrierSince = now();
		return "turn " + s.turn + " OPEN for " + Math.round((now() - this._barrierSince) / 1000)
			+ "s — waiting on: " + pending.join(", ") + " (strict lockstep, idleGraceMs=" + this.idleGraceMs + ")";
	}

	/**
	 * KDM-192: which messages in this socket read are already superseded by a newer one of the SAME
	 * type, and therefore need not be applied at all?
	 *
	 * WHY. Measured in the owner's live session: ~30 inputs/s at ~60 ms each = ~1.8 s of CPU demanded
	 * per wall-clock second, so the loop ran ~2 s behind (`loopLag avg 1600-2400ms`) and a real action
	 * queued behind it landed ~3 s late. The waste was visible in one field: `batched=25/max26` —
	 * twenty-six `setMoveDirection` in ONE read, each paid in full, when only the last can matter.
	 *
	 * SAFETY, and why this is not a per-feature list:
	 *  - Only types the SESSION has already classified `ui` are eligible. That classification is
	 *    LEARNED from the game (`inputKind`), never enumerated here — this file names no input type.
	 *  - A `ui` input is a LEVEL (the current mouse direction), not an event: the newest value is the
	 *    whole truth, so an older one is not "dropped work", it is a stale reading.
	 *  - Anything else — turn-consuming, or simply not yet classified — is NEVER skipped. Unknown
	 *    defaults to "keep", which is the safe direction (KDM-163 forbids silently swallowing an input).
	 *  - Scope is ONE socket read. These messages are already queued together; nothing is delayed and
	 *    nothing is held back waiting for a possible successor.
	 * Skips are COUNTED and reported, never silent.
	 */
	_supersededInBatch(parsed) {
		const skip = new Set();
		if (!parsed || parsed.length < 2) return skip;
		const kinds = this.session && this.session.inputKind;
		if (!kinds) return skip;
		const lastIndexOfType = new Map();
		for (let i = 0; i < parsed.length; i++) {
			const msg = parsed[i];
			if (!msg || msg.type !== "input" || !msg.action) continue;
			const t = msg.action.kdType || msg.action.kind;
			if (!t || kinds.get(t) !== "ui") continue;   // unknown or turn-consuming ⇒ keep every one
			const prev = lastIndexOfType.get(t);
			if (prev !== undefined) skip.add(prev);      // an older reading of the same level
			lastIndexOfType.set(t, i);
		}
		return skip;
	}

	/** Count a coalesced input so the saving is visible and the drop is never silent (KDM-163). */
	_noteCoalesced(clientId, msg) {
		if (!this._coalesced) this._coalesced = new Map();
		const t = (msg && msg.action && (msg.action.kdType || msg.action.kind)) || "unknown";
		const key = (clientId || "?") + " " + t;
		this._coalesced.set(key, (this._coalesced.get(key) || 0) + 1);
	}

	/** Compact per-reply stamp so the client can decompose its OWN round-trip measurement. */
	_srvStamp(applyMs) {
		const b = this._batch;
		return {
			apply: Math.round(applyMs * 100) / 100,
			wait: b ? Math.round(b.waitMs * 100) / 100 : 0,
			batch: b ? b.size : 1,
			backlog: (this._wr && this._wr.maxBacklog) || 0,
		};
	}

	/** Drain the counters into one human-readable line (null when nothing happened). */
	_drainInputStats() {
		if (!this._inputStats || !this._inputStats.size) return null;
		const q = (xs, p) => {
			if (!xs.length) return 0;
			const s = [...xs].sort((a, b) => a - b);
			return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
		};
		const parts = [];
		for (const [cid, per] of this._inputStats) {
			const top = Object.keys(per.types).sort((a, b) => per.types[b] - per.types[a]).slice(0, 3)
				.map((k) => k + '×' + per.types[k]).join(' ');
			parts.push(cid + ': ui=' + per.ui + ' turn=' + per.turn + ' {' + top + '}'
				+ ' apply p50=' + q(per.apply, 0.5) + 'ms/p95=' + q(per.apply, 0.95) + 'ms'
				+ ' wait p95=' + q(per.wait, 0.95) + 'ms'
				+ ' batched=' + per.batched + '/max' + per.batchMax);
		}
		this._inputStats.clear();
		let tail = '';
		if (this._lag && this._lag.n) {
			tail += '  || loopLag avg=' + Math.round((this._lag.sum / this._lag.n) * 10) / 10
				+ 'ms max=' + Math.round(this._lag.max * 10) / 10 + 'ms';
			this._lag.max = 0; this._lag.n = 0; this._lag.sum = 0;
		}
		if (this._wr) {
			tail += '  || writes=' + this._wr.writes + ' blocked=' + this._wr.blocked
				+ ' maxSocketBacklog=' + Math.round(this._wr.maxBacklog / 1024) + 'KB';
			this._wr.writes = 0; this._wr.blocked = 0; this._wr.maxBacklog = 0;
		}
		if (this._coalesced && this._coalesced.size) {
			const top = [...this._coalesced.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
				.map(([k, n]) => k + "x" + n).join(" ");
			tail += "  || coalesced " + [...this._coalesced.values()].reduce((x, y) => x + y, 0)
				+ " {" + top + "}";
			this._coalesced.clear();
		}
		return 'inputs/s — ' + parts.join('  |  ') + tail;
	}

	/**
	 * KDM-206: compose the state payload for one client — a DELTA when we know what they last held,
	 * a full snapshot on the first send and after a resync.
	 *
	 * WHY. Every changed `ui` input used to answer with `snapshotFor()`, a whole capture. Measured
	 * (`tests/unit/mp-ui-reply-size-profile.spec.ts`): a mouse-direction change moves ONE global of
	 * 13-15 bytes and the reply carrying it was 38.3 KB — ~10,000x amplification, and the reason
	 * `mp-real-input.spec.ts:112` sat at 195-273 KB against a 100 KB budget. `map` alone (11.7 KB,
	 * ~31% of every reply) was bit-identical each time and re-sent anyway. Measured after:
	 * 38.1 KB -> 115 B, 339x smaller (`tests/unit/mp-delta-codec.spec.ts`).
	 *
	 * EVERY state send goes through here. That is the point: if one path sent a full snapshot without
	 * recording it, the next delta would be computed against a base the client never had, and the
	 * merge would corrupt state silently.
	 */
	_stateFrame(clientId) {
		const full = this.session.snapshotFor(clientId);
		const prev = this._lastSnap.get(clientId);
		const seq = (this._snapSeq.get(clientId) || 0) + 1;
		this._snapSeq.set(clientId, seq);
		this._lastSnap.set(clientId, full);
		if (!prev) return { seq, snapshot: full };
		const delta = kdDiff(prev, full, VERBATIM_CHANNELS);
		// `undefined` means nothing moved. Still send an (empty) delta rather than a full snapshot:
		// the client needs the seq to stay in step, and this is the cheapest possible frame.
		return { seq, delta: delta === undefined ? {} : delta };
	}

	/**
	 * Forget what a client held, so their next state send is a full snapshot (join / resync).
	 *
	 * KDM-252 N4: the SEQUENCE restarts with it. A reconnecting browser is a fresh page with a fresh
	 * counter, so leaving the server's number where the dead socket left it would hand the client a
	 * `seq` far ahead of its own and turn every subsequent frame into a false gap. Safe for the
	 * `resync` path too: a full snapshot re-baselines the client's counter to whatever it carries,
	 * and TCP does not reorder, so no in-flight frame can arrive after it with a higher number.
	 */
	_resetDelta(clientId) {
		this._lastSnap.delete(clientId);
		this._snapSeq.delete(clientId);
	}

	_broadcastState() {
		this._clearGrace();
		const tick = this.session.turn;
		// KD-098: forward the server's per-turn diagnostics to every client so they show up
		// in the browser console (no need to read the Docker terminal). Drained once per turn.
		let serverLog = (typeof this.session.takeDbg === 'function') ? this.session.takeDbg() : null;
		// KDM-186: forward whatever the 1 Hz stats ticker has emitted since the last turn. The ticker —
		// NOT this turn boundary — is the drain point: the pathology being measured is turns that STALL,
		// and a per-turn drain goes silent exactly when the stall it exists to explain is happening.
		if (this._statsLog && this._statsLog.length) {
			serverLog = this._statsLog.concat(serverLog || []);
			this._statsLog = [];
		}
		for (const [cid, sock] of this.sockets) {
			// KDM-206: turn-resolving states go through the SAME frame composer as the ui path, so
			// `_lastSnap` always matches what the client actually holds. A full snapshot sent here
			// without recording it would leave the next ui delta diffed against a base the client
			// never had.
			this._send(sock, Object.assign({ type: 'state', tick, serverLog }, this._stateFrame(cid)));
		}
	}

	close() {
		this._clearGrace();
		if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
		if (this._lagTimer) { clearInterval(this._lagTimer); this._lagTimer = null; }
		if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
		for (const s of this.sockets.values()) { try { s.end(); } catch (e) {} }
		if (this._server) this._server.close();
	}
}

module.exports = {
	WSBridge, encodeFrame, decodeFrames, acceptKey,
	// KDM-260 — exported so the drift guard can check the CLIENT's payload against them.
	HOST_JOIN_FIELDS, GUEST_JOIN_FIELDS, pickFields,
};
