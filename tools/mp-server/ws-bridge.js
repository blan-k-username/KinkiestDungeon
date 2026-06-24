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
		this.session = new SwapSession(opts);
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
			for (const m of messages) {
				if (m === null) { socket.end(); return; }
				let msg; try { msg = JSON.parse(m); } catch (e) { continue; }
				clientId = this._handle(socket, msg, clientId);
			}
		});
		socket.on('error', () => {});
	}

	_send(socket, obj) { socket.write(encodeFrame(JSON.stringify(obj))); }

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
				let res = this.session.submit(clientId, msg.action || {});
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

	_broadcastState() {
		this._clearGrace();
		const tick = this.session.turn;
		// KD-098: forward the server's per-turn diagnostics to every client so they show up
		// in the browser console (no need to read the Docker terminal). Drained once per turn.
		const serverLog = (typeof this.session.takeDbg === 'function') ? this.session.takeDbg() : null;
		for (const [cid, sock] of this.sockets) {
			const snapshot = this.session.snapshotFor(cid);
			this._send(sock, { type: 'state', tick, snapshot, serverLog });
		}
	}

	close() {
		this._clearGrace();
		for (const s of this.sockets.values()) { try { s.end(); } catch (e) {} }
		if (this._server) this._server.close();
	}
}

module.exports = { WSBridge, encodeFrame, decodeFrames, acceptKey };
