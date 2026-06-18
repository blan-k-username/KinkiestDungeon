/* =========================================================================
 * MP input bridge.
 *
 * Sits between KDSendInput (`KinkyDungeonInput.ts:1578`) and the input
 * queue. When MPState.active is true, locally-submitted inputs are encoded
 * and sent to the server instead of enqueued; both players' actions are
 * enqueued together when the server's `turn` broadcast arrives.
 *
 * KDSendInput itself gets a 3-line conditional branch added. We do not
 * monkey-patch from inside this file at module-load time, because doing so
 * would break tests that import the bundle without an active multiplayer
 * session. KDSendInput's branch is conditional on MPState.active.
 * ========================================================================= */

/**
 * Intercept a locally-submitted input when an MP session is active. Returns
 * `true` if the input was sent over the wire (and therefore should NOT be
 * pushed onto the local KinkyDungeonInputQueue), `false` otherwise.
 *
 * This is what KDSendInput's MP branch should call once installed.
 */
function MPInterceptLocalInput(type: string, data: any): boolean {
	if (!MPState.active || MPState.wsState !== 'open') return false;
	// A co-op turn cannot advance while a player is missing. Block (swallow) all
	// local input while a *previously-connected* peer is gone — neither enqueue it
	// locally nor send it — until the disconnect popup is resolved (Wait/Close).
	// The `peerEverConnected` latch avoids blocking during the initial handshake,
	// before the guest's first `peer_connected` arrives.
	if (MPState.peerEverConnected && !MPState.peerConnected) return true;
	if (MPState.pendingLocalAction && MPState.pendingLocalAction.turn === MPState.currentTurn) {
		// Already submitted for this turn — drop without enqueue (the server
		// would reject a duplicate too, but we save the round-trip).
		return true;
	}
	const encoded = MPEncodeAction(MPState.currentTurn, type, data);
	if (!encoded) {
		// Non-serializable payload (rare). Fall back to local-only enqueue;
		// the simulation may desync but at least won't hang.
		return false;
	}
	MPState.pendingLocalAction = { turn: MPState.currentTurn, type, data };
	MPSendRaw(encoded);
	return true;
}

/**
 * Apply a server `turn` broadcast under the host-authoritative model.
 *
 * - HOST (playerId 0) is the source of truth: it enqueues both players' actions
 *   in deterministic order, drains the queue, ticks time, then broadcasts its
 *   full state (MPBroadcastHostState) so the guest can adopt it. It also sends
 *   an integrity state-hash.
 * - GUEST (playerId 1) does NOT simulate: it only advances the turn gate (to stay
 *   aligned with the server) and clears its pending action. The world arrives via
 *   the follow-up `state_sync` (handled by MPApplyStateSync); the server always
 *   relays `turn` before the host's `state_sync`, so ordering holds.
 *
 * This is the function MPClient.onmessage routes the `turn` message to.
 */
function MPHandleTurn(msg: { turn: number; actions: { playerId: number; action: { type: string; data: any } }[] }): void {
	if (msg.turn !== MPState.currentTurn) return;  // stale broadcast — drop

	if (MPState.playerId === 0) {
		// Host: authoritative apply.
		// Make sure the second avatar exists before applying its action, and tag each
		// enqueued action with its player slot so the move handler routes a non-local
		// player's move to that slot's entity (KDInputTypes["move"]).
		if (typeof KDEnsureCoopPlayers === 'function') KDEnsureCoopPlayers();
		let sorted = msg.actions.slice().sort((a, b) => a.playerId - b.playerId);
		// Host-authoritative conflict resolution. If both players' moves target the
		// same tile, the seeded RNG cancels the loser's move (it holds) so two
		// players never end a turn on the same tile. Deterministic ⇒ the guest's
		// broadcast view agrees. No-op for single-mover turns.
		if (typeof KDApplyTurnConflicts === 'function') sorted = KDApplyTurnConflicts(sorted);
		for (const { playerId, action } of sorted) {
			KinkyDungeonInputQueue.push({ type: action.type, data: Object.assign({}, action.data, { _playerSlot: playerId }) });
		}
		KDProcessInputs();
		KinkyDungeonAdvanceTime(1);
		MPBroadcastHostState(msg.turn);  // serialize + send state_sync + integrity hash
	}
	// Guest: nothing to apply here — state arrives via state_sync. Both roles
	// advance the gate and clear pending so the next turn can be submitted.
	MPState.currentTurn += 1;
	MPState.pendingLocalAction = null;
	if (typeof KDGameData !== 'undefined' && KDGameData) {
		// Snapshot MPState into the save so reload mid-session can resume.
		(KDGameData as any).multiplayer = Object.assign({}, MPState);
	}
}

/**
 * Serialize the host's full game state and broadcast it as a `state_sync` (the
 * guest adopts it verbatim). Shared by the per-turn loop and the initial
 * game-start push (MPHostStartSession). Uses the proven save path
 * (KinkyDungeonGenerateSaveData → JSON → LZString), identical to
 * save-load-roundtrip.spec.ts. Guarded so a non-bundle/test context is a no-op.
 */
function MPBroadcastHostState(turn: number): void {
	if (typeof KinkyDungeonGenerateSaveData !== 'function' || typeof LZString === 'undefined') return;
	let payload: string;
	try {
		payload = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
	} catch (_) {
		return;  // non-serializable state — skip this push rather than crash the turn
	}
	MPSendRaw(MPEncodeStateSync(turn, payload));
	// Integrity tag over the transmitted bytes — NOT the live KDGameData, whose
	// derived per-avatar fields (HeelPower, HunterTimer, …) are recomputed locally
	// and legitimately differ post-load. Both sides hash the same payload string,
	// so the server's desync check confirms transport fidelity without false-firing.
	if (typeof MPHashString === 'function') {
		const h = MPHashString(payload);
		MPState.lastSyncHash = h;
		MPSendRaw(MPEncodeStateHash(turn, h));
	}
}

/**
 * Guest-side adoption of a host `state_sync`: load the host's full state verbatim
 * (host-authoritative — the guest does not simulate), preserving the guest's live
 * connection identity across the load, then reply with an integrity state-hash
 * (which now matches the host's trivially, since the guest holds the host's exact
 * bytes). The host ignores its own echo.
 */
function MPApplyStateSync(msg: { turn: number; state: string }): void {
	if (MPState.playerId === 0) return;           // host is authoritative — ignore echo
	if (typeof msg.state !== 'string') return;
	const preserved = MPState;                    // restored below to keep our connection identity
	if (typeof KinkyDungeonLoadGame === 'function') {
		try { KinkyDungeonLoadGame(msg.state, true); } catch (_) { /* keep prior state */ }
	}
	MPState = preserved;                          // restore our own connection identity
	if (typeof KinkyDungeonState !== 'undefined') KinkyDungeonState = 'Game';
	// The first host state ends the guest's "Waiting for host…" screen.
	if (typeof KDLobbyStatus !== 'undefined' && KDLobbyStatus && KDLobbyStatus.phase === 'waiting_host') {
		KDLobbyStatus = { phase: 'idle' };
	}
	// Integrity tag over the received bytes (matches the host's send hash).
	if (typeof MPHashString === 'function') {
		const h = MPHashString(msg.state);
		MPState.lastSyncHash = h;
		MPSendRaw(MPEncodeStateHash(msg.turn, h));
	}
	if (typeof KDGameData !== 'undefined' && KDGameData) {
		(KDGameData as any).multiplayer = Object.assign({}, MPState);
	}
}
