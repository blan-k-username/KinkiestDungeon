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
 * The turn advances only when EVERY player has submitted (R8 lockstep). On advance the
 * server composes each client's render-state from the ONE authoritative world + that
 * client's state bundle (SwapSession.snapshotFor) — exactly what KDRenderClient.apply()
 * consumes in the browser. `tick` is the session turn counter (+1 per resolved turn).
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { SwapSession } = require('./swap-session');

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
		this.sockets = new Map();          // clientId -> socket
		this._server = null;
		this.port = null;
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
		socket.on('error', () => {});
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

	_handle(socket, msg, clientId) {
		if (msg.type === 'join') {
			try {
				clientId = msg.clientId;
				this.sockets.set(clientId, socket);
				// Reload-friendly (KD-098): a KNOWN player reconnecting to an already-started
				// session just REATTACHES its new socket and re-syncs — calling join() again
				// would throw "session already started". This lets you reload a tab mid-session
				// (e.g. to re-read the diagnostics) without restarting the server.
				if (this.session.started && this.session.players.includes(clientId)) {
					this._send(socket, { type: 'joined', clientId, started: true, players: this.session.players });
					try { this._send(socket, { type: 'state', tick: this.session.turn, snapshot: this.session.snapshotFor(clientId) }); } catch (e) { /* ignore */ }
					return clientId;
				}
				const r = this.session.join(clientId);
				this._send(socket, { type: 'joined', clientId, started: r.started, players: this.session.players });
				if (r.started) this._broadcastState();   // both in → push initial render-state
			} catch (e) {
				this._send(socket, { type: 'error', error: String(e && e.message || e) });
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
					this._send(socket, {
						type: 'state', kind: 'ui', tick: this.session.turn, srv: this._srvStamp(applyMs),
						snapshot: this.session.snapshotFor(clientId),
					});
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
			const snapshot = this.session.snapshotFor(cid);
			this._send(sock, { type: 'state', tick, snapshot, serverLog });
		}
	}

	close() {
		this._clearGrace();
		if (this._lagTimer) { clearInterval(this._lagTimer); this._lagTimer = null; }
		if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
		for (const s of this.sockets.values()) { try { s.end(); } catch (e) {} }
		if (this._server) this._server.close();
	}
}

module.exports = { WSBridge, encodeFrame, decodeFrames, acceptKey };
