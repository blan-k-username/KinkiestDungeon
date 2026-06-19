#!/usr/bin/env node
/*
 * KD multiplayer server.
 *
 * Single Node process that serves the static game (drop-in replacement for
 * `http-server`) AND a WebSocket relay at `/mp` for two-player turn-batched
 * multiplayer. Authoritative only in the sense that it holds each player's
 * turn submission until both have arrived, then broadcasts both
 * simultaneously. It does NOT validate moves.
 *
 * Single session, hard cap 2 clients, in-memory state, no persistence.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = process.cwd();

const MIME = {
	'.js':   'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
	'.css':  'text/css',
	'.html': 'text/html',
	'.json': 'application/json', '.map': 'application/json',
	'.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
	'.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
	'.ico':  'image/x-icon',
	'.ogg':  'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
	'.ttf':  'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
	'.csv':  'text/csv', '.txt': 'text/plain', '.glsl': 'text/plain', '.frag': 'text/plain', '.vert': 'text/plain',
};

const GC_GRACE_MS = 5 * 60 * 1000;

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// ─── Session ──────────────────────────────────────────────────────────────

function createSession() {
	return {
		id: crypto.randomUUID(),
		currentTurn: 1,
		clients: [null, null],
		pendingActions: [null, null],
		pendingHashes:  [null, null],
		lastBroadcast: null,
		// Latest host full-state broadcast (host-authoritative).
		// Relayed verbatim; stashed so a rejoining guest can be re-synced.
		lastState: null,
		gcTimers: [null, null],
		// Host-minted join code. null when no host is waiting (the join
		// surface is closed). Set on host claim, cleared when slot 1 fills or the
		// host leaves while waiting.
		joinCode: null,
		// Brute-force lock-out. Count failed `bad_code` guest attempts on
		// the waiting session; once the threshold is hit, reject all guest joins
		// (even a correct code) until the cooldown elapses. Reset when a fresh host
		// claims the session (a new code is minted). Keyed per-session, not per-IP,
		// because IPs are spoofable on a hostile LAN and the waiting window is global.
		failedAttempts: 0,
		lockedUntil: 0,
	};
}

// ─── Brute-force lock-out tuning ──────────────────────────────────────────
const LOCKOUT_THRESHOLD = 5;            // failed guest codes before lock-out
const LOCKOUT_COOLDOWN_MS = 30 * 1000;  // how long the join surface stays locked

// ─── Join-code pairing ────────────────────────────────────────────────────

/**
 * Mint a fresh 4-digit join code as a zero-padded string. Server-authoritative;
 * `crypto.randomInt` avoids the modulo bias of `Math.random`.
 */
function mintJoinCode() {
	return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

/**
 * Classify a connect URL into an explicit intent. Precedence: an explicit host
 * claim, then a guest join (carries a code), then a code-free rejoin, else
 * invalid (the old unauthenticated free-slot path is gone).
 */
function parseConnectIntent(url) {
	if (url.searchParams.get('role') === 'host') return { kind: 'host' };
	const code = url.searchParams.get('code');
	if (code !== null) return { kind: 'guest', code };
	const session = url.searchParams.get('session');
	const player  = url.searchParams.get('player');
	if (session !== null && player !== null) {
		return { kind: 'rejoin', session, player: Number(player) };
	}
	return { kind: 'invalid' };
}

/**
 * Pure connect-validation — the single source of truth for slot assignment and
 * reject reasons (mirrors handleAction/handleStateHash so it is unit-testable
 * without sockets). Returns `{accept, slot, host?}` or `{reject, reason}`.
 */
function evaluateConnect(s, intent, now) {
	if (typeof now !== 'number') now = Date.now();
	switch (intent.kind) {
		case 'host':
			if (s.clients[0]) return { reject: true, reason: 'already_hosting' };
			// A fresh host claim mints a new code, so the prior lock-out is
			// no longer meaningful — clear it for the new waiting window.
			s.failedAttempts = 0;
			s.lockedUntil = 0;
			return { accept: true, slot: 0, host: true };
		case 'guest':
			if (s.clients[1]) return { reject: true, reason: 'slot_taken' };
			if (!s.clients[0] || !s.joinCode) return { reject: true, reason: 'not_waiting' };
			// While locked out, reject every guest attempt — including a
			// correct code — until the cooldown elapses.
			if (s.lockedUntil && now < s.lockedUntil) return { reject: true, reason: 'locked_out' };
			if (intent.code !== s.joinCode) {
				s.failedAttempts += 1;
				if (s.failedAttempts >= LOCKOUT_THRESHOLD) {
					s.lockedUntil = now + LOCKOUT_COOLDOWN_MS;
					return { reject: true, reason: 'locked_out' };
				}
				return { reject: true, reason: 'bad_code' };
			}
			// Correct code: clear the failure counter for a clean session.
			s.failedAttempts = 0;
			s.lockedUntil = 0;
			return { accept: true, slot: 1 };
		case 'rejoin':
			if (intent.session !== s.id) return { reject: true, reason: 'session_gone' };
			if (intent.player !== 0 && intent.player !== 1) return { reject: true, reason: 'bad_player' };
			if (s.clients[intent.player]) return { reject: true, reason: 'slot_taken' };
			return { accept: true, slot: intent.player };
		default:
			return { reject: true, reason: 'missing_credentials' };
	}
}

let session = createSession();

function send(client, msg) {
	if (!client || !client.ws) return;
	try { client.ws.send(JSON.stringify(msg)); } catch (_) { /* swallow */ }
}

function broadcast(s, msg) {
	for (const c of s.clients) send(c, msg);
}

// ─── Message handlers (pure-ish — exported for unit tests) ────────────────

/**
 * Apply a client → server `action` message. Returns either an error message
 * to send to the sender, or a broadcast message (when both players have
 * submitted) — or null when the action was accepted and we are still
 * waiting for the other player.
 */
function handleAction(s, playerId, msg) {
	if (msg.turn !== s.currentTurn) {
		return { kind: 'reply', message: { type: 'error', code: 'wrong_turn', expected: s.currentTurn } };
	}
	if (s.pendingActions[playerId] !== null) {
		return { kind: 'reply', message: { type: 'error', code: 'duplicate_submission' } };
	}
	s.pendingActions[playerId] = msg.action;
	const other = playerId === 0 ? 1 : 0;
	if (s.pendingActions[other] === null) {
		return null;  // still waiting
	}
	const broadcastMsg = {
		type: 'turn',
		turn: s.currentTurn,
		actions: [
			{ playerId: 0, action: s.pendingActions[0] },
			{ playerId: 1, action: s.pendingActions[1] },
		],
	};
	s.lastBroadcast = broadcastMsg;
	s.pendingActions = [null, null];
	s.pendingHashes  = [null, null];
	s.currentTurn += 1;
	return { kind: 'broadcast', message: broadcastMsg };
}

/**
 * Apply a `state_hash` message. Compares once both have arrived; emits a
 * desync broadcast if they differ, otherwise null.
 */
function handleStateHash(s, playerId, msg) {
	if (typeof msg.turn !== 'number' || typeof msg.hash !== 'string') return null;
	s.pendingHashes[playerId] = msg;
	const other = playerId === 0 ? 1 : 0;
	if (!s.pendingHashes[other] || s.pendingHashes[other].turn !== msg.turn) return null;
	const a = s.pendingHashes[0];
	const b = s.pendingHashes[1];
	s.pendingHashes = [null, null];
	if (a.hash !== b.hash) {
		return {
			kind: 'broadcast',
			message: { type: 'desync', turn: msg.turn, hashes: { 0: a.hash, 1: b.hash } },
		};
	}
	return null;
}

// ─── HTTP (static) ────────────────────────────────────────────────────────

function reply(res, code, body, headers) {
	res.writeHead(code, Object.assign({ 'content-type': 'text/plain' }, headers || {}));
	res.end(body);
}

function serveStatic(req, res) {
	// Test-only endpoint: integration tests run against a single long-lived
	// server process; this lets them clear session state between specs.
	if (req.url === '/_test/reset') {
		// Force-close any lingering sockets in either slot.
		for (const c of session.clients) {
			if (c && c.ws) { try { c.ws.close(); } catch (_) { /* swallow */ } }
		}
		for (const t of session.gcTimers) if (t) clearTimeout(t);
		session = createSession();
		return reply(res, 200, 'ok');
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return reply(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
	}
	let urlPath;
	try {
		urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	} catch (_) {
		return reply(res, 400, 'bad url');
	}
	if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

	const resolved = path.normalize(path.join(ROOT, urlPath));
	if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
		return reply(res, 403, 'forbidden');
	}

	fs.stat(resolved, (err, st) => {
		if (err || !st.isFile()) return reply(res, 404, 'not found');
		const mime = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
		res.writeHead(200, { 'content-type': mime, 'content-length': st.size });
		if (req.method === 'HEAD') return res.end();
		fs.createReadStream(resolved).on('error', () => res.destroy()).pipe(res);
	});
}

// ─── WebSocket lifecycle ─────────────────────────────────────────────────

function attachWS(httpServer) {
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', (req, sock, head) => {
		const url = new URL(req.url, 'http://x');
		if (url.pathname !== '/mp') return sock.destroy();

		// Classify the connect, then validate against session state. The
		// old unauthenticated free-slot path is gone — every connection is a host
		// claim, a code-bearing guest join, or a code-free rejoin.
		const intent = parseConnectIntent(url);
		const verdict = evaluateConnect(session, intent, Date.now());

		// A browser WebSocket cannot read an HTTP handshake rejection (it only
		// sees onclose/1006 with no reason). So we ACCEPT the upgrade and then
		// send a typed `reject` message before closing — that's the only way the
		// client UI can learn *why* a join failed.
		if (verdict.reject) {
			return wss.handleUpgrade(req, sock, head, (ws) => {
				send({ ws }, { type: 'reject', reason: verdict.reason });
				try { ws.close(); } catch (_) { /* swallow */ }
			});
		}

		wss.handleUpgrade(req, sock, head, (ws) => onConnection(ws, verdict, intent, req));
	});

	return wss;
}

function onConnection(ws, verdict, intent, req) {
	const slotId = verdict.slot;
	const isRejoin = intent.kind === 'rejoin';
	const client = {
		ws,
		playerId: slotId,
		ip: (req.socket && req.socket.remoteAddress) || '?',
		connectedAt: Date.now(),
	};
	session.clients[slotId] = client;
	if (session.gcTimers[slotId]) {
		clearTimeout(session.gcTimers[slotId]);
		session.gcTimers[slotId] = null;
	}

	// A host claim mints a fresh code; a guest filling slot 1 closes the
	// join window (single-use).
	if (verdict.host) session.joinCode = mintJoinCode();
	else if (slotId === 1 && !isRejoin) session.joinCode = null;

	log('[ws] connect', 'player=' + slotId, 'session=' + session.id, intent.kind);

	const hello = { type: 'hello', playerId: slotId, sessionId: session.id, currentTurn: session.currentTurn };
	if (verdict.host) hello.joinCode = session.joinCode;  // host-only
	send(client, hello);
	if (isRejoin && session.lastBroadcast) send(client, session.lastBroadcast);

	const other = slotId === 0 ? 1 : 0;
	if (session.clients[other]) {
		// Notify the pre-existing peer that this client joined…
		send(session.clients[other], { type: 'peer_connected', playerId: slotId });
		// …and tell the JOINER its peer is already here, so both sides agree on
		// peerConnected. Without this the joiner's peerConnected stayed false (it
		// only ever received peer_disconnected), which would wrongly block the
		// joiner's input. (Without this guard it was a latent cosmetic bug —
		// the joiner's overlay falsely showed "peer lost".)
		send(client, { type: 'peer_connected', playerId: other });
	}

	ws.on('message', (data) => {
		let msg;
		try { msg = JSON.parse(data.toString()); } catch (_) {
			return send(client, { type: 'error', code: 'bad_message' });
		}
		if (!msg || typeof msg.type !== 'string') {
			return send(client, { type: 'error', code: 'bad_message' });
		}
		switch (msg.type) {
			case 'action': {
				const out = handleAction(session, slotId, msg);
				if (!out) return;
				if (out.kind === 'reply') return send(client, out.message);
				if (out.kind === 'broadcast') return broadcast(session, out.message);
				return;
			}
			case 'state_hash': {
				const out = handleStateHash(session, slotId, msg);
				if (out && out.kind === 'broadcast') broadcast(session, out.message);
				return;
			}
			case 'session_init': {
				// Host → guest start-state sync. Relay verbatim to the peer
				// so both clients run the same deterministic init (seed + date).
				const other = slotId === 0 ? 1 : 0;
				if (session.clients[other]) send(session.clients[other], msg);
				return;
			}
			case 'mod_list': {
				// A client announces its loaded-mod fingerprint. Dumb relay to
				// the peer, which compares against its own set and warns (never blocks).
				const other = slotId === 0 ? 1 : 0;
				if (session.clients[other]) send(session.clients[other], msg);
				return;
			}
			case 'state_sync': {
				// Host → guest full-state broadcast. Relay verbatim to the peer
				// (dumb relay — no game logic server-side) and stash the latest
				// so a rejoining guest can be re-synced.
				const other = slotId === 0 ? 1 : 0;
				if (session.clients[other]) send(session.clients[other], msg);
				session.lastState = msg;
				return;
			}
			case 'player_character': {
				// Guest → host transfer of a guest-built character. The backend is the
				// authority for compliance: validate the package shape/size before
				// relaying, so a tampered or oversized client can't push junk to the peer.
				const pkg = msg.pkg;
				const slotOk = msg.playerSlot === 0 || msg.playerSlot === 1;
				const pkgOk = pkg && typeof pkg === 'object' && !Array.isArray(pkg)
					&& (pkg.class === undefined || (typeof pkg.class === 'string' && pkg.class.length <= 64))
					&& (pkg.dress === undefined || (typeof pkg.dress === 'string' && pkg.dress.length <= 64));
				let sizeOk = false;
				try { sizeOk = JSON.stringify(msg).length <= 256 * 1024; } catch (_) { sizeOk = false; }
				if (!slotOk || !pkgOk || !sizeOk) {
					return send(client, { type: 'error', code: 'bad_player_config' });
				}
				const other = slotId === 0 ? 1 : 0;
				if (session.clients[other]) send(session.clients[other], msg);
				return;
			}
			case 'ping':
				return send(client, { type: 'pong' });
			default:
				return send(client, { type: 'error', code: 'bad_message' });
		}
	});

	ws.on('close', () => onClose(slotId));
	ws.on('error', () => onClose(slotId));
}

function onClose(slotId) {
	if (!session.clients[slotId]) return;
	session.clients[slotId] = null;
	// If the host leaves while still waiting (no guest yet), close the
	// join window so the now-stale code admits no one.
	if (slotId === 0 && !session.clients[1]) session.joinCode = null;
	log('[ws] close', 'player=' + slotId);
	const other = slotId === 0 ? 1 : 0;
	if (session.clients[other]) {
		send(session.clients[other], { type: 'peer_disconnected', playerId: slotId, willReconnect: true });
	}
	session.gcTimers[slotId] = setTimeout(() => {
		if (!session.clients[0] && !session.clients[1]) {
			session = createSession();
			log('[session] reset (both slots idle past GC grace)');
		}
	}, GC_GRACE_MS);
}

// ─── Boot / exports ───────────────────────────────────────────────────────

function createApp() {
	const httpServer = http.createServer(serveStatic);
	attachWS(httpServer);
	return httpServer;
}

if (require.main === module) {
	const httpServer = createApp();
	httpServer.listen(PORT, () => log('mp-server listening :' + PORT + ' (session=' + session.id + ')'));
} else {
	module.exports = {
		createApp,
		createSession,
		handleAction,
		handleStateHash,
		parseConnectIntent,
		mintJoinCode,
		evaluateConnect,
		_resetSessionForTests: () => { session = createSession(); },
		_getSessionForTests: () => session,
	};
}
