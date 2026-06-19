/* =========================================================================
 * MP client connection lifecycle.
 *
 * Owns the WebSocket. Public surface:
 *   - MPConnect(host, port, opts?): Promise<void> — opens session, waits for hello.
 *       opts: {role:'host'} | {code} | {session,player}. Omitting opts
 *       connects with no credentials and the server refuses (`missing_credentials`).
 *   - MPDisconnect(): void
 *   - MPSendRaw(json: string): void — used by MPInputBridge
 *
 * Incoming message dispatch routes to handlers in this file or, for `turn`
 * broadcasts, to MPInputBridge's broadcast handler.
 * ========================================================================= */

let MPClientWS: WebSocket | null = null;

function MPConnect(host: string, port: number, opts?: MPConnectOpts): Promise<void> {
	return new Promise((resolve, reject) => {
		MPState.host = host;
		MPState.port = port;
		MPState.wsState = 'connecting';
		// opts picks the connect intent. No opts → bare /mp, which the
		// server now rejects (the old unauthenticated path is gone).
		const url = opts ? MPBuildConnectURL(host, port, opts) : ('ws://' + host + ':' + port + '/mp');
		try {
			MPClientWS = new WebSocket(url);
		} catch (err) {
			MPState.wsState = 'closed';
			return reject(err);
		}
		const ws = MPClientWS;
		ws.onopen = () => { /* no-op: hello completes the handshake */ };
		ws.onerror = () => {
			MPState.wsState = 'closed';
			reject(new Error('ws error'));
		};
		ws.onclose = () => {
			MPState.wsState = 'closed';
			// Distinguish an intentional close (MPDisconnect clears `active` first ⇒
			// active is false here) from a transient drop (active still true). For a
			// transient drop in a joined session, retry the rejoin with backoff;
			// otherwise finalize as closed.
			if (MPState.active && MPState.sessionId && typeof KDMPHandleDrop === 'function') {
				KDMPHandleDrop();
			} else {
				MPState.active = false;
			}
		};
		ws.onmessage = (ev) => {
			const msg = MPParseMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
			if (!msg) return;
			switch (msg.type) {
				case 'hello':
					MPState.playerId = msg.playerId;
					MPState.sessionId = msg.sessionId;
					MPState.currentTurn = msg.currentTurn;
					MPState.wsState = 'open';
					MPState.active = true;
					MPState.reconnectAttempt = 0;
					// Only the host receives a joinCode in hello.
					MPState.joinCode = typeof msg.joinCode === 'string' ? msg.joinCode : null;
					resolve();
					return;
				case 'reject':
					// Typed connect rejection (bad_code, not_waiting, slot_taken,
					// already_hosting, missing_credentials). Reject the connect promise
					// with the reason so the lobby can surface a user-readable message.
					MPState.wsState = 'closed';
					MPState.active = false;
					reject(new Error(typeof msg.reason === 'string' ? msg.reason : 'rejected'));
					return;
				case 'session_init':
					// Host announced the shared seed + date — run the same deterministic
					// init so both clients start byte-identical.
					if (typeof MPStartSharedGame === 'function' && typeof msg.seed === 'string') {
						MPStartSharedGame(msg.seed, typeof msg.todayDate === 'number' ? msg.todayDate : 0);
					}
					return;
				case 'mod_list':
					// Host announced its mod fingerprint — compare to ours and stash a
					// non-blocking warning (rendered by the lobby).
					if (typeof KDReceiveHostModList === 'function') KDReceiveHostModList(msg.list);
					return;
				case 'turn':
					MPHandleTurn(msg as any);
					return;
				case 'state_sync':
					// Host full-state broadcast — guest adopts it.
					MPApplyStateSync(msg as any);
					return;
				case 'player_character':
					// Guest → host transfer of a guest-built character. Stash it by slot;
					// KDSpawnPlayer2 installs it as the avatar (and if the avatar already
					// exists, apply to it live so the next broadcast carries the look).
					if (typeof msg.playerSlot === 'number' && msg.pkg && typeof KDCoopSlotConfig !== 'undefined') {
						KDCoopSlotConfig[msg.playerSlot] = msg.pkg;
						if (typeof KDFindPlayerSlotEntity === 'function' && KDFindPlayerSlotEntity(msg.playerSlot)
							&& typeof KDApplyCoopCharacterPackage === 'function') {
							KDApplyCoopCharacterPackage(msg.playerSlot, msg.pkg);
						}
					}
					return;
				case 'peer_connected':
					MPState.peerConnected = true;
					// Latch that a peer has been present (so a *later* drop arms the
					// disconnect popup + input-block), and clear the "Wait" choice so a
					// future drop re-pops the modal and unblocks input.
					MPState.peerEverConnected = true;
					MPState.disconnectWaiting = false;
					return;
				case 'peer_disconnected':
					MPState.peerConnected = false;
					return;
				case 'desync':
					// Record the turn so KDMPOverlayState() can show a banner.
					MPState.lastDesyncTurn = typeof msg.turn === 'number' ? msg.turn : MPState.currentTurn;
					return;
				case 'error':
				case 'pong':
					// passively logged.
					return;
			}
		};
	});
}

function MPDisconnect(): void {
	if (MPClientWS) {
		try { MPClientWS.close(); } catch (_) { /* swallow */ }
		MPClientWS = null;
	}
	MPState.wsState = 'closed';
	MPState.active = false;
}

function MPSendRaw(json: string): void {
	if (!MPClientWS || MPClientWS.readyState !== 1 /* OPEN */) return;
	try { MPClientWS.send(json); } catch (_) { /* swallow */ }
}

/**
 * Guest → host: send a locally-built character package for the guest's slot (1). The
 * host validates (server compliance check) and installs it as the avatar. No-op if the
 * package isn't serializable.
 */
function KDSendPlayerCharacter(pkg: any, slot: number = 1): void {
	if (typeof MPEncodePlayerCharacter !== 'function') return;
	const wire = MPEncodePlayerCharacter(slot, pkg);
	if (wire) MPSendRaw(wire);
}
