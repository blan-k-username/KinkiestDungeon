/* =========================================================================
 * MP session resume.
 *
 * Makes a co-op session survive a browser reload or a transient network drop.
 * Under the host-authoritative model, resume is just state transfer in reverse:
 * a reconnecting client re-opens the same slot and adopts the host's next
 * `state_sync` (it does not replay a sequence).
 *
 * The write-side already exists — `MPHandleTurn` stamps
 * `KDGameData.multiplayer = {...MPState}` after each applied turn, so the
 * snapshot rides inside the save. This module is the missing read-side:
 *   - KDMPRestoreFromSave: rebuild MPState from a save's multiplayer block and
 *     hand back the rejoin descriptor (pure / no I/O — unit-testable).
 *   - KDMPBackoffDelay: reconnect schedule (1/2/4/8/16s, 30s cap).
 *   - KDMPResume / KDMPHandleDrop: re-open the socket; retry with backoff on a
 *     transient drop. The reconnect indicator is handled by the lobby overlay.
 *
 * Safety: restore is NOT hooked into KinkyDungeonLoadGame globally — the guest's
 * per-turn state_sync also calls KinkyDungeonLoadGame with a save that carries an
 * active multiplayer block, and auto-restoring there would clobber the guest's own
 * identity (MPApplyStateSync deliberately preserves MPState). Resume is an explicit
 * entry point the load/menu flow calls.
 * ========================================================================= */

interface KDMPRejoinDescriptor { host: string; port: number; session: string; player: number; }

/**
 * Reconnect backoff schedule: exponential 1s→2s→4s→8s→16s, capped at 30s.
 * Pure — `attempt` is 0-based. Used by the transient-drop retry loop.
 */
function KDMPBackoffDelay(attempt: number): number {
	const a = (typeof attempt === 'number' && attempt > 0) ? attempt : 0;
	return Math.min(1000 * Math.pow(2, a), 30000);
}

/**
 * Rebuild MPState from a save's `multiplayer` snapshot (defaults to the live
 * KDGameData). Returns the rejoin descriptor when the save carries an **active**
 * session, else null (single-player save ⇒ nothing to resume). Pure apart from
 * assigning MPState; opens no socket.
 */
function KDMPRestoreFromSave(saveData?: any): KDMPRejoinDescriptor | null {
	const src = saveData || (typeof KDGameData !== 'undefined' ? KDGameData : undefined);
	const snap = src && (src as any).multiplayer;
	if (!snap || !snap.active || typeof snap.sessionId !== 'string' || !snap.sessionId) return null;
	if (typeof MPDefaultState !== 'function') return null;
	// Start from a clean default and overlay the saved identity, but force the live
	// connection fields back to a pre-connect state — we're about to re-open the socket.
	const restored = MPDefaultState();
	restored.active = true;
	restored.playerId = typeof snap.playerId === 'number' ? snap.playerId : 0;
	restored.sessionId = snap.sessionId;
	restored.host = typeof snap.host === 'string' ? snap.host : '';
	restored.port = typeof snap.port === 'number' ? snap.port : 8080;
	restored.currentTurn = typeof snap.currentTurn === 'number' ? snap.currentTurn : 1;
	restored.wsState = 'closed';
	restored.peerConnected = false;
	restored.pendingLocalAction = null;
	MPState = restored;
	return { host: restored.host, port: restored.port, session: restored.sessionId, player: restored.playerId };
}

/**
 * Explicit resume entry point: restore MPState from the (loaded) save and re-open
 * the same slot via the server's rejoin path (`?session=&player=`). Resolves on a
 * successful rejoin; rejects (so the caller can fall back to the menu) when there's
 * nothing to resume or the session is gone (server `reject` / `410`-equivalent).
 */
function KDMPResume(saveData?: any): Promise<void> {
	const d = KDMPRestoreFromSave(saveData);
	if (!d || typeof MPConnect !== 'function') return Promise.reject(new Error('nothing_to_resume'));
	MPState.wsState = 'reconnecting';
	return MPConnect(d.host, d.port, { session: d.session, player: d.player });
}

/**
 * Transient-drop handler. Called when the socket
 * closes while the session is still active (i.e. an *unintentional* drop — an
 * explicit MPDisconnect clears `active` first, so this no-ops then). Retries the
 * rejoin with exponential backoff up to the 30s cap; gives up and surfaces a clean
 * failure once the server's GC grace has elapsed (rejoin rejected).
 */
function KDMPHandleDrop(): void {
	if (typeof MPState === 'undefined' || !MPState.active) return;       // intentional close ⇒ ignore
	if (!MPState.sessionId) return;                                     // never fully joined
	const attempt = MPState.reconnectAttempt || 0;
	const delay = KDMPBackoffDelay(attempt);
	MPState.reconnectAttempt = attempt + 1;
	MPState.wsState = 'reconnecting';
	if (typeof setTimeout !== 'function' || typeof MPConnect !== 'function') return;
	setTimeout(() => {
		if (!MPState.active) return;  // resolved/cancelled meanwhile
		MPConnect(MPState.host, MPState.port, { session: MPState.sessionId, player: MPState.playerId })
			.then(() => { MPState.reconnectAttempt = 0; })
			.catch(() => {
				// Still down: keep backing off until active is cleared (GC grace handled
				// by the server rejecting the rejoin → caller can fall back to the menu).
				if (MPState.active) KDMPHandleDrop();
			});
	}, delay);
}
