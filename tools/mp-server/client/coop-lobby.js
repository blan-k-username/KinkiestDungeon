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
		/**
		 * KDM-237 — the name this player will be known by, cached from the field every frame it is
		 * drawn.
		 *
		 * ⚠️ CACHED, not read on demand. `KDCullTempElements` destroys any field not drawn this
		 * frame, so by the time a button handler runs on a different view the element may be gone —
		 * and the host's is exactly that case: `KDMPHost` connects from the ROOT view, and a DOM read
		 * at that moment used to find nothing because the field only ever existed on the Join view.
		 * The cache is what lets one field serve both flows.
		 */
		name: '',
		playerName: function () { return lobby.name; },
		open: function () { KinkyDungeonState = 'Multiplayer'; lobby.view = 'menu'; lobby.error = ''; lobby.status = ''; },
		close: function () { lobby.leave(); KinkyDungeonState = 'Menu'; },
		/**
		 * KDM-236 T — the ONE way back to the lobby root.
		 *
		 * The Host view's Cancel, the Join view's Back and the root's own Back all come here. Three
		 * copies of "drop the socket, clear the screen" is exactly the duplication to avoid, and the
		 * root Back genuinely needs it too: it is reachable with a host socket open, by way of
		 * Host → Cancel → Back.
		 *
		 * `__coopDisconnect` is the bootstrap's — the lobby asks, it does not own the socket.
		 */
		leave: function () {
			if (typeof window.__coopDisconnect === 'function') {
				try { window.__coopDisconnect(); } catch (e) { /* nothing to drop */ }
			}
			lobby.view = 'menu';
			lobby.pending = null;
			lobby.status = '';
			lobby.error = '';
		},
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

	/**
	 * KDM-237 N1 — "Your name", drawn by the root view AND the join view from this one function.
	 *
	 * Two call sites, one field: the host is asked on the root (they connect straight from there, so
	 * the field has to exist before Host is pressed), and the guest keeps theirs beside the address
	 * where it already was. Writing it twice is how the two would drift apart.
	 *
	 * Seeded from `lobby.name` on creation, and caching back into it every frame, for the same reason
	 * `addressDefault()` exists: `KDTextField` honours `Value` only when it CREATES the element, and
	 * `KDCullTempElements` destroys any field not drawn this frame — so moving between views destroys
	 * and re-creates this input, and the cache is what carries what the player typed across.
	 */
	function drawNameField(y) {
		DrawTextKD(text('KDMPYourName', 'Your name'), W, y, '#ffffff', '#000000', 28);
		KDTextField('KDMPName', MID, y + 30, 350, 56, 'text', lobby.name, '24');
		var el = document.getElementById('KDMPName');
		if (el) lobby.name = String(el.value || '');
	}

	function drawRoot() {
		// Asked BEFORE either choice, because the host connects straight from this view. y=190 puts
		// the field at ~192-248, clear of the Host button at 268-332.
		drawNameField(190);
		DrawButtonKDEx('KDMPHost', function () {
			lobby.view = 'host';
			lobby.error = '';
			connect({ role: 'host', name: lobby.playerName() });
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
		DrawButtonKDEx('KDMPBack', function () { lobby.leave(); return true; },
			true, MID, 480, 350, 64, text('KDMPCancel', 'Cancel'), '#ffffff', '');
	}

	function answer(accept) {
		lobby.pending = null;
		if (typeof window.__coopAnswerJoin === 'function') window.__coopAnswerJoin(accept);
	}

	/**
	 * KDM-236 A1/A3 — what the address field is pre-filled with.
	 *
	 * The address you last actually reached a host at, else this page's own origin. The memory lives
	 * in the bootstrap (`__coopLastAddress`), which is the only place that knows an address WORKED;
	 * the lobby just asks, and falls back cleanly on a page where the transport was never injected.
	 *
	 * This is read on every frame, but `KDTextField` honours `Value` only when it CREATES the element
	 * (`KinkyDungeonDraw.ts:5679`) and `KDCullTempElements` destroys any field not drawn this frame —
	 * so what the player types survives while the view is open, and leaving and returning genuinely
	 * re-offers the remembered value. No extra plumbing needed for either half.
	 */
	function addressDefault() {
		var remembered = '';
		if (typeof window.__coopLastAddress === 'function') {
			try { remembered = String(window.__coopLastAddress() || ''); } catch (e) { /* no storage */ }
		}
		return remembered || String(location.host || 'localhost:8090');
	}

	function drawJoin() {
		DrawTextKD(text('KDMPHostAddress', 'Host address'), W, 250, '#ffffff', '#000000', 28);
		KDTextField('KDMPAddress', MID, 280, 350, 56, 'text', addressDefault(), '64');
		drawNameField(370);

		if (lobby.error) DrawTextKD(lobby.error, W, 480, '#ff8080', '#000000', 24);
		else if (lobby.status) DrawTextKD(lobby.status, W, 480, '#ffffff', '#000000', 24);

		DrawButtonKDEx('KDMPConnect', function () {
			lobby.error = '';
			lobby.status = text('KDMPConnecting', 'Connecting…');
			connect({ role: 'guest', address: lobby.address(), name: lobby.playerName() });
			return true;
		}, true, MID, 540, 350, 64, text('KDMPConnectBtn', 'Join'), '#ffffff', '');

		DrawButtonKDEx('KDMPBack', function () { lobby.leave(); return true; },
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
