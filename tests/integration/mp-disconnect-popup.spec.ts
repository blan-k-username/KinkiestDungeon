/**
 * Disconnect blocking popup + auto-save (Wait | Close).
 *
 * Single-page tests (no two-client). They drive the pure session functions the
 * drawn buttons call: the popup is active iff an active session's peer is gone
 * and "Wait" hasn't been chosen; local input is blocked while the peer is
 * missing; "Wait" collapses the modal but keeps blocking; reconnect clears it;
 * "Close" auto-saves and returns to single-player.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('peer drop raises the blocking popup and blocks local input', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — simulate an active session whose peer was present then dropped
		MPState.active = true; MPState.wsState = 'open'; MPState.peerEverConnected = true; MPState.peerConnected = false;
		MPState.disconnectWaiting = false; MPState.currentTurn = 5; MPState.pendingLocalAction = null;
		// @ts-ignore
		const popup = KDMPDisconnectPopupActive();
		// @ts-ignore — input must be swallowed (true = handled, NOT enqueued) and nothing queued
		const blocked = MPInterceptLocalInput('move', { dir: { x: 1, y: 0 } });
		const out = { popup, blocked, pending: MPState.pendingLocalAction };
		// @ts-ignore
		MPResetState();
		return out;
	});
	expect(r.popup).toBe(true);
	expect(r.blocked).toBe(true);          // intercepted
	expect(r.pending).toBeNull();          // but NOT submitted as a pending action
});

test('the initial handshake (peer not yet connected) never blocks input or pops the modal', async ({ kdPage }) => {
	// Regression guard: before the first peer_connected arrives, peerEverConnected is
	// false, so a just-connected client (esp. the guest) must still be able to submit
	// its turn-1 action — the disconnect popup/block only engage after a real drop.
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — active session, peer handshake not yet completed
		MPState.active = true; MPState.wsState = 'open';
		MPState.peerEverConnected = false; MPState.peerConnected = false;
		MPState.disconnectWaiting = false; MPState.currentTurn = 1; MPState.pendingLocalAction = null;
		// @ts-ignore
		const popup = KDMPDisconnectPopupActive();
		// @ts-ignore — input must NOT be blocked: it submits (pendingLocalAction set)
		MPInterceptLocalInput('move', { dir: { x: 1, y: 0 } });
		const pendingTurn = MPState.pendingLocalAction ? MPState.pendingLocalAction.turn : null;
		// @ts-ignore
		MPResetState();
		return { popup, pendingTurn };
	});
	expect(r.popup).toBe(false);       // no popup during handshake
	expect(r.pendingTurn).toBe(1);     // input submitted, not blocked
});

test('"Wait" dismisses the modal but keeps input blocked until reconnect', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		MPState.active = true; MPState.wsState = 'open'; MPState.peerEverConnected = true; MPState.peerConnected = false;
		MPState.disconnectWaiting = false; MPState.currentTurn = 5; MPState.pendingLocalAction = null;
		// @ts-ignore
		KDMPDisconnectWait();
		// @ts-ignore — while waiting, input is swallowed and NOT queued (pending stays null)
		const afterWait = { popup: KDMPDisconnectPopupActive(), intercepted: MPInterceptLocalInput('move', { dir: { x: 1, y: 0 } }), pending: MPState.pendingLocalAction };
		// Simulate the peer reconnecting (MPClient's peer_connected handler).
		// @ts-ignore
		MPState.peerConnected = true; MPState.disconnectWaiting = false; MPState.pendingLocalAction = null;
		// @ts-ignore — input now actually submits: pendingLocalAction is set for this turn
		const intercepted2 = MPInterceptLocalInput('move', { dir: { x: 1, y: 0 } });
		const afterReconnect = { popup: KDMPDisconnectPopupActive(), intercepted: intercepted2, pendingTurn: MPState.pendingLocalAction ? MPState.pendingLocalAction.turn : null };
		// @ts-ignore
		MPResetState();
		return { afterWait, afterReconnect };
	});
	expect(r.afterWait.popup).toBe(false);       // modal dismissed
	expect(r.afterWait.intercepted).toBe(true);  // input intercepted...
	expect(r.afterWait.pending).toBeNull();      // ...but NOT submitted (blocked)
	expect(r.afterReconnect.popup).toBe(false);
	expect(r.afterReconnect.pendingTurn).toBe(5); // input now actually submitted
});

test('"Close" auto-saves, ends the session, and returns to single-player', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		MPState.active = true; MPState.wsState = 'open'; MPState.peerConnected = false;
		MPState.playerId = 0;
		// @ts-ignore
		const queueBefore = KDSaveQueue.length;
		// @ts-ignore
		KinkyDungeonState = 'Multiplayer';
		// @ts-ignore
		KDMPCloseSession();
		const out = {
			// @ts-ignore
			queueGrew: KDSaveQueue.length > queueBefore,
			// @ts-ignore
			active: MPState.active,
			// @ts-ignore
			state: KinkyDungeonState,
		};
		// @ts-ignore
		MPResetState();
		return out;
	});
	expect(r.queueGrew).toBe(true);     // auto-saved
	expect(r.active).toBe(false);       // session ended
	expect(r.state).toBe('Game');       // back to single-player
});
