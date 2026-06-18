/* =========================================================================
 * MP lobby + in-session overlay UI.
 *
 * Wires the MP connection API (MPConnect/MPDisconnect/MPState) into the game
 * UI so co-op is playable without the DevTools console.
 *
 * All behaviour lives in plain callable functions (KDLobbyHost / KDLobbyJoin /
 * KDLobbyCancel / KDLobbyEnterGameIfReady / KDMPOverlayState) so tests can
 * drive the flow without simulating canvas clicks; the drawn buttons call those
 * same functions. Async MPConnect results are funneled into KDLobbyStatus, which
 * the per-frame draw reads (no await in the draw loop).
 * ========================================================================= */

let KDLobbyView: 'menu' | 'host' | 'join' = 'menu';

interface KDLobbyStatusT {
	// 'waiting'      — host waiting for a guest to join.
	// 'waiting_host' — guest joined, waiting for the host to start the game.
	phase: 'idle' | 'connecting' | 'waiting' | 'waiting_host' | 'error';
	message?: string;  // localized, for display
	reason?: string;   // raw server reason (bad_code, slot_taken, …)
}
let KDLobbyStatus: KDLobbyStatusT = { phase: 'idle' };

const KDLobbyPort = 8080;

/** Host target when hosting — the page is served by the host's own server. */
function KDLobbyDefaultHost(): string {
	try {
		if (typeof location !== 'undefined' && location.hostname) return location.hostname;
	} catch (_) { /* non-browser */ }
	return '127.0.0.1';
}

function KDLobbyErrText(reason: string): string {
	return TextGet('LobbyErr_' + reason);
}

/** Open a host session; on success the server-minted code lives in MPState.joinCode. */
function KDLobbyHost(): Promise<void> {
	KDLobbyView = 'host';
	KDLobbyStatus = { phase: 'connecting' };
	return MPConnect(KDLobbyDefaultHost(), KDLobbyPort, { role: 'host' })
		.then(() => { KDLobbyStatus = { phase: 'waiting' }; })
		.catch((e) => {
			const r = String((e && (e as Error).message) || e);
			KDLobbyStatus = { phase: 'error', reason: r, message: KDLobbyErrText(r) };
		});
}

/**
 * Join a waiting host with its 4-digit code. On success the guest does NOT jump
 * straight into the game: it enters a "Waiting for host…" state and stays there
 * until the host starts and the first deterministic init / full state arrives
 * (`session_init` → MPStartSharedGame, or `state_sync` → MPApplyStateSync), each
 * of which sets KinkyDungeonState='Game'.
 */
function KDLobbyJoin(host: string, code: string): Promise<void> {
	KDLobbyStatus = { phase: 'connecting' };
	return MPConnect(host || KDLobbyDefaultHost(), KDLobbyPort, { code })
		.then(() => { KDLobbyStatus = { phase: 'waiting_host' }; })
		.catch((e) => {
			const r = String((e && (e as Error).message) || e);
			KDLobbyStatus = { phase: 'error', reason: r, message: KDLobbyErrText(r) };
		});
}

/**
 * Is the guest currently waiting for the host to start the game? True from a
 * successful join until the first state arrives. The draw loop uses it to show the
 * "Waiting for host…" screen and to keep the guest out of the live game UI.
 */
function KDLobbyGuestWaiting(): boolean {
	return KDLobbyStatus.phase === 'waiting_host';
}

function KDLobbyCancel(): void {
	MPDisconnect();
	MPSessionStarted = false;  // allow a fresh session next time
	if (typeof ElementRemove === 'function') { ElementRemove('KDLobbyIP'); ElementRemove('KDLobbyCode'); }
	KDLobbyView = 'menu';
	KDLobbyStatus = { phase: 'idle' };
}

/** Host starts the shared deterministic game once the guest has connected. */
function KDLobbyEnterGameIfReady(): void {
	if (KinkyDungeonState === 'Multiplayer' && MPState.active && MPState.peerConnected) {
		if (MPState.playerId === 0) MPHostStartSession();
		else { KinkyDungeonState = 'Game'; KDLobbyStatus = { phase: 'idle' }; }
	}
}

/* ── Deterministic shared start ────────────────────────────────────────────
 * Both clients must reach a byte-identical KDComputeStateHash() at session
 * start. Init is already deterministic given the seed, but two non-seed
 * sources diverge across clients with different histories: the global entity
 * id counters (KinkyDungeonEnemyID/SpellID, never reset) and KDTodayDate
 * (wall-clock seasonal tags). MPStartSharedGame neutralizes both, then runs
 * the proven init sequence. */

let MPSessionStarted = false;

function MPStartSharedGame(seed: string, todayDateMs: number): void {
	KinkyDungeonEnemyID = 1;   // reset global id counters so ids match across clients
	KinkyDungeonSpellID = 1;
	if (todayDateMs > 0) KDTodayDate = new Date(todayDateMs);  // synced seasonal date
	KDsetSeed(seed);
	KDInitFactions(true);
	KinkyDungeonInitReputation();
	KinkyDungeonInitialize(1);
	KDInitPerks();
	MPSessionStarted = true;
	KinkyDungeonState = 'Game';
	KDLobbyStatus = { phase: 'idle' };
}

/** Host picks the shared seed + date, tells the guest, then starts locally. */
function MPHostStartSession(): void {
	if (MPSessionStarted || MPState.playerId !== 0) return;
	const seed = String(Math.floor(Math.random() * 4294967296));  // seed SOURCE only — not gameplay RNG
	const todayDateMs = Date.now();
	MPSendRaw(MPEncodeSessionInit(seed, todayDateMs));
	// Announce the host's loaded-mod fingerprint so the guest can warn on mismatch.
	if (typeof MPEncodeModList === 'function' && typeof KDGetLocalModList === 'function') {
		MPSendRaw(MPEncodeModList(KDGetLocalModList()));
	}
	MPStartSharedGame(seed, todayDateMs);
	// Host is authoritative — push the full start state so the guest's bytes become
	// identical to the host's (the session_init deterministic init above is the
	// robust baseline if this first state_sync is delayed/lost). Tag the start sync
	// with turn 0 so its integrity hash does not collide with gameplay turn 1's hash
	// pairing on the server.
	MPBroadcastHostState(0);
}

/* ── In-session overlay ──────────────────────────────────────────────────
 * Pure derivation from MPState. */

interface KDMPOverlayT { kind: 'none' | 'waiting' | 'peer_lost' | 'desync'; message: string; }

function KDMPOverlayState(): KDMPOverlayT {
	if (!MPState.active) return { kind: 'none', message: '' };
	if (!MPState.peerConnected) return { kind: 'peer_lost', message: TextGet('LobbyPeerLost') };
	if (MPState.lastDesyncTurn != null) return { kind: 'desync', message: TextGet('LobbyDesync') };
	if (MPState.pendingLocalAction && MPState.pendingLocalAction.turn === MPState.currentTurn)
		return { kind: 'waiting', message: TextGet('LobbyWaiting') };
	return { kind: 'none', message: '' };
}

/* ── Translation keys (lazy, init-order-safe) ───────────────────────────── */

let KDLobbyTextRegistered = false;
function KDLobbyRegisterText(): void {
	if (KDLobbyTextRegistered || typeof addTextKey !== 'function') return;
	KDLobbyTextRegistered = true;
	const keys: [string, string][] = [
		['LobbyTitle', 'Multiplayer'],
		['LobbyHost', 'Host Game'],
		['LobbyJoin', 'Join Game'],
		['LobbyBack', 'Back'],
		['LobbyCancel', 'Cancel'],
		['LobbyIP', 'Host IP'],
		['LobbyCode', 'Join Code'],
		['LobbyConnecting', 'Connecting…'],
		['LobbyWaiting', 'Waiting for opponent…'],
		['LobbyPeerLost', 'Opponent disconnected — waiting for reconnect…'],
		['LobbyDesync', 'Desync detected!'],
		['LobbyError', 'Connection failed'],
		['LobbyErr_bad_code', 'Wrong join code'],
		['LobbyErr_not_waiting', 'No host is waiting'],
		['LobbyErr_slot_taken', 'Game is full'],
		['LobbyErr_already_hosting', 'Someone is already hosting'],
		['LobbyErr_missing_credentials', 'Missing host/code'],
		['LobbyErr_locked_out', 'Too many wrong codes — locked out, try again shortly'],
		['LobbyWaitingHost', 'Waiting for host to start the game…'],
		['LobbyDisconnectTitle', 'Opponent disconnected'],
		['LobbyDisconnectBody', 'The co-op turn is paused. Wait for them to reconnect, or close the session and continue solo.'],
		['LobbyWaitBtn', 'Wait for reconnect'],
		['LobbyCloseBtn', 'Close & save (solo)'],
	];
	for (const [k, v] of keys) addTextKey(k, v);
}

/* ── Drawing ─────────────────────────────────────────────────────────────
 * Mirrors the KDDrawLoadMenu() pattern (KinkyDungeon.ts). */

function KDDrawLobbyPanel(): void {
	KDLobbyRegisterText();
	DrawTextKD(TextGet('LobbyTitle'), 1000, 130, KDBaseWhite, KDTextGray2, 60);

	if (KDLobbyView === 'menu') {
		DrawButtonKDEx('KDLobbyHostBtn', () => { KDLobbyHost(); return true; },
			true, 1000 - 175, 360, 350, 64, TextGet('LobbyHost'), KDBaseWhite, '');
		DrawButtonKDEx('KDLobbyJoinBtn', () => { KDLobbyView = 'join'; KDLobbyStatus = { phase: 'idle' }; return true; },
			true, 1000 - 175, 440, 350, 64, TextGet('LobbyJoin'), KDBaseWhite, '');
		DrawButtonKDEx('KDLobbyBackBtn', () => { KinkyDungeonState = 'Menu'; return true; },
			true, 1000 - 175, 560, 350, 64, TextGet('LobbyBack'), KDBaseWhite, '');
		return;
	}

	if (KDLobbyView === 'host') {
		if (KDLobbyStatus.phase === 'connecting') {
			DrawTextKD(TextGet('LobbyConnecting'), 1000, 340, KDBaseWhite, KDTextGray2);
		} else if (KDLobbyStatus.phase === 'waiting') {
			DrawTextKD(TextGet('LobbyCode'), 1000, 300, KDBaseWhite, KDTextGray2, 36);
			DrawTextKD(MPState.joinCode || '----', 1000, 390, '#fff6bc', KDTextGray2, 96);
			DrawTextKD(TextGet('LobbyWaiting'), 1000, 490, KDBaseWhite, KDTextGray2);
			KDLobbyEnterGameIfReady();
		} else if (KDLobbyStatus.phase === 'error') {
			DrawTextKD(KDLobbyStatus.message || TextGet('LobbyError'), 1000, 340, '#ff8888', KDTextGray2);
		}
		DrawButtonKDEx('KDLobbyCancelBtn', () => { KDLobbyCancel(); return true; },
			true, 1000 - 175, 700, 350, 64, TextGet('LobbyCancel'), KDBaseWhite, '');
		return;
	}

	// join
	// After a successful join, hold the guest on a "Waiting for host…" screen (no
	// IP/code fields) until the host starts and the first state arrives.
	if (KDLobbyStatus.phase === 'waiting_host') {
		if (typeof ElementRemove === 'function') { ElementRemove('KDLobbyIP'); ElementRemove('KDLobbyCode'); }
		DrawTextKD(TextGet('LobbyWaitingHost'), 1000, 400, KDBaseWhite, KDTextGray2, 36, 'center', 500);
		DrawButtonKDEx('KDLobbyWaitCancel', () => { KDLobbyCancel(); return true; },
			true, 1000 - 175, 600, 350, 64, TextGet('LobbyCancel'), KDBaseWhite, '');
		return;
	}
	DrawTextKD(TextGet('LobbyIP'), 1000 - 250, 300, KDBaseWhite, KDTextGray2, 24, 'left');
	KDTextField('KDLobbyIP', 1000 - 250, 320, 500, 56, 'text', KDLobbyDefaultHost(), '40');
	DrawTextKD(TextGet('LobbyCode'), 1000 - 250, 400, KDBaseWhite, KDTextGray2, 24, 'left');
	const cf = KDTextField('KDLobbyCode', 1000 - 250, 420, 500, 56, 'text', '', '4');
	if (cf.Created) {
		cf.Element.oninput = () => {
			const v = (ElementValue('KDLobbyCode') || '').replace(/\D/g, '').slice(0, 4);
			ElementValue('KDLobbyCode', v);
		};
	}
	if (KDLobbyStatus.phase === 'connecting') {
		DrawTextKD(TextGet('LobbyConnecting'), 1000, 520, KDBaseWhite, KDTextGray2);
	} else if (KDLobbyStatus.phase === 'error') {
		DrawTextKD(KDLobbyStatus.message || TextGet('LobbyError'), 1000, 520, '#ff8888', KDTextGray2);
	}
	DrawButtonKDEx('KDLobbyJoinGo', () => {
		KDLobbyJoin(ElementValue('KDLobbyIP') || KDLobbyDefaultHost(), ElementValue('KDLobbyCode') || '');
		return true;
	}, true, 1000 - 175, 600, 350, 64, TextGet('LobbyJoin'), KDBaseWhite, '');
	DrawButtonKDEx('KDLobbyJoinBack', () => {
		KDLobbyView = 'menu'; KDLobbyStatus = { phase: 'idle' };
		if (typeof ElementRemove === 'function') { ElementRemove('KDLobbyIP'); ElementRemove('KDLobbyCode'); }
		return true;
	}, true, 1000 - 175, 700, 350, 64, TextGet('LobbyBack'), KDBaseWhite, '');
}

function KDDrawMPOverlay(): void {
	KDLobbyRegisterText();
	// The blocking disconnect modal takes precedence over the passive banner.
	if (typeof KDMPDisconnectPopupActive === 'function' && KDMPDisconnectPopupActive()) {
		KDDrawDisconnectPopup();
		return;
	}
	// Non-blocking mod-mismatch banner (set by KDReceiveHostModList on the guest).
	if (typeof MPState !== 'undefined' && MPState.modWarning) {
		DrawTextKD('⚠ Mods differ — ' + MPState.modWarning, 1000, 100, '#ffcc66', KDTextGray2, 20, 'center', 280);
	}
	const ov = KDMPOverlayState();
	if (ov.kind === 'none') return;
	const color = ov.kind === 'desync' ? '#ff6666' : (ov.kind === 'peer_lost' ? '#ffcc66' : KDBaseWhite);
	DrawTextKD(ov.message, 1000, 60, color, KDTextGray2, 30, 'center', 300);
}

/** Centered blocking modal with Wait / Close-&-save choices. */
function KDDrawDisconnectPopup(): void {
	DrawTextKD(TextGet('LobbyDisconnectTitle'), 1000, 430, '#ffcc66', KDTextGray2, 40, 'center');
	DrawTextKD(TextGet('LobbyDisconnectBody'), 1000, 490, KDBaseWhite, KDTextGray2, 22, 'center', 560);
	DrawButtonKDEx('KDMPWaitBtn', () => { KDMPDisconnectWait(); return true; },
		true, 1000 - 270, 600, 250, 64, TextGet('LobbyWaitBtn'), KDBaseWhite, '');
	DrawButtonKDEx('KDMPCloseBtn', () => { KDMPCloseSession(); return true; },
		true, 1000 + 20, 600, 250, 64, TextGet('LobbyCloseBtn'), KDBaseWhite, '');
}
