/**
 * tools/mp-server/ws-bridge.js  (KD-071, epic mp-mvp / KD-066)
 *
 * Minimal, dependency-free local WebSocket bridge between browser thin-clients and
 * a server-side CoopSession. A browser can't do in-process/worker IPC, so even on
 * localhost the client↔server link is a WebSocket. We hand-roll a tiny RFC6455
 * server on Node's built-in http+crypto (no `ws` dependency) — text frames only,
 * which is all the protocol needs.
 *
 * Protocol (JSON text frames):
 *   client → server : { type:'join', clientId }            register a player
 *                      { type:'input', action:{dx,dy} }     submit this turn's action
 *   server → client : { type:'joined', clientId, started }  ack
 *                      { type:'state', tick, snapshot }      this client's render-state
 *                      { type:'waiting', waitingOn:[...] }    barrier still open
 *
 * On every player's input the session advances one turn (KD-069 barrier) and the
 * server pushes each client its own player instance's render-state snapshot
 * (KD-067) — exactly what KDRenderClient.apply() consumes in the browser.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { CoopSession } = require('./coop-session');

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
		this.session = new CoopSession(opts);
		this.sockets = new Map();          // clientId -> socket
		this._server = null;
		this.port = null;
	}

	listen(port = 0) {
		return new Promise((resolve) => {
			this._server = http.createServer((_req, res) => { res.writeHead(426); res.end('Upgrade Required'); });
			this._server.on('upgrade', (req, socket) => this._onUpgrade(req, socket));
			this._server.listen(port, '127.0.0.1', () => {
				this.port = this._server.address().port;
				resolve(this.port);
			});
		});
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
			clientId = msg.clientId;
			this.sockets.set(clientId, socket);
			const r = this.session.join(clientId);
			this._send(socket, { type: 'joined', clientId, started: r.started });
			if (r.started) this._broadcastState();   // both in → push initial render-state
			return clientId;
		}
		if (msg.type === 'input' && clientId && this.session.started) {
			try {
				const res = this.session.submit(clientId, msg.action || {});
				if (res.advanced) this._broadcastState();
				else this._send(socket, { type: 'waiting', waitingOn: res.waitingOn });
			} catch (e) {
				this._send(socket, { type: 'error', error: String(e && e.message || e) });
			}
		}
		return clientId;
	}

	/** Push each connected client its OWN player instance's render-state snapshot. */
	_broadcastState() {
		for (const [cid, sock] of this.sockets) {
			const inst = this.session.instanceOf(cid);
			if (!inst) continue;
			const snapshot = inst.serializeRenderState();
			this._send(sock, { type: 'state', tick: this.session.orch.ticks().world, snapshot });
		}
	}

	close() {
		for (const s of this.sockets.values()) { try { s.end(); } catch (e) {} }
		if (this._server) this._server.close();
	}
}

module.exports = { WSBridge, encodeFrame, decodeFrames, acceptKey };
