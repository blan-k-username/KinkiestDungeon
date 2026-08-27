/**
 * tools/mp-server/client/coop-chat.js  (KDM-246)
 *
 * Co-op chat, browser side: a text field, a hotkeyed button, and one `Chat` entry in KD's own
 * message-log filter list. It sends `{mp:'chat.say', text}` through `window.__coop.sendAction` and
 * renders nothing itself — the server writes the line into every player's log and the game's own
 * `KinkyDungeonDrawMessages` draws it.
 *
 * EVERY MECHANISM HERE IS STOCK KD. That is the whole design, and it is what keeps the plugin rule
 * (never edit the game tree) cheap to honour:
 *
 *  - `KDTextField` (KinkyDungeonDraw.ts) creates and positions a real <input> over the canvas.
 *  - NOT DRAWING IT IS HOW IT CLOSES. `KDCullTempElements` (KinkyDungeonDraw.ts) removes any temp
 *    element that was not drawn this frame, so there is no teardown path of ours to get wrong.
 *  - `KDFocusableTextFields` is KD's own "a text field has focus, suppress the keybinds" list.
 *    `KinkyDungeonGameKeyDown` returns early on it (KinkyDungeonGame.ts) BEFORE
 *    `KDCheckCustomKeypress`, so while the field is focused W/A/S/D type letters instead of walking
 *    and the open hotkey types its own letter instead of re-firing. We capture no keys globally.
 *  - `KDButtonsCache` + `hotkeyPress` is how a drawn button earns a keyboard shortcut
 *    (`KDCheckCustomKeypress`), so the open button and the open key are one declaration.
 *  - `KDLogFilters` is the list of log-filter tabs; the draw pass labels each with
 *    `TextGet("KDLogFilter" + filter)` and seeds `KDGameData.LogFilters` from it.
 *
 * THE ONE THING WE OWN is a `keydown` listener on our OWN <input> element, for Enter and Escape.
 * That is a listener on an element this file created — not a global key capture. It is needed
 * because KD's own Enter handling merely BLURS a focusable field (KinkyDungeonGame.ts), which would
 * discard the message.
 *
 * INSTALLED SYNCHRONOUSLY, NO TIMERS — see the long note in `coop-menu.js`: the bundle is a plain
 * synchronous <script>, so its `let`-globals are already initialised when this file is injected
 * before </body>. `tests/unit/mp-chat-client.spec.ts` fails if a timer comes back.
 *
 * RE-EVALUATED ON RECONNECT, so every registration below is idempotent. `KDLogFilters` and
 * `KDFocusableTextFields` are plain arrays: an unguarded push would add a second "Chat" tab and a
 * second field id on every reconnect, a leak that grows without ever failing loudly.
 */
(function () {
	'use strict';

	var FIELD_ID = 'KDCoopChatInput';
	var FILTER = 'Chat';
	// F3: the only letters unbound in KD's default scheme are Y and U — every other letter appears in
	// KinkyDungeonKey / …KeyWait / …KeySkip / …KeyWeapon / …KeyMenu / …KeyToggle / …KeySwitchWeapon.
	// Pinned against the game's own declarations by mp-chat-client.spec.ts, so if upstream ever binds
	// this key the result is a red rather than one key quietly doing two things.
	var HOTKEY = 'Y';
	var MAX_LEN = '200';          // matches the server's CHAT_MAX; a courtesy, never the control

	var open = false;
	var lastError = null;
	var warned = false;
	var logError = null;
	var logDraws = 0;
	var ourLogDraws = 0;
	var drawCalls = 0;
	var fieldCalls = 0;
	var listening = false;

	function send(action) {
		try {
			if (window.__coop && typeof window.__coop.sendAction === 'function') {
				window.__coop.sendAction(action);
			}
		} catch (e) { /* not in a session */ }
	}

	/** Add `v` to array `arr` once. The whole of this file's reconnect safety. */
	function addOnce(arr, v) {
		if (arr && arr.indexOf(v) < 0) arr.push(v);
	}

	function close() {
		open = false;
		listening = false;
		// Deliberately nothing else: the next frame simply does not draw the field, and
		// KDCullTempElements removes it. Blurring is implicit — the element leaves the document.
	}

	/**
	 * Enter sends, Escape cancels. `stopPropagation` keeps the keystroke off KD's document-level
	 * handler, which would otherwise blur the field on Enter and throw the message away.
	 */
	function onKeyDown(e) {
		var key = e && e.key;
		if (key !== 'Enter' && key !== 'Escape') return;
		if (e.preventDefault) e.preventDefault();
		if (e.stopPropagation) e.stopPropagation();
		var el = document.getElementById(FIELD_ID);
		var text = el && el.value ? String(el.value) : '';
		if (key === 'Enter') {
			// An empty Enter sends nothing. The server refuses empties too — that is a backstop for
			// other clients, not the reason this check exists.
			if (text.trim()) send({ mp: 'chat.say', text: text.trim() });
		}
		if (el) el.value = '';
		close();
	}

	/**
	 * Draw the open button, and the field itself while open. Called from inside the
	 * `KinkyDungeonDrawMessages` wrap, i.e. once per frame, which is what keeps the field alive.
	 */
	function draw() {
		if (typeof DrawButtonKDEx === 'function') {
			// POSITIONAL, and the position is the whole bug this comment exists for: `options` is the
			// SEVENTEENTH parameter of DrawButtonKDEx (KinkyDungeon.ts:3675-3693) — after Image,
			// HoveringText, Disabled, NoBorder, FillColor, FontSize, ShiftText. One `undefined` short
			// and the options object lands in `ShiftText`, `hotkeyPress` is never seen, and the key
			// silently does nothing. Counted against KD's own `logtog` call (KinkyDungeonDraw.ts).
			DrawButtonKDEx('kdcoopchat', function () { open = true; return true; }, true,
				/* Left */ 1010, /* Top */ 8, /* W */ 52, /* H */ 52, /* Label */ 'Y',
				/* Color */ '#ffffff', /* Image */ undefined, /* HoveringText */ 'Chat (Y)',
				/* Disabled */ false, /* NoBorder */ false, /* FillColor */ undefined,
				/* FontSize */ undefined, /* ShiftText */ undefined,
				/* options */ { hotkey: HOTKEY, hotkeyPress: HOTKEY });
		}
		/*
		 * DRAW KD'S MESSAGE LOG, because in a co-op session nothing else does.
		 *
		 * MEASURED, not assumed. `KinkyDungeonDrawMessages` is called from a block gated on
		 * `KinkyDungeonDrawState == "Game"` and `KinkyDungeonIsPlayer()`
		 * (`KinkyDungeonDraw.ts:1151/1153`); a render client with local simulation disabled satisfies
		 * neither, so the log is never painted. An e2e probe counted `{drawGame: 8, drawMessages: 0}`
		 * over three seconds, and the painted-text recorder on the partner's page came back holding
		 * one glyph — `"+"` — with the chat line present in `KinkyDungeonMessageLog` and invisible on
		 * screen.
		 *
		 * So this calls the GAME'S OWN renderer rather than drawing chat lines ourselves: the log
		 * stays KD's, with KD's layout, filters and toggle. It is a view of state the game already
		 * holds, not a second renderer.
		 *
		 * ⚠️ SCOPE: this incidentally restores EVERY game message for co-op players, not just chat —
		 * they were all invisible before. That is a fix chat needed in order to be visible at all, but
		 * it is bigger than chat; see the task's Tech Debt note.
		 *
		 * Its own try/catch on purpose: if the log draw fails on some state a render client lacks,
		 * chat must still work, and vice versa.
		 */
		if (typeof KinkyDungeonDrawMessages === 'function') {
			ourLogDraws++;
			try { KinkyDungeonDrawMessages(); } catch (e) { logError = String((e && e.message) || e); }
		}

		if (!open || typeof KDTextField !== 'function') return;
		fieldCalls++;
		var tf = KDTextField(FIELD_ID, 250, 950, 600, 48, 'text', '', MAX_LEN);
		var el = (tf && tf.Element) || document.getElementById(FIELD_ID);
		if (!el) return;
		if (!listening) {
			// Re-armed whenever the element is (re-)created: KDCullTempElements may have removed the
			// previous one entirely, taking its listener with it.
			el.addEventListener('keydown', onKeyDown);
			listening = true;
			if (typeof el.focus === 'function') el.focus();
		}
	}

	/**
	 * Cooperative wrap of KD's per-frame game draw, per WRAP_CONVENTION.md: sentinel-gated, `_prev`
	 * captured in closure and called FIRST, original stored.
	 *
	 * ⚠️ `KinkyDungeonDrawGame`, NOT `KinkyDungeonDrawMessages`, and that was MEASURED rather than
	 * chosen. The obvious hook is the log's own draw — chat is a log feature. But in a co-op RENDER
	 * client that function is never called: the block containing it is gated on
	 * `KinkyDungeonDrawState == "Game"` plus `KinkyDungeonIsPlayer()`
	 * (`KinkyDungeonDraw.ts:1151/1153`), and a client with local simulation disabled satisfies
	 * neither. A probe installed from the e2e counted `{drawGame: 8, drawMessages: 0}` over three
	 * seconds — the frame loop is perfectly healthy, that one branch simply does not run.
	 *
	 * The lesson generalises: a wrap being INSTALLED is not evidence that it FIRES. The unit spec
	 * below asserts the sentinel; only the e2e can assert the frame.
	 */
	function install() {
		if (typeof KinkyDungeonDrawGame !== 'function') return false;
		if (KinkyDungeonDrawGame._kdcoop_chat_wrapped) return true;
		var _prev = KinkyDungeonDrawGame;
		var wrapped = function () {
			var out = _prev.apply(this, arguments);
			drawCalls++;
			// Chat must never break the game's log — but a SILENT swallow is how a broken chat looks
			// exactly like a working one. Recorded and warned once, so the failure is diagnosable
			// from the page rather than only from a screenshot of a missing text box.
			try {
				draw();
			} catch (e) {
				lastError = String((e && e.message) || e);
				if (!warned) {
					warned = true;
					if (typeof console !== 'undefined' && console.warn) {
						console.warn('[coop-chat] draw failed, chat is disabled this session:', lastError);
					}
				}
			}
			return out;
		};
		wrapped._kdcoop_chat_wrapped = 1;
		wrapped._kdcoop_chat_original = _prev;
		KinkyDungeonDrawGame = wrapped;
		return true;
	}

	/**
	 * COUNT EVERY invocation of the log draw, so "we are the only caller" stays a MEASUREMENT.
	 *
	 * The whole justification for calling `KinkyDungeonDrawMessages()` above is that in a co-op client
	 * nobody else does. That was established by a probe installed from `page.evaluate` — and a zero
	 * from a wrapper installed in the wrong realm is indistinguishable from a real zero (memory
	 * `evaluate cannot wrap bundle bindings`). If the reading were wrong, or if upstream later removes
	 * the gate, we would be drawing the log TWICE and no assertion would notice.
	 *
	 * This wrap lives in the injected script — the same realm and the same binding our own call uses —
	 * and it counts total invocations. `mp-coop-chat.spec.ts` asserts `logDraws === ourLogDraws`: any
	 * other caller makes the totals diverge, and the honest outcome is a red rather than a doubled log.
	 */
	if (typeof KinkyDungeonDrawMessages === 'function' && !KinkyDungeonDrawMessages._kdcoop_chat_counted) {
		var _prevMsg = KinkyDungeonDrawMessages;
		var countedMsg = function () { logDraws++; return _prevMsg.apply(this, arguments); };
		countedMsg._kdcoop_chat_counted = 1;
		countedMsg._kdcoop_chat_original = _prevMsg;
		KinkyDungeonDrawMessages = countedMsg;
	}

	// The field id must be known to KD BEFORE anything can be typed into it, or the first keystroke
	// walks the player instead.
	if (typeof KDFocusableTextFields !== 'undefined') addOnce(KDFocusableTextFields, FIELD_ID);
	if (typeof KDLogFilters !== 'undefined') addOnce(KDLogFilters, FILTER);
	// Without the key the tab is drawn as "[NotFound] KDLogFilterChat" — also a TESTING_POLICY
	// invariant ("no unresolved text keys").
	if (typeof addTextKey === 'function') addTextKey('KDLogFilter' + FILTER, 'Chat');

	install();

	if (typeof window !== 'undefined') {
		window.KDCoopChat = {
			install: install,
			open: function () { open = true; },
			close: close,
			isOpen: function () { return open; },
			/** Diagnostic: what the draw wrap last failed with, or null. */
			lastError: function () { return lastError; },
			diag: function () { return { drawCalls: drawCalls, fieldCalls: fieldCalls, lastError: lastError, logError: logError, logDraws: logDraws, ourLogDraws: ourLogDraws }; },
		};
	}
})();
