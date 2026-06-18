/* =========================================================================
 * MP runtime state.
 *
 * One mutable global per worker, intended to be serialized into the save
 * (under `KDGameData.multiplayer`) when active. Render code reads it for
 * the "Waiting for opponent" overlay etc.
 * ========================================================================= */

type MPWsState = 'closed' | 'connecting' | 'open' | 'reconnecting';

interface MPRuntimeState {
	active: boolean;
	currentTurn: number;
	playerId: number;
	sessionId: string;
	host: string;
	port: number;
	peerConnected: boolean;
	wsState: MPWsState;
	pendingLocalAction: { turn: number; type: string; data: any } | null;
	reconnectAttempt: number;
	// 4-digit join code, populated on the host only (from `hello.joinCode`).
	// The host UI displays it; guests never receive it.
	joinCode: string | null;
	// Turn of the most recent server `desync` broadcast (null = none seen).
	// Read by KDMPOverlayState() to show the desync banner.
	lastDesyncTurn: number | null;
	// Integrity tag of the most recent full-state broadcast — the host sets it on
	// send, the guest on receive (both hash the same transmitted payload). Confirms
	// transport fidelity; not a lockstep guarantee.
	lastSyncHash: string | null;
	// Latched true the first time a peer connects. The disconnect popup + input-block
	// only engage once a peer was *ever* present and is now gone — so the initial
	// connect handshake (before the guest's peer_connected arrives) never falsely
	// blocks input or pops the modal.
	peerEverConnected: boolean;
	// The local player chose "Wait" on the disconnect popup, so the blocking modal
	// is dismissed (a passive banner remains) while we keep waiting for the peer
	// to rejoin. Cleared automatically on reconnect (peer_connected).
	disconnectWaiting: boolean;
	// Non-blocking mod-list mismatch warning (set on the guest when the host's
	// `mod_list` differs from the local set). null = sets match / unchecked.
	modWarning: string | null;
}

let MPState: MPRuntimeState = MPDefaultState();

function MPDefaultState(): MPRuntimeState {
	return {
		active: false,
		currentTurn: 1,
		playerId: 0,
		sessionId: '',
		host: '',
		port: 8080,
		peerConnected: false,
		wsState: 'closed',
		pendingLocalAction: null,
		reconnectAttempt: 0,
		joinCode: null,
		lastDesyncTurn: null,
		lastSyncHash: null,
		peerEverConnected: false,
		disconnectWaiting: false,
		modWarning: null,
	};
}

function MPResetState(): void {
	MPState = MPDefaultState();
}
