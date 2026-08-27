/**
 * tools/mp-server/client/coop-chat.js  (KDM-246, KDM-247)
 *
 * THE CO-OP TALK SURFACE: every way a player sends a chat message. Two today —
 *
 *   · TYPE IT (KDM-246)  — a text field on `Y`, Enter to send.
 *   · PICK IT (KDM-247)  — a quick-emoji picker on `U`, one digit to send, with a recents list.
 *
 * Both build `{mp:'chat.say', text}` and hand it to the same `send()`. There is ONE message
 * pipeline, one server action and one renderer: the server writes the line into every player's log
 * and the game's own log draw paints it. This file renders no messages itself.
 *
 * WHY THE PICKER IS IN HERE AND NOT IN A `coop-emoji.js`. It is not a second concern; it is a second
 * INPUT METHOD for the same message. A separate file would need its own copy of `send()`, its own
 * `addOnce` reconnect guard, its own sentinel-gated `KinkyDungeonDrawGame` wrap and its own
 * `demo-server.js` entry — four duplications to serve one 60-line feature, which is the failure
 * KDM-229 was raised for. Compare `coop-menu.js`: one wrap of `KDGetContextActions.Game`, N entries.
 *
 * ⚠️ RENAME TRIGGER (KDM-247 A1, on KDM-276's precedent). The name is honest only while everything
 * here is a way to SEND A CHAT MESSAGE. The day something lands that is not — a co-op emote that
 * animates, a voice indicator, anything with its own action kind — rename the file then, rather than
 * letting it become the grab-bag `coop-peace.js` turned into before KDM-276 renamed it.
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
 *  - `KDButtonsCache` + `hotkeyPress` is how a drawn button earns a keyboard shortcut — FOR KD'S OWN
 *    BUTTONS. It does not work for ours, and this bullet used to claim it did. Our draw lands later
 *    in the frame than the key pump that reads the cache, so our buttons are never in it at match
 *    time; the keys come from `KDKeyCheckers` instead. Measured, and explained in full at `handleKey`
 *    below — read that before "simplifying" a hotkey back onto a button.
 *  - `KDKeyCheckers` is KD's own registry of key checkers, run by `KDCheckCustomKeypress` after the
 *    button loop. It is the keyboard route for both `Y` and `U`.
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

	/*
	 * ── KDM-247: THE QUICK-EMOJI PICKER ───────────────────────────────────────────────────────────
	 *
	 * A second way to send the SAME message. Both halves build `{mp:'chat.say', text}` and hand it to
	 * the same `send()` below — there is one message pipeline, one renderer and one server action.
	 *
	 * WHY IT NEEDS NO KEY HANDLING AT ALL, which is the whole reason it is 60 lines. KD resolves
	 * drawn-button hotkeys BEFORE it reaches spell casting:
	 *
	 *     KinkyDungeonGameKeyDown()                             KinkyDungeonGame.ts:2275
	 *       :2287  if (KDCheckCustomKeypress()) return true;    <- iterates KDButtonsCache
	 *       :2315  else if (KinkyDungeonKeySpell.includes(key)) <- spells, strictly later
	 *
	 * and `KDButtonsCache` is wiped and refilled every frame (`KinkyDungeon.ts:1668-1669`). So while
	 * the picker is drawn its entries own the digits, and the moment it stops being drawn the digits
	 * cast spells again — with no suppression logic, no focus, no `KDFocusableTextFields` entry and
	 * no teardown of ours to get wrong. Same "not drawing it is how it closes" property the chat
	 * field gets from `KDCullTempElements`, applied to keys instead of DOM.
	 *
	 * ⚠️ EVERY ENTRY CALLBACK MUST `return true`. `KDClickButton` returns whatever `func` returns
	 * (`KinkyDungeon.ts:4364-4374`); on a falsy return `KDCheckCustomKeypress` keeps looping, returns
	 * false, and control falls through to the spell branch — while the reaction has ALREADY been sent
	 * from inside the callback. One keypress, reaction sent AND spell cast. Invisible to any test
	 * that only checks the partner received it, so `mp-chat-client.spec.ts` asserts the return value
	 * of every entry.
	 *
	 * ⚠️ AND `enabled` (3rd positional arg) must be true, or `KDClickButton` refuses the button
	 * outright and the hotkey is inert.
	 */

	/**
	 * R3 — the picker must be useful on the very first run, before any usage history exists.
	 *
	 * Co-op shaped: the things you need to say when typing is too slow because you are bound,
	 * surrounded and about to lose a turn. Declared ONCE — the accessor below falls back to it, so
	 * the picker itself never learns that seeding exists.
	 */
	var EMOJI_SEED = ['🆘', '👍', '😱', '🏃',
		'⏳', '❗', '❤️', '😂'];
	var EMOJI_SLOTS = EMOJI_SEED.length;   // one digit hotkey each: '1'…'8'
	// `U` is the LAST letter KD leaves unbound: KinkyDungeonKey* (KinkyDungeon.ts:162-176) take every
	// other one and chat took `Y`. `mp-chat-client.spec.ts` re-derives that set from the game source,
	// so upstream binding it becomes a red rather than one key quietly doing two things.
	var EMOJI_HOTKEY = 'U';

	var pickerOpen = false;

	var open = false;
	var lastError = null;
	var warned = false;
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

	/** The `{read, write}` seam `coop-bootstrap.js` owns, or null if that file did not load. */
	function emojiStore() {
		try {
			var s = window && window.__coopEmojiStore;
			return (s && typeof s.read === 'function' && typeof s.write === 'function') ? s : null;
		} catch (e) { return null; }
	}

	/**
	 * R2/R3/R4 — the emoji this player uses, most recent first, always exactly `EMOJI_SLOTS` long.
	 *
	 * THE STORED VALUE IS UNTRUSTED. It is a `localStorage` key a player can hand-edit, and whatever
	 * comes back here goes on to be SENT. So anything unexpected — absent, empty, not JSON, not an
	 * array, an array of numbers or objects — degrades to the seed set rather than reaching `send()`.
	 * A short list is topped up from the seed rather than shrinking the picker.
	 */
	function recents() {
		var list = [];
		var store = emojiStore();
		try {
			var parsed = store ? JSON.parse(store.read() || 'null') : null;
			if (parsed instanceof Array) {
				for (var i = 0; i < parsed.length; i++) {
					var e = parsed[i];
					// Strings only, non-empty, deduped, and length-bounded so a hand-edited key cannot
					// stuff a whole message into a picker slot.
					if (typeof e === 'string' && e.length > 0 && e.length <= 16 && list.indexOf(e) < 0) list.push(e);
				}
			}
		} catch (e) { list = []; }        // unparseable is simply "nothing stored"
		for (var j = 0; j < EMOJI_SEED.length && list.length < EMOJI_SLOTS; j++) {
			if (list.indexOf(EMOJI_SEED[j]) < 0) list.push(EMOJI_SEED[j]);
		}
		return list.slice(0, EMOJI_SLOTS);
	}

	/**
	 * ⚠️ THE KEYBOARD ROUTE IS `KDKeyCheckers`, NOT THE DRAWN BUTTONS' `hotkeyPress`. MEASURED.
	 *
	 * The obvious route — and the one KDM-247 was designed around — was to let each drawn button
	 * carry its own hotkey, exactly as `coop-chat`'s opener already declared. `KDCheckCustomKeypress`
	 * does iterate `KDButtonsCache` looking for `hotkeyPress`, so on paper that works.
	 *
	 * IT NEVER FIRES FOR US, because our buttons are not in the cache at the moment it looks. An e2e
	 * probe inside `KDCheckCustomKeypress` itself reported, on a real co-op page with the picker open
	 * and all ten of our buttons present in `KDButtonsCache` between frames:
	 *
	 *     { seenKeys: ["1"], customKeypress: 1, oursAtMatch: [], hotkeysAtMatch: [ …KD's own… ] }
	 *
	 * KD saw the key, ran the matcher, and the matcher saw KD's buttons and none of ours. The cache
	 * is wiped and refilled every frame (`KinkyDungeon.ts:1668-1669`), and our draw — which hangs off
	 * `KinkyDungeonDrawGame` — lands LATER in the frame than the key pump that consumes it. So a
	 * button of ours is always exactly one phase too late to be hotkeyable.
	 *
	 * ⚠️ THIS ALSO MEANS CHAT'S `Y` HOTKEY HAS NEVER WORKED (KDM-246). `kdcoopchat` was equally
	 * absent from `oursAtMatch`. It went unnoticed because the KDM-246 e2e opens the field through
	 * `KDCoopChat.open()` rather than by pressing the key, so no test ever exercised the hotkey. Both
	 * keys are routed through this one checker now, and the e2e presses them for real.
	 *
	 * `KDKeyCheckers` (`KinkyDungeonGame.ts:4183`) is KD's own registry for exactly this, and it is
	 * the right seam for three reasons beyond "it works":
	 *   · `KDCheckCustomKeypress` runs it AFTER the button loop, so we can never steal a key from one
	 *     of the game's own drawn buttons;
	 *   · it is a plain object, so registering is an idempotent property assignment — no `addOnce`
	 *     needed, and a reconnect re-eval cannot install a second copy;
	 *   · returning falsy falls through to KD's normal handling, which is precisely the behaviour the
	 *     digits need when the picker is closed.
	 *
	 * The buttons keep their `hotkey`/`hotkeyPress` options: they still label the key for the player,
	 * and they remain the MOUSE route. They are simply not the keyboard route.
	 */
	function handleKey(key) {
		if (!key) return false;
		// Only in play, matching KD's own checkers ("Toggles", "Zoom", …). Without this the picker
		// would answer digits on the main menu and in modal screens.
		if (typeof KinkyDungeonState !== 'undefined' && KinkyDungeonState !== 'Game') return false;
		if (typeof KinkyDungeonDrawState !== 'undefined' && KinkyDungeonDrawState !== 'Game') return false;

		if (pickerOpen) {
			if (key === 'Escape') { pickerOpen = false; return true; }
			var list = recents();
			for (var i = 0; i < list.length; i++) {
				if (key !== String(i + 1)) continue;
				send({ mp: 'chat.say', text: list[i] });
				remember(list[i]);
				pickerOpen = false;
				return true;           // consumed — KD must NOT also cast spell i+1
			}
			// Any other key with the picker open: fall through. The picker stays open, and the key
			// does whatever it normally does.
		}
		if (key === EMOJI_HOTKEY) { pickerOpen = !pickerOpen; return true; }
		if (key === HOTKEY) { open = true; return true; }
		return false;                // not ours — spells, movement and toggles are untouched
	}

	/** R2 — move `emoji` to the front and persist. No server ever learns this list exists. */
	function remember(emoji) {
		var list = [emoji];
		var prev = recents();
		for (var i = 0; i < prev.length && list.length < EMOJI_SLOTS; i++) {
			if (prev[i] !== emoji) list.push(prev[i]);
		}
		var store = emojiStore();
		if (store) store.write(JSON.stringify(list));
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
		 * KDM-285 — CHAT DOES NOT DRAW THE GAME'S LOG. It used to, and that was a symptom fix.
		 *
		 * The reasoning it rested on ("the block containing `KinkyDungeonDrawMessages` is gated on
		 * `KinkyDungeonDrawState == 'Game'` and `KinkyDungeonIsPlayer()`, and a render client
		 * satisfies neither") was disproved by measurement: a probe on both co-op pages reported
		 * `{drawState: "Game", isPlayer: true, drawInterface: 8, afterDrawFrame: 8}` — the block runs
		 * every frame, and `KinkyDungeonIsPlayer()` is `return true` unconditionally.
		 *
		 * What actually suppressed the log was OUR OWN `ensureQuickBind()` leaving
		 * `KinkyDungeonTargetingSpell` armed forever; `coop-bootstrap.js` now disarms it, and KD
		 * paints its own log again — with its own layout, filters and toggle, which is where that
		 * responsibility belongs. Chat owns chat.
		 */

		/*
		 * KDM-247 — the picker's opener, beside chat's. Same 52px row: chat is at Left 1010, so this
		 * sits at 1066. `U` is the LAST letter KD leaves unbound (KinkyDungeonKey* at
		 * KinkyDungeon.ts:162-176 take every other one, and chat took Y); `mp-chat-client.spec.ts`
		 * re-derives that set from the game source and reds if upstream ever binds it.
		 *
		 * It TOGGLES, so the same key opens and closes. Note the `return true` — see the ⚠️ above.
		 */
		if (typeof DrawButtonKDEx === 'function') {
			DrawButtonKDEx('kdcoopemoji', function () { pickerOpen = !pickerOpen; return true; }, true,
				/* Left */ 1066, /* Top */ 8, /* W */ 52, /* H */ 52, /* Label */ 'U',
				/* Color */ '#ffffff', /* Image */ undefined, /* HoveringText */ 'Quick emoji (U)',
				/* Disabled */ false, /* NoBorder */ false, /* FillColor */ undefined,
				/* FontSize */ undefined, /* ShiftText */ undefined,
				/* options */ { hotkey: 'U', hotkeyPress: 'U' });

			if (pickerOpen) {
				// A row ABOVE the chat field (250,950,600,48), so both can be open without overlapping.
				var list = recents();
				for (var i = 0; i < list.length; i++) {
					// `emoji` and `slot` captured per iteration — a shared loop variable would make
					// every entry send the last emoji, which is exactly the kind of bug the unit spec's
					// "each entry sends ITS OWN label" assertion exists to catch.
					(function (emoji) {
						DrawButtonKDEx('kdcoopemoji' + i, function () {
							send({ mp: 'chat.say', text: emoji });
							remember(emoji);
							pickerOpen = false;
							return true;                    // ⚠️ or the digit also casts a spell
						}, true,
						/* Left */ 250 + i * 56, /* Top */ 890, /* W */ 52, /* H */ 52,
						/* Label */ emoji, /* Color */ '#ffffff', /* Image */ undefined,
						/* HoveringText */ emoji + ' (' + (i + 1) + ')',
						/* Disabled */ false, /* NoBorder */ false, /* FillColor */ undefined,
						/* FontSize */ undefined, /* ShiftText */ undefined,
						/* options */ { hotkey: String(i + 1), hotkeyPress: String(i + 1) });
					})(list[i]);
				}
				// Escape closes without sending, and gives a mouse user a way out. Escape is bound by
				// no KinkyDungeonKey* array, and this button only exists while the picker is drawn.
				DrawButtonKDEx('kdcoopemojiclose', function () { pickerOpen = false; return true; }, true,
					/* Left */ 250 + EMOJI_SLOTS * 56, /* Top */ 890, /* W */ 52, /* H */ 52,
					/* Label */ '✕', /* Color */ '#ffffff', /* Image */ undefined,
					/* HoveringText */ 'Close (Escape)',
					/* Disabled */ false, /* NoBorder */ false, /* FillColor */ undefined,
					/* FontSize */ undefined, /* ShiftText */ undefined,
					/* options */ { hotkey: 'Escape', hotkeyPress: 'Escape' });
			}
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

	/*
	 * KDM-285 — the `logDraws` / `ourLogDraws` counter that used to sit here is GONE with the call it
	 * policed. It existed to keep "chat is the only caller of the log draw" a measurement rather than
	 * a belief; chat is now no caller at all, so the honest place to count KD's own log draws is the
	 * spec that asserts they happen (`mp-coop-log-visible.spec.ts`), not this module.
	 */

	// The field id must be known to KD BEFORE anything can be typed into it, or the first keystroke
	// walks the player instead.
	/*
	 * The keyboard route (see the long note on `handleKey`). A property assignment, so a reconnect
	 * re-eval replaces the entry rather than adding a second one — no `addOnce` required.
	 *
	 * Wrapped in its own try/catch because this function runs on EVERY keypress in the game: a throw
	 * here would take the player's movement down with it, and a silent swallow would look exactly
	 * like a working feature. Recorded in `lastError` and warned once, as the draw wrap does.
	 */
	if (typeof KDKeyCheckers !== 'undefined' && KDKeyCheckers) {
		KDKeyCheckers.KDCoopTalk = function () {
			try {
				return handleKey(typeof KinkyDungeonKeybindingCurrentKey !== 'undefined'
					? KinkyDungeonKeybindingCurrentKey : '');
			} catch (e) {
				lastError = String((e && e.message) || e);
				if (!warned) {
					warned = true;
					if (typeof console !== 'undefined' && console.warn) {
						console.warn('[coop-chat] key handling failed, hotkeys are disabled this session:', lastError);
					}
				}
				return false;      // never consume a key we failed to handle
			}
		};
	}

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
			// KDM-247 — the picker half. `recents()` is exposed so the e2e can name the emoji it is
			// about to press, instead of hardcoding one and asserting against its own guess.
			openPicker: function () { pickerOpen = true; },
			closePicker: function () { pickerOpen = false; },
			isPickerOpen: function () { return pickerOpen; },
			recents: recents,
			/** The keyboard route, exposed so a spec can drive a key without a whole browser. */
			handleKey: handleKey,
			/** Diagnostic: what the draw wrap last failed with, or null. */
			lastError: function () { return lastError; },
			diag: function () { return { drawCalls: drawCalls, fieldCalls: fieldCalls, lastError: lastError }; },
		};
	}
})();
