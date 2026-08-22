/**
 * tools/mp-server/client/coop-lobby.js  (KDM-233)
 *
 * THE MULTIPLAYER ENTRY — a button on KD's own main menu, and the host/join screens behind it.
 *
 * A classic (non-module) script sharing the bundle's global scope. It draws with KD's own widgets
 * and decides nothing about the session: hosting and joining are asked for through
 * `window.__coopConnect`, and the server is the authority on who is in (see `join-gate.js`).
 *
 * ── WHY A WRAPPER, AND WHY IT WORKS ───────────────────────────────────────────────────────────────
 * The prior art (`origin/feature/multiplayer`) put this entry in the game tree, editing the menu draw
 * at `KinkyDungeon.ts:1980` and adding a state case at `:3244`. The plugin rule forbids that, and it
 * turns out not to be necessary: KD's buttons are DATA, not code paths.
 *
 *   `KDButtonsCache` is wiped at the top of each frame   `KinkyDungeon.ts:1670-1671`
 *   `DrawButtonKDEx` paints AND registers {bounds, func} `KinkyDungeon.ts:3720`
 *   clicks are dispatched by iterating that cache        `KinkyDungeon.ts:4297, :4324`
 *
 * So a button drawn AFTER the stock frame is fully live. `_prev` must therefore be called FIRST —
 * not merely by convention (WRAP_CONVENTION.md) but because calling it second would wipe the cache
 * we just wrote into, and the entry would paint but never respond.
 *
 * ── THE NEW SCREEN ────────────────────────────────────────────────────────────────────────────────
 * `KinkyDungeonState = 'Multiplayer'` is a value the stock else-if chains do not match, so stock KD
 * paints nothing for it and we own the screen. `tests/e2e/mp-lobby-menu.spec.ts` asserts the button
 * set in that state is EXACTLY ours, which is what would catch a fallthrough painting the game
 * underneath the panel.
 *
 * ⚠️ MP-SPECIFIC (KDM-226's one-player test): a solo game has no lobby, no host and nobody to join.
 */
(function () {
	'use strict';

	if (typeof KinkyDungeonRun !== 'function') return;          // not in a KD page
	if (KinkyDungeonRun._kdmp_lobby_wrapped) return;            // WRAP_CONVENTION sentinel

	var W = 1000, MID = W - 350 / 2;

	var lobby = {
		view: 'menu',            // 'menu' | 'host' | 'join'
		status: '',              // a line of prose for the player — never a code
		error: '',
		_drawCount: 0,           // observed by the double-wrap test
		pending: null,           // { clientId, name } — someone asking to join OUR game
		/** Whatever is currently typed as the host's address. */
		address: function () {
			var el = document.getElementById('KDMPAddress');
			return el ? String(el.value || '') : '';
		},
		/** The name the host will see in their accept/decline dialogue — all approval-only gives them. */
		playerName: function () {
			var el = document.getElementById('KDMPName');
			return el ? String(el.value || '') : '';
		},
		open: function () { KinkyDungeonState = 'Multiplayer'; lobby.view = 'menu'; lobby.error = ''; lobby.status = ''; },
		close: function () { KinkyDungeonState = 'Menu'; lobby.view = 'menu'; },
	};
	window.KDMPLobby = lobby;

	/**
	 * Ask the transport to connect. Supplied by the bootstrap (stage 4); absent in a bundle-only test
	 * page, which is why this degrades to a status line instead of throwing.
	 */
	function connect(opts) {
		if (typeof window.__coopConnect === 'function') {
			try { return window.__coopConnect(opts); } catch (e) { lobby.error = String(e && e.message || e); }
		} else {
			lobby.status = 'No transport available.';
		}
		return null;
	}

	function text(key, fallback) {
		try { if (typeof TextGet === 'function') { var t = TextGet(key); if (t && t !== key) return t; } } catch (e) { /* noop */ }
		return fallback;
	}

	// ---- the entry on KD's own menu --------------------------------------------------------

	function drawMenuEntry() {
		DrawButtonKDEx('MultiplayerButton', function () { lobby.open(); return true; },
			true, MID, 680, 350, 64, text('KDMPLobbyTitle', 'Multiplayer'), '#ffffff', '');
	}

	// ---- the lobby screen ------------------------------------------------------------------

	function drawLobby() {
		lobby._drawCount++;
		DrawTextKD(text('KDMPLobbyTitle', 'Multiplayer'), W, 120, '#ffffff', '#000000', 48);
		if (lobby.view === 'menu') return drawRoot();
		if (lobby.view === 'host') return drawHost();
		if (lobby.view === 'join') return drawJoin();
	}

	function drawRoot() {
		DrawButtonKDEx('KDMPHost', function () {
			lobby.view = 'host';
			lobby.error = '';
			connect({ role: 'host' });
			return true;
		}, true, MID, 300, 350, 64, text('KDMPHostGame', 'Host Game'), '#ffffff', '');

		DrawButtonKDEx('KDMPJoin', function () {
			lobby.view = 'join';
			lobby.error = '';
			return true;
		}, true, MID, 380, 350, 64, text('KDMPJoinGame', 'Join Game'), '#ffffff', '');

		DrawButtonKDEx('KDMPBack', function () { lobby.close(); return true; },
			true, MID, 480, 350, 64, text('KDMPBack', 'Back'), '#ffffff', '');
	}

	function drawHost() {
		// The address a friend types. `location.host` is where THIS page came from, which for a host
		// serving their own game is exactly the thing to share.
		DrawTextKD(text('KDMPShareAddress', 'Tell your friend to join:'), W, 260, '#ffffff', '#000000', 28);
		DrawTextKD(String(location.host || ''), W, 320, '#fff6bc', '#000000', 40);

		// THE GATE (E1-E3). With approval-only there is no code and no password — this prompt is the
		// entire admission decision, and the name is all the host has to judge by.
		if (lobby.pending) {
			DrawTextKD((lobby.pending.name || 'Someone') + text('KDMPWantsToJoin', ' wants to join your game'),
				W, 410, '#ffffff', '#000000', 30);
			DrawButtonKDEx('KDMPAccept', function () { answer(true); return true; },
				true, MID - 190, 470, 350, 64, text('KDMPAcceptBtn', 'Accept'), '#ffffff', '');
			DrawButtonKDEx('KDMPDecline', function () { answer(false); return true; },
				true, MID + 190, 470, 350, 64, text('KDMPDeclineBtn', 'Decline'), '#ffffff', '');
			return;
		}

		DrawTextKD(lobby.status || text('KDMPWaitingGuest', 'Waiting for someone to join…'),
			W, 400, '#ffffff', '#000000', 24);
		if (lobby.error) DrawTextKD(lobby.error, W, 440, '#ff8080', '#000000', 24);
		DrawButtonKDEx('KDMPBack', function () { lobby.view = 'menu'; return true; },
			true, MID, 480, 350, 64, text('KDMPCancel', 'Cancel'), '#ffffff', '');
	}

	function answer(accept) {
		lobby.pending = null;
		if (typeof window.__coopAnswerJoin === 'function') window.__coopAnswerJoin(accept);
	}

	function drawJoin() {
		DrawTextKD(text('KDMPHostAddress', 'Host address'), W, 250, '#ffffff', '#000000', 28);
		KDTextField('KDMPAddress', MID, 280, 350, 56, 'text', String(location.host || 'localhost:8090'), '64');
		DrawTextKD(text('KDMPYourName', 'Your name'), W, 370, '#ffffff', '#000000', 28);
		KDTextField('KDMPName', MID, 400, 350, 56, 'text', '', '24');

		if (lobby.error) DrawTextKD(lobby.error, W, 480, '#ff8080', '#000000', 24);
		else if (lobby.status) DrawTextKD(lobby.status, W, 480, '#ffffff', '#000000', 24);

		DrawButtonKDEx('KDMPConnect', function () {
			lobby.error = '';
			lobby.status = text('KDMPConnecting', 'Connecting…');
			connect({ role: 'guest', address: lobby.address(), name: lobby.playerName() });
			return true;
		}, true, MID, 540, 350, 64, text('KDMPConnectBtn', 'Join'), '#ffffff', '');

		DrawButtonKDEx('KDMPBack', function () { lobby.view = 'menu'; return true; },
			true, MID, 620, 350, 64, text('KDMPBack', 'Back'), '#ffffff', '');
	}

	// ---- the wrap ---------------------------------------------------------------------------

	var _prev = KinkyDungeonRun;
	KinkyDungeonRun = function () {
		// FIRST — see the header: `_prev` clears KDButtonsCache, so anything we register before it
		// would be erased and our button would paint but never click.
		var r = _prev.apply(this, arguments);
		try {
			if (KinkyDungeonState === 'Menu') drawMenuEntry();
			else if (KinkyDungeonState === 'Multiplayer') drawLobby();
		} catch (e) {
			if (window.__KDMP_DEBUG) { try { console.error('[coop lobby]', e); } catch (_) { /* noop */ } }
		}
		return r;
	};
	KinkyDungeonRun._kdmp_lobby_wrapped = true;
	KinkyDungeonRun._kdmp_lobby_original = _prev;
})();
