/* =========================================================================
 * MP disconnect handling.
 *
 * A co-op turn cannot advance until every player has committed, so when a peer
 * drops the surviving client must stop and decide. This module provides a
 * *blocking* disconnect popup with two choices:
 *
 *   - Wait  → keep the session paused, waiting for the peer to rejoin (the
 *             server's rejoin grace handles the reconnect). The modal collapses
 *             to a passive banner; input stays blocked until the peer returns
 *             (peer_connected clears disconnectWaiting).
 *   - Close → auto-save the latest state, end the co-op session, and fall back
 *             to single-player.
 *
 * The popup is a pure derivation of MPState (active + !peerConnected), so the
 * flow is testable without canvas clicks — the drawn buttons just call these
 * same functions. Input is blocked while a player is missing by an early guard
 * in MPInterceptLocalInput, so no turn can advance.
 * ========================================================================= */

/**
 * Should the blocking disconnect modal be shown right now? True only in an
 * active session whose peer has dropped and the local player has not yet chosen
 * "Wait" (which dismisses the modal but keeps the session paused).
 */
function KDMPDisconnectPopupActive(): boolean {
	if (typeof MPState === 'undefined') return false;
	// Only after a peer was actually present and is now gone (peerEverConnected),
	// so the initial connect handshake never pops the modal.
	return !!(MPState.active && MPState.peerEverConnected && !MPState.peerConnected && !MPState.disconnectWaiting);
}

/**
 * "Wait" — dismiss the modal but keep the session alive and paused. A passive
 * "opponent disconnected" banner (KDMPOverlayState → peer_lost) remains, and
 * input stays blocked until the peer rejoins. Reconnect (peer_connected) resets
 * `disconnectWaiting` so a *future* drop pops the modal again.
 */
function KDMPDisconnectWait(): void {
	if (typeof MPState === 'undefined') return;
	MPState.disconnectWaiting = true;
}

/**
 * "Close session" — auto-save the current state, tear down the co-op session,
 * drop the second avatar, and return to single-player. Auto-save uses the same
 * queue path as the game's own saves (KinkyDungeonSaveGame), so the player can
 * resume their run solo from where co-op left off.
 */
function KDMPCloseSession(): void {
	// 1) Auto-save the latest state via the standard save queue.
	if (typeof KinkyDungeonSaveGame === 'function') {
		try { KinkyDungeonSaveGame(false); } catch (_) { /* best-effort autosave */ }
	}
	// 2) Tear down the socket + session identity.
	if (typeof MPDisconnect === 'function') MPDisconnect();
	if (typeof MPResetState === 'function') MPResetState();
	else if (typeof MPState !== 'undefined') { MPState.active = false; MPState.peerConnected = false; }
	if (typeof MPSessionStarted !== 'undefined') MPSessionStarted = false;
	// 3) Re-localize to slot 0 and drop the now-orphaned P2 avatar.
	if (typeof KDSyncLocalPlayerSlot === 'function') KDSyncLocalPlayerSlot();
	// 4) Fall back to single-player gameplay.
	if (typeof KinkyDungeonState !== 'undefined') KinkyDungeonState = 'Game';
}
