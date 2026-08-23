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
		/**
		 * KDM-257 — `{hostOnly, guestOnly, conflict}` from KDM-249's `diffDeclarations`, as it arrives
		 * on `awaiting_approval` (guest) and `join_pending` (host). Null until one of those lands.
		 *
		 * Read-only here: this task RENDERS the diff and changes nothing about how it is computed or
		 * carried. If anything under `tools/mp-server/*.js` needed editing to make this paint, the
		 * scope had drifted.
		 */
		modDiff: null,
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
		/**
		 * KDM-238 — the perk keys this player committed on KD's own perk screen, and whether a pick
		 * is in progress right now.
		 *
		 * `perkPick` is what makes the `KDPerksStart` / `KDPerksBack` override CONDITIONAL: outside a
		 * co-op pick those two buttons must keep doing KD's own thing (see `drawPerkPickOverrides`).
		 * Both survive moving between views, unlike the DOM-backed name field — there is no element
		 * for `KDCullTempElements` to destroy.
		 */
		perks: [],
		perkPick: false,
		playerPerks: function () { return lobby.perks.slice(); },
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
			lobby.modDiff = null;
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
			connect({ role: 'host', name: lobby.playerName(), perks: lobby.playerPerks() });
			return true;
		}, true, MID, 300, 350, 64, text('KDMPHostGame', 'Host Game'), '#ffffff', '');

		DrawButtonKDEx('KDMPJoin', function () {
			lobby.view = 'join';
			lobby.error = '';
			return true;
		}, true, MID, 380, 350, 64, text('KDMPJoinGame', 'Join Game'), '#ffffff', '');

		// KDM-238 R1 — asked BEFORE either choice, like the name above it: the host connects straight
		// from this view, so anything that has to ride the handshake must be pickable here.
		DrawButtonKDEx('KDMPPerks', function () {
			lobby.error = '';
			lobby.perkPick = true;
			KinkyDungeonState = 'Stats';       // KD's OWN perk screen — see drawPerkPickOverrides
			return true;
		}, true, MID, 460, 350, 64, text('KDMPPerksBtn', 'Perks'), '#ffffff', '');

		DrawButtonKDEx('KDMPBack', function () { lobby.close(); return true; },
			true, MID, 560, 350, 64, text('KDMPBack', 'Back'), '#ffffff', '');
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
			// KDM-257 R2 — what the host is agreeing to SEND. Between the question and the buttons,
			// because it is part of the question. The buttons move down by whatever it painted, so a
			// long list never lands on top of Accept.
			var below = drawModDiff(455, text('KDMPModsToSend', 'They will be sent COUNT of your mods:'));
			var btnY = below ? below + 30 : 470;   // R4: nothing painted => the stock layout, unchanged
			DrawButtonKDEx('KDMPAccept', function () { answer(true); return true; },
				true, MID - 190, btnY, 350, 64, text('KDMPAcceptBtn', 'Accept'), '#ffffff', '');
			DrawButtonKDEx('KDMPDecline', function () { answer(false); return true; },
				true, MID + 190, btnY, 350, 64, text('KDMPDeclineBtn', 'Decline'), '#ffffff', '');
			return;
		}

		DrawTextKD(lobby.status || text('KDMPWaitingGuest', 'Waiting for someone to join…'),
			W, 400, '#ffffff', '#000000', 24);
		if (lobby.error) DrawTextKD(lobby.error, W, 440, '#ff8080', '#000000', 24);
		DrawButtonKDEx('KDMPBack', function () { lobby.leave(); return true; },
			true, MID, 480, 350, 64, text('KDMPCancel', 'Cancel'), '#ffffff', '');
	}

	/**
	 * KDM-238 R1 — the perk pick, on KD's OWN screen.
	 *
	 * `KinkyDungeonState = 'Stats'` is KD's perk screen (`KinkyDungeon.ts:2861`), and everything on
	 * it — the grid, the point budget, Clear All, the three configs, the filter, copy/paste — is
	 * stock. Nothing here re-implements any of it, which is epic AC2 satisfied by not writing code.
	 *
	 * Two of that screen's buttons do the wrong thing for a co-op player, and exactly two are taken
	 * back while `lobby.perkPick` is set:
	 *
	 *   KDPerksStart  stock: KinkyDungeonStartNewGame() — would start a SOLO game
	 *   KDPerksBack   stock: KinkyDungeonState = "Diff"
	 *
	 * ⚠️ THE SAME CACHE MECHANIC AS THE MENU ENTRY, and it works for the same reason: `DrawButtonKDEx`
	 * registers `KDButtonsCache[name] = params` (`:3720`), the cache is wiped per frame (`:1670`), and
	 * clicks are dispatched by iterating it (`:4321`). Registration is keyed by NAME, so replacing the
	 * entry AFTER `_prev` has drawn it replaces its handler. Do it before `_prev` and it is wiped.
	 *
	 * ⚠️ AND IT IS CONDITIONAL. Without `perkPick` the stock buttons are left entirely alone, so a
	 * solo player's perk screen is untouched — asserted from both sides in `mp-lobby-perks.spec.ts`,
	 * because an unconditional override would pass the co-op half and silently break the game's own.
	 */
	function drawPerkPickOverrides() {
		if (!lobby.perkPick) return;
		var b = (typeof KDButtonsCache !== 'undefined') && KDButtonsCache;
		if (!b || !b.KDPerksStart || !b.KDPerksBack) return;   // not the perk screen (yet)
		// The stock geometry and label are kept — it is the button the player is already looking at;
		// only the handler is ours.
		b.KDPerksStart = withHandler(b.KDPerksStart, lobby.commitPerks);
		b.KDPerksBack = withHandler(b.KDPerksBack, lobby.commitPerks);
	}

	/** A copy of a cache entry with its click handler replaced. */
	function withHandler(params, func) {
		var out = {};
		for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) out[k] = params[k];
		out.func = func;
		return out;
	}

	/**
	 * Take what KD says is chosen, and go back to the lobby.
	 *
	 * READ FROM `KinkyDungeonStatsChoice`, never from a field of our own: the grid, Clear All, the
	 * three config buttons and the paste box all write there, so it is the only value that is true
	 * whatever route the player took through the screen.
	 *
	 * Both overridden buttons come here. Start and Back differ in stock KD only in where they go
	 * next, and for a co-op pick there is one answer to that — the lobby.
	 */
	lobby.commitPerks = function () {
		var chosen = [];
		try {
			if (typeof KinkyDungeonStatsChoice !== 'undefined' && KinkyDungeonStatsChoice) {
				KinkyDungeonStatsChoice.forEach(function (on, key) { if (on) chosen.push(String(key)); });
			}
		} catch (e) { chosen = []; }
		lobby.perks = chosen;
		lobby.perkPick = false;
		KinkyDungeonState = 'Multiplayer';
		lobby.view = 'menu';
		return true;
	};

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

		// KDM-257 R1 — what this guest is about to load, named BEFORE it is in. The diff only exists
		// once the host has been asked, so in practice this paints while the "waiting for the host"
		// status is up — which is exactly the window in which the guest can still walk away.
		var below = drawModDiff(510, text('KDMPModsToGet', 'The host is running COUNT mods you don\'t have:'));
		var joinY = below ? below + 30 : 540;   // R4: nothing painted => the stock layout, unchanged

		DrawButtonKDEx('KDMPConnect', function () {
			lobby.error = '';
			lobby.status = text('KDMPConnecting', 'Connecting…');
			connect({ role: 'guest', address: lobby.address(), name: lobby.playerName(), perks: lobby.playerPerks() });
			return true;
		}, true, MID, joinY, 350, 64, text('KDMPConnectBtn', 'Join'), '#ffffff', '');

		DrawButtonKDEx('KDMPBack', function () { lobby.leave(); return true; },
			true, MID, joinY + 80, 350, 64, text('KDMPBack', 'Back'), '#ffffff', '');
	}

	// ---- KDM-257: what the two sides are about to exchange, in words -----------------------

	/** How many mods to name before collapsing the rest into a count. Screen space, not policy. */
	var MODLIST_SHOWN = 4;

	/**
	 * KDM-257 R1/R2/R6 — the host-only mod list, painted from ONE function for BOTH sides.
	 *
	 * The guest and the host are looking at the same list from opposite ends: these are the mods the
	 * guest lacks, which is identical to the mods the host will send. Only the sentence above the
	 * list differs, so only the sentence is a parameter. Two copies of "list the mods" would drift in
	 * wording, and the two screens disagreeing about what is being transferred is exactly the
	 * confusion this task exists to remove.
	 *
	 * ⚠️ R4 — SILENCE IS THE CORRECT OUTPUT for an empty list, and returning early is how that is
	 * guaranteed rather than remembered. A banner on every join trains players to ignore banners.
	 *
	 * `hostOnly` is already in install order and already deduplicated (`mod-sync.js:61-73`,
	 * priority-DESC to match `KDMods.ts:311`), so it is painted in the order it arrives — the player
	 * sees what the game will actually do. `conflict` is a documented STRICT SUBSET of `hostOnly`
	 * (`mod-sync.js:81-86`), so a row in it is LABELLED rather than listed a second time.
	 *
	 * @returns the y below the last line drawn, or 0 if it painted NOTHING — so a caller lays out
	 * under it when there is something, and keeps its own stock layout byte-for-byte when there is not.
	 */
	function drawModDiff(y, lead) {
		var diff = lobby.modDiff;
		var rows = (diff && Array.isArray(diff.hostOnly)) ? diff.hostOnly : [];
		if (!rows.length) return 0;                                   // R4
		var conflicts = {};
		if (diff && Array.isArray(diff.conflict)) {
			for (var c = 0; c < diff.conflict.length; c++) conflicts[diff.conflict[c].hash] = true;
		}
		DrawTextKD(lead.replace('COUNT', String(rows.length)), W, y, '#ffd98a', '#000000', 24);
		var shown = Math.min(rows.length, MODLIST_SHOWN);
		for (var i = 0; i < shown; i++) {
			var r = rows[i];
			// `modname` is what a player recognises; `name` (the file) is the fallback for a mod whose
			// manifest gave none, so a row is never painted as an empty bullet.
			var label = String(r.modname || r.name || '?');
			if (conflicts[r.hash]) label += text('KDMPModConflict', ' (a different version of yours)');
			DrawTextKD('• ' + label, W, y + 28 + i * 26, '#ffffff', '#000000', 22);
		}
		if (rows.length > shown) {
			DrawTextKD(text('KDMPModMore', '…and MORE more').replace('MORE', String(rows.length - shown)),
				W, y + 28 + shown * 26, '#cccccc', '#000000', 22);
			shown += 1;
		}
		return y + 28 + shown * 26;
	}

	/**
	 * KDM-257 R3 — a degraded mod sync, named while the game runs.
	 *
	 * The owner's 2026-08-23 decision is that a degraded sync PROCEEDS rather than refusing the
	 * session; this notice is what keeps that honest, and it is KDM-249's R9 ("a degraded or refused
	 * sync SHALL be visible, not mysterious") finally reaching a screen.
	 *
	 * ⚠️ IT LIVES ON THIS FILE'S WRAP, NOT A NEW ONE. The notice paints during `KinkyDungeonState ===
	 * 'Game'`, which is a fourth branch of the SINGLE `KinkyDungeonRun` wrap at the bottom of this
	 * file — a second wrap of the same global from another client script is the bug [[KDM-229]] was
	 * raised for. One global, one wrap.
	 *
	 * Persistent BY CONSTRUCTION: it re-reads live state every frame, so it lasts exactly as long as
	 * the condition does and needs no dismissal, no timer and no latch. And it is silent for every
	 * other status (`executed` / `nothing-to-do` / `off` / `pending`) — R4 again.
	 *
	 * ⚠️ EXPOSED AS `KDMPLobby.drawModWarning` — a deliberate test seam, and the reason is worth
	 * knowing before anyone "cleans it up". KD's in-game draw THROWS in the headless harness
	 * (`Cannot set properties of null (setting 'fillStyle')`, from a canvas context that does not
	 * exist there) and that kills the PIXI ticker: MEASURED on both the host and the guest page of a
	 * real started co-op session, `KinkyDungeonRun` runs 388 times and then zero, from the frame
	 * `KinkyDungeonState` becomes `'Game'`. So the FRAME PATH into this function cannot be exercised
	 * by any e2e in this repo today, and the spec calls it directly instead. See KDM-257's task notes
	 * and the follow-up filed there.
	 */
	function drawModWarning() {
		if (!window.__coopMods || typeof window.__coopMods.state !== 'function') return;
		var st;
		try { st = window.__coopMods.state(); } catch (e) { return; }
		if (!st || st.status !== 'degraded') return;                  // R4
		var missing = Array.isArray(st.missing) ? st.missing : [];
		var names = [];
		for (var i = 0; i < missing.length && i < MODLIST_SHOWN; i++) {
			var m = missing[i];
			names.push(String((m && (m.modname || m.name)) || m || '?'));
		}
		if (missing.length > names.length) names.push('+' + (missing.length - names.length));
		DrawTextKD(text('KDMPModDegraded', 'Co-op: some of the host\'s mods could not be loaded — ') + names.join(', '),
			W, 60, '#ffb060', '#000000', 22);
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
			// KDM-238 — KD's own perk screen, with two of its buttons pointed back at the lobby. Not
			// an `else if` on 'Stats' alone: the override only applies to a co-op pick, and that
			// condition lives in one place, inside the function.
			else if (KinkyDungeonState === 'Stats') drawPerkPickOverrides();
			// KDM-257 R3 — the degraded-sync notice, on THIS wrap. A second wrap of KinkyDungeonRun
			// from another client script is the duplication [[KDM-229]] was raised for; one global,
			// one wrap, and the branch that needs it lives here with the others.
			else if (KinkyDungeonState === 'Game') drawModWarning();
		} catch (e) {
			if (window.__KDMP_DEBUG) { try { console.error('[coop lobby]', e); } catch (_) { /* noop */ } }
		}
		return r;
	};
	KinkyDungeonRun._kdmp_lobby_wrapped = true;
	KinkyDungeonRun._kdmp_lobby_original = _prev;
	// KDM-257 — the test seam for the notice; see drawModWarning's own note for why it exists.
	lobby.drawModWarning = drawModWarning;
})();
