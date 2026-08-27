/**
 * KDM-246 — `client/coop-chat.js`: the browser half of co-op chat.
 *
 * The real file is loaded, not a copy. It is a classic (non-module) script that reads bundle globals
 * by bare name, which is exactly what a `vm` context models: bare identifiers resolve to context
 * properties, so a hand-built context IS the bundle's global scope as the script sees it. Same
 * harness and same reasoning as `mp-peace-install.spec.ts` (KDM-229).
 *
 * WHAT ONLY A UNIT SPEC CAN SEE HERE:
 *
 *  - "installed by the time the script finishes evaluating, and nothing is left ticking". An e2e
 *    lets a whole browser boot elapse first, so a re-introduced `setInterval` would still pass it.
 *  - IDEMPOTENCE ON RE-EVALUATION. This file is re-evaluated on reconnect. `KDLogFilters` and
 *    `KDFocusableTextFields` are plain arrays, so a naive `push` would add a second "Chat" tab and a
 *    second field id on every reconnect — a leak that grows without ever failing loudly.
 *  - THE HOTKEY IS ACTUALLY FREE. Asserted against the GAME'S OWN keybind declarations, read from
 *    source. This is text-coupled on purpose and reports loudly if the shape drifts: if upstream
 *    binds `Y` one day, the honest outcome is a red here rather than a key that silently does two
 *    things in the running game.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../../tools/mp-server/client/coop-chat.js');
const KD_KEYS_SRC = resolve(__dirname, '../../Game/src/base/KinkyDungeon.ts');

/**
 * Chat's own open button, BY NAME.
 *
 * These cases used to reach for `buttons[buttons.length - 1]` — "the last one drawn" — which was
 * true only while chat was the sole thing this file drew. KDM-247 added the emoji opener after it
 * and every one of them silently started clicking the wrong button. Selecting by name is what they
 * always meant, and it cannot drift again when a third button appears.
 */
function chatOpener(buttons: any[]) {
	const b = buttons.filter((x) => x.name === 'kdcoopchat').pop();
	if (!b) throw new Error(`no "kdcoopchat" button was drawn (drawn: ${buttons.map((x) => x.name).join(', ')})`);
	return b;
}

/** KD's own draw pass — the `_prev` a cooperative wrap must call FIRST. */
function vanillaDrawMessages(this: any, ...args: any[]) {
	(vanillaDrawMessages as any).calls.push(args);
	return 'vanilla';
}
(vanillaDrawMessages as any).calls = [] as any[][];

/**
 * Evaluate the real script against a minimal fake bundle scope.
 * Returns the context plus recorders for everything the script is not allowed to do quietly.
 */
function loadChat(opts: { sendAction?: (a: any) => void; stored?: string | null; noStore?: boolean } = {}) {
	(vanillaDrawMessages as any).calls = [];
	const armed: string[] = [];
	const sent: any[] = [];
	const buttons: any[] = [];
	const fields: any[] = [];
	const textKeys: Record<string, string> = {};
	const listeners: Record<string, (e: any) => void> = {};

	/**
	 * KDM-247 A3' — the recents STORE, faked at the boundary `coop-bootstrap.js` owns.
	 *
	 * The picker never sees `localStorage` or the `kdcoop.` key string; it sees these two functions.
	 * That split is what makes the MRU and seeding logic testable here at all — see the block at the
	 * bottom of this file for why the logic did not go into `coop-bootstrap.js` itself.
	 */
	let cell: string | null = opts.stored === undefined ? null : opts.stored;
	const writes: string[] = [];
	const store = {
		read: () => cell,
		write: (s: string) => { writes.push(s); cell = s; },
	};

	const element: any = {
		id: 'KDCoopChatInput',
		value: '',
		addEventListener: (t: string, fn: any) => { listeners[t] = fn; },
		removeEventListener: (t: string) => { delete listeners[t]; },
		blur: () => {},
		focus: () => {},
	};

	const ctx: any = {
		window: {
			__coop: { sendAction: opts.sendAction || ((a: any) => sent.push(a)) },
			...(opts.noStore ? {} : { __coopEmojiStore: store }),
		},
		document: { getElementById: (id: string) => (id === element.id ? element : null), activeElement: null },
		KinkyDungeonDrawGame: vanillaDrawMessages,
		KDLogFilters: ['Action', 'Combat', 'Self'],
		KDFocusableTextFields: ['savename'],
		KDTextField: (name: string, ...rest: any[]) => { fields.push([name, ...rest]); return { Element: element, Created: fields.length === 1 }; },
		/**
		 * MIRRORS KD'S REAL POSITIONAL SIGNATURE (KinkyDungeon.ts:3675-3693), and that is the point.
		 *
		 * The first version of this fake took `(name, fn, _e, ...rest)` and located the options object
		 * by SEARCHING `rest` for anything with a `hotkeyPress`. It passed against a client that put
		 * options in the 16th slot instead of the 17th — where the real function reads it as
		 * `ShiftText` and never sees the hotkey at all. The e2e caught it; this fake had reported
		 * green. A positional bug needs a positional fake.
		 */
		DrawButtonKDEx: (
			name: string, fn: any, _enabled: any, _left: any, _top: any, _w: any, _h: any,
			_label: any, _color: any, _image: any, _hover: any, _disabled: any, _noBorder: any,
			_fill: any, _fontSize: any, _shiftText: any, options: any,
			// `enabled` and `label` are recorded for KDM-247: KDClickButton refuses a button whose
			// `enabled` is falsy (KinkyDungeon.ts:4365), and the picker's label IS the emoji it sends.
		) => { buttons.push({ name, fn, options, shiftText: _shiftText, enabled: _enabled, label: _label }); return true; },
		addTextKey: (k: string, v: string) => { textKeys[k] = v; },
		TextGet: (k: string) => textKeys[k] || k,
		KinkyDungeonRootDirectory: '',
		// KDM-247 — the KEYBOARD seam. `KDKeyCheckers` is KD's own registry of `() => boolean`
		// checkers, run by KDCheckCustomKeypress AFTER the drawn-button loop
		// (KinkyDungeonGame.ts:2258-2273). It is the route the picker actually uses; the buttons'
		// `hotkeyPress` is the mouse label only. `KDCoopChatToggles` is a stand-in for one of KD's
		// own entries, so a case can prove we ADDED to the registry rather than replacing it.
		KDKeyCheckers: { KDStockChecker: () => false },
		KinkyDungeonKeybindingCurrentKey: '',
		KinkyDungeonState: 'Game',
		KinkyDungeonDrawState: 'Game',
		setInterval: (_fn: any, ms: number) => { armed.push(`setInterval(${ms})`); return 0; },
		setTimeout: (_fn: any, ms: number) => { armed.push(`setTimeout(${ms})`); return 0; },
		clearInterval: () => {}, clearTimeout: () => {},
		console: { warn: () => {}, log: () => {}, error: () => {} },
	};
	createContext(ctx);
	runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'coop-chat.js' });
	return { ctx, armed, sent, buttons, fields, textKeys, listeners, element, store, writes, read: () => cell };
}

describe('KDM-246 — coop-chat.js installs synchronously and cooperatively', () => {
	it('arms no timer at all (KDM-229 rule, still)', () => {
		const { armed } = loadChat();
		expect(armed, `coop-chat.js armed: ${armed.join(', ')}`).toEqual([]);
	});

	it('the draw wrap is installed by the time the script finishes evaluating', () => {
		const { ctx } = loadChat();
		expect(ctx.KinkyDungeonDrawGame._kdcoop_chat_wrapped).toBe(1);
		expect(ctx.KinkyDungeonDrawGame._kdcoop_chat_original,
			'the original must stay reachable, per WRAP_CONVENTION.md').toBe(vanillaDrawMessages);
	});

	it('the wrap calls the previous draw FIRST and returns its value', () => {
		// WRAP_CONVENTION rule 3. A wrap that drew our field and forgot the log would still satisfy
		// the sentinel assertion above, and the player would lose every message in the game.
		const { ctx } = loadChat();
		const out = ctx.KinkyDungeonDrawGame(false, 0);
		expect((vanillaDrawMessages as any).calls.length, 'KD own log still drew').toBe(1);
		expect(out, 'and its return value is not swallowed').toBe('vanilla');
	});
});

describe('KDM-246 — registration is idempotent across a reconnect re-eval', () => {
	it('"Chat" joins KDLogFilters exactly once, however many times the file is evaluated', () => {
		const { ctx } = loadChat();
		expect(ctx.KDLogFilters).toContain('Chat');
		const once = ctx.KDLogFilters.filter((f: string) => f === 'Chat').length;
		expect(once).toBe(1);

		// Re-evaluate in the SAME context — this is what a reconnect does.
		runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'coop-chat.js' });
		expect(ctx.KDLogFilters.filter((f: string) => f === 'Chat').length,
			'a second Chat tab would appear on every reconnect').toBe(1);

		// CONTROL: the filters that were already there are untouched.
		expect(ctx.KDLogFilters).toEqual(expect.arrayContaining(['Action', 'Combat', 'Self']));
	});

	it('the field id joins KDFocusableTextFields exactly once', () => {
		const { ctx } = loadChat();
		const id = ctx.KDLogFilters && 'KDCoopChatInput';
		expect(ctx.KDFocusableTextFields).toContain(id);
		runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'coop-chat.js' });
		expect(ctx.KDFocusableTextFields.filter((f: string) => f === id).length).toBe(1);
		expect(ctx.KDFocusableTextFields, 'CONTROL: KD own entries survive').toContain('savename');
	});

	it('the filter label has a text key, so the tab is not drawn as "[NotFound]"', () => {
		// The draw pass labels the toggle with TextGet("KDLogFilter" + filter)
		// (KinkyDungeonDraw.ts:2766). Without the key the player sees a missing-key marker, which is
		// also a TESTING_POLICY invariant ("no unresolved text keys").
		const { textKeys } = loadChat();
		expect(textKeys.KDLogFilterChat).toBeTruthy();
	});
});

describe('KDM-246 — opening, typing and sending', () => {
	it('a hotkeyed button opens it, and the field is only drawn once open', () => {
		const { ctx, buttons, fields } = loadChat();
		ctx.KinkyDungeonDrawGame(false, 0);
		expect(buttons.length, 'an open button is drawn every frame').toBeGreaterThan(0);
		expect(fields.length, 'CONTROL: closed means the field is not drawn, so KDCullTempElements removes it').toBe(0);

		const opener = chatOpener(buttons);
		opener.fn({});                       // the player clicks it (or presses the hotkey)
		ctx.KinkyDungeonDrawGame(false, 0);
		expect(fields.length, 'now it is drawn, so it exists and stays alive').toBe(1);
		expect(fields[0][0], 'and it is the id registered as focusable').toBe('KDCoopChatInput');
	});

	it('Enter sends a chat.say action and closes; Escape sends nothing', () => {
		const { ctx, buttons, listeners, element, sent, fields } = loadChat();
		ctx.KinkyDungeonDrawGame(false, 0);
		chatOpener(buttons).fn({});
		ctx.KinkyDungeonDrawGame(false, 0);

		element.value = 'behind you';
		listeners.keydown({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
		expect(sent, 'one message, in the shape KDM-247 will reuse').toEqual([{ mp: 'chat.say', text: 'behind you' }]);

		const drawn = fields.length;
		ctx.KinkyDungeonDrawGame(false, 0);
		expect(fields.length, 'sending closes it — the field stops being drawn').toBe(drawn);

		// Escape: reopen, type, cancel.
		chatOpener(buttons).fn({});
		ctx.KinkyDungeonDrawGame(false, 0);
		element.value = 'never mind';
		listeners.keydown({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} });
		expect(sent.length, 'Escape cancels — nothing is sent').toBe(1);
	});

	it('an empty Enter sends nothing — the server refusal is a backstop, not the UI', () => {
		const { ctx, buttons, listeners, element, sent } = loadChat();
		ctx.KinkyDungeonDrawGame(false, 0);
		chatOpener(buttons).fn({});
		ctx.KinkyDungeonDrawGame(false, 0);
		element.value = '   ';
		listeners.keydown({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
		expect(sent).toEqual([]);
	});
});

describe('KDM-246 — the chat hotkey is genuinely unbound in KD (drift guard)', () => {
	/**
	 * TEXT-COUPLED to the game source, which the plugin rule allows only with loud drift reporting —
	 * hence the explicit "found N declarations" assertion. A key that upstream later binds would
	 * otherwise do two things at once in the running game, and nothing would say so.
	 */
	it('does not collide with any KinkyDungeonKey* declaration', () => {
		const src = readFileSync(KD_KEYS_SRC, 'utf8');
		const re = /^let\s+(KinkyDungeonKey\w*)\s*=\s*\[([^\]]*)\]/gm;
		const bound = new Set<string>();
		let n = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src))) {
			n++;
			for (const raw of m[2].split(',')) {
				const t = raw.trim().replace(/^['"]|['"]$/g, '');
				if (t) bound.add(t.toUpperCase());
			}
		}
		// DRIFT REPORT: if this count collapses, the regex stopped matching and the test below is
		// vacuous — it would be asserting against an empty set.
		expect(n, 'KinkyDungeonKey* array declarations found in KinkyDungeon.ts').toBeGreaterThanOrEqual(10);
		expect(bound.has('W') && bound.has('T'), 'sanity: the set really holds KD bindings').toBe(true);

		const { ctx, buttons } = loadChat();
		ctx.KinkyDungeonDrawGame(false, 0);
		const btn = chatOpener(buttons);
		// POSITION, not presence: `options` must arrive in the 17th slot, because that is the only
		// slot DrawButtonKDEx reads it from. `shiftText` is the 16th — the slot the options object
		// landed in while the hotkey silently did nothing.
		expect(btn.options, 'the open button must carry options in the 17th parameter').toBeTruthy();
		expect(btn.shiftText, 'nothing may be sitting in the ShiftText slot').toBeUndefined();
		expect(btn.options.hotkeyPress, 'no hotkeyPress means no keyboard route to chat').toBeTruthy();
		expect(bound.has(String(btn.options.hotkeyPress).toUpperCase()),
			`chat hotkey ${btn.options.hotkeyPress} is bound by KD`).toBe(false);
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * KDM-247 — the quick-emoji picker, which lives in this same file.
 *
 * WHY IT IS IN `coop-chat.js` AND NOT A FILE OF ITS OWN (architecture A1). The picker is not a
 * second concern; it is a SECOND INPUT METHOD FOR THE SAME MESSAGE. Both halves build a
 * `{mp:'chat.say', text}` and hand it to the same `send()`. A separate `coop-emoji.js` would need
 * its own copy of `send()`, its own `addOnce`, its own sentinel-gated `KinkyDungeonDrawGame` wrap
 * and its own `demo-server.js` entry — four duplications to serve one 60-line feature, which is
 * exactly the DRY failure KDM-229 was raised for.
 *
 * WHY THE MRU LOGIC IS HERE AND NOT IN `coop-bootstrap.js` (architecture A3'). Assessment A3 first
 * put the whole recents accessor in the bootstrap, because that file owns every `kdcoop.` storage
 * key. Half of that survived and half did not:
 *
 *   - The KEY STRING and the try/catch around `localStorage` stay in `coop-bootstrap.js`, exposed as
 *     `window.__coopEmojiStore = {read, write}`. That is the property its own comment actually
 *     claims — "the key string lives here only ... so a second, differently-spelled copy cannot
 *     appear later" — and a drawing file still never touches storage directly.
 *   - The PARSING, SEEDING AND MRU ORDER move here, because `coop-bootstrap.js` is 1878 lines and
 *     no spec in this suite executes it: every existing bootstrap test reads it as SOURCE TEXT.
 *     Logic placed there would have been coverable only by an e2e, and R2/R3/R4 are pure list
 *     behaviour that deserves millisecond tests with real controls.
 *
 * WHAT ONLY THIS LAYER CAN SEE — the two silent traps from assessment F1:
 *
 *   1. An entry callback that returns FALSY makes `KDClickButton` report failure
 *      (`KinkyDungeon.ts:4364-4374`), so `KDCheckCustomKeypress` keeps looping, returns false, and
 *      control falls through to the spell branch at `KinkyDungeonGame.ts:2315` — while the reaction
 *      has ALREADY been sent from inside the callback. One keypress, reaction sent AND spell cast.
 *   2. `enabled` (the 3rd positional argument) must be true, or `KDClickButton` refuses the button
 *      and the hotkey is inert.
 *
 * Neither is visible to an e2e that only checks the emoji arrived, because in both cases it does.
 * ═════════════════════════════════════════════════════════════════════════════════════════════ */

/** Every button drawn this frame whose name starts with `prefix`, in draw order. */
const drawn = (buttons: any[], prefix: string) =>
	buttons.filter((b) => String(b.name).startsWith(prefix));

/** One frame, then the buttons that frame declared. `buttons` accumulates, so snapshot the length. */
function frame(h: any) {
	const from = h.buttons.length;
	h.ctx.KinkyDungeonDrawGame(false, 0);
	return h.buttons.slice(from);
}

/**
 * Drive a real KEY through KD's own route: set the game's current-key global, then run the checker
 * registry the way `KDCheckCustomKeypress` does. Returns true if some checker consumed the key.
 *
 * This is the path that matters, and it is NOT the buttons' `hotkeyPress`. An e2e probe inside
 * `KDCheckCustomKeypress` on a real page found our buttons absent from `KDButtonsCache` at match
 * time (`oursAtMatch: []`) — the cache is refilled every frame and our draw lands after the key pump,
 * so a button of ours is always one phase too late to be hotkeyable. `KDKeyCheckers` has no such
 * ordering dependency.
 */
function key(h: any, k: string): boolean {
	h.ctx.KinkyDungeonKeybindingCurrentKey = k;
	let consumed = false;
	for (const checker of Object.values(h.ctx.KDKeyCheckers) as any[]) {
		if (checker()) { consumed = true; break; }
	}
	h.ctx.KinkyDungeonKeybindingCurrentKey = '';
	return consumed;
}

/** Press a drawn button by name, the way `KDClickButton` does. Returns what the callback returned. */
function press(frameButtons: any[], name: string) {
	const b = frameButtons.find((x: any) => x.name === name);
	if (!b) throw new Error(`no button "${name}" was drawn this frame (drawn: ${frameButtons.map((x: any) => x.name).join(', ')})`);
	return b.fn({ source: 'hotkey' });
}

/**
 * Open the picker through its own drawn button, as a player does. Returns the OPEN frame.
 *
 * IDEMPOTENT, because the opener TOGGLES: calling this on an already-open picker would close it,
 * and the caller would then be reading an empty frame and blaming the recents list.
 */
function openPicker(h: any) {
	if (!h.ctx.window.KDCoopChat.isPickerOpen()) key(h, 'U');
	return frame(h);
}

describe('KDM-247 — the picker opens on its own hotkey (R1)', () => {
	it('draws an open button every frame, carrying options in the 17th slot', () => {
		const h = loadChat();
		const f = frame(h);
		const btn = f.find((b: any) => b.name === 'kdcoopemoji');
		expect(btn, 'the picker must have a drawn opener, like chat does').toBeTruthy();
		// POSITION, not presence — the bug this fake was rebuilt for. `options` in the 16th slot is
		// read by the real DrawButtonKDEx as `ShiftText`, and the hotkey silently does nothing.
		expect(btn.options, 'options must arrive in the 17th parameter').toBeTruthy();
		expect(btn.shiftText, 'nothing may sit in the ShiftText slot').toBeUndefined();
		expect(String(btn.options.hotkeyPress).toUpperCase(), 'the picker key is U').toBe('U');
	});

	it('U is genuinely unbound in KD — the same drift guard chat gets for Y', () => {
		// Text-coupled to the game source on purpose, with a declaration count so it cannot go
		// vacuous. `U` is the LAST unbound letter in KD (assessment F1): every other one is taken by
		// KinkyDungeonKey / …KeyWait / …KeyWeapon / …KeyMenu / …KeyToggle / …KeySwitchWeapon, and
		// chat took Y. If upstream ever binds it, this reds instead of one key doing two things.
		const src = readFileSync(KD_KEYS_SRC, 'utf8');
		const re = /^let\s+(KinkyDungeonKey\w*)\s*=\s*\[([^\]]*)\]/gm;
		const bound = new Set<string>();
		let n = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src))) {
			n++;
			for (const raw of m[2].split(',')) {
				const t = raw.trim().replace(/^['"]|['"]$/g, '');
				if (t) bound.add(t.toUpperCase());
			}
		}
		expect(n, 'KinkyDungeonKey* declarations found').toBeGreaterThanOrEqual(10);
		expect(bound.has('W') && bound.has('Y') === false, 'sanity: real bindings, and Y is still free for chat').toBe(true);
		expect(bound.has('U'), 'the picker hotkey U is bound by KD').toBe(false);
	});

	it('registers a checker in KDKeyCheckers WITHOUT displacing KD\'s own', () => {
		// The registry is a plain object, so a careless `KDKeyCheckers = {...}` would silently delete
		// every stock checker (Toggles, Zoom, …) and take half the keyboard down with it.
		const h = loadChat();
		const names = Object.keys(h.ctx.KDKeyCheckers);
		expect(names, 'KD\'s own checkers must survive').toContain('KDStockChecker');
		expect(names.length, 'and exactly one entry of ours is added').toBe(2);
	});

	it('is idempotent across a reconnect re-eval — a property, not a push', () => {
		const h = loadChat();
		runInContext(readFileSync(SRC, 'utf8'), h.ctx, { filename: 'coop-chat.js' });
		expect(Object.keys(h.ctx.KDKeyCheckers).length, 'still one entry of ours, not two').toBe(2);
	});

	it('U opens the picker, and U again closes it', () => {
		const h = loadChat();
		expect(key(h, 'U'), 'the checker consumes U').toBe(true);
		expect(h.ctx.window.KDCoopChat.isPickerOpen()).toBe(true);
		expect(drawn(frame(h), 'kdcoopemoji').length, 'open: opener + entries + close').toBeGreaterThan(1);

		expect(key(h, 'U'), 'and consumes it again to close').toBe(true);
		expect(h.ctx.window.KDCoopChat.isPickerOpen()).toBe(false);
		expect(drawn(frame(h), 'kdcoopemoji').map((b: any) => b.name),
			'closed again, by the same key that opened it').toEqual(['kdcoopemoji']);
	});

	it('KDM-246 REGRESSION — Y opens the chat field, which it never did before KDM-247', () => {
		// The `Y` hotkey shipped broken and no test saw it: KDM-246's e2e opens the field through
		// `KDCoopChat.open()`, not by pressing the key. The cause was the same one KDM-247 hit —
		// our drawn buttons are absent from KDButtonsCache when KDCheckCustomKeypress matches
		// hotkeys — and routing both keys through KDKeyCheckers fixes both at once.
		const h = loadChat();
		expect(h.ctx.window.KDCoopChat.isOpen(), 'CONTROL: closed to begin with').toBe(false);
		expect(key(h, 'Y'), 'the checker consumes Y').toBe(true);
		expect(h.ctx.window.KDCoopChat.isOpen(), 'and the chat field opens').toBe(true);
	});

	it('leaves every other key alone — spells, movement and toggles are untouched', () => {
		// The single most important negative: this checker runs on EVERY keypress in the game, so a
		// key it wrongly claims is a key the player permanently loses.
		const h = loadChat();
		for (const k of ['W', 'A', 'S', 'D', 'X', 'R', 'V', 'I', 'M', 'L', 'O', 'P', 'B', 'T', 'F', 'G', '1', '5', '0', 'Escape', 'Space', '']) {
			expect(key(h, k), `a closed picker must not consume "${k}"`).toBe(false);
		}
		expect(h.sent, 'and nothing was sent').toEqual([]);
		expect(h.ctx.window.KDCoopChat.isPickerOpen()).toBe(false);
	});

	it('does not answer keys outside play (menus, modal screens)', () => {
		// KD's own checkers gate on this pair; without it the picker would eat digits on the title
		// screen and in the wardrobe.
		const h = loadChat();
		h.ctx.KinkyDungeonDrawState = 'Menu';
		expect(key(h, 'U'), 'U is not ours while a menu is up').toBe(false);
		expect(h.ctx.window.KDCoopChat.isPickerOpen()).toBe(false);
		h.ctx.KinkyDungeonDrawState = 'Game';
		expect(key(h, 'U'), 'CONTROL: and it is ours again in play').toBe(true);
	});

	it('draws NO entries while closed, so the digits are not even offered', () => {
		const h = loadChat();
		expect(drawn(frame(h), 'kdcoopemoji').map((b: any) => b.name),
			'closed means opener only').toEqual(['kdcoopemoji']);
	});
});

describe('KDM-247 — an open picker offers one keypress per emoji (R1, F1)', () => {
	it('every entry is enabled and carries a digit hotkey in the 17th slot', () => {
		const h = loadChat();
		const entries = drawn(openPicker(h), 'kdcoopemoji').filter((b: any) => /kdcoopemoji\d+$/.test(b.name));
		expect(entries.length, 'an open picker with no entries is not a picker').toBeGreaterThan(0);

		const keys = entries.map((b: any) => b.options && b.options.hotkeyPress);
		// Digits 1..N in order, so slot 1 is the first key — and each is distinct, because
		// KDButtonsCache is keyed by NAME and a duplicate hotkey would make two buttons race.
		expect(keys).toEqual(entries.map((_: any, i: number) => String(i + 1)));
		expect(new Set(keys).size, 'no two entries share a key').toBe(entries.length);
		expect(new Set(entries.map((b: any) => b.name)).size, 'no two entries share a NAME').toBe(entries.length);

		for (const b of entries) {
			expect(b.options, `entry ${b.name} must carry options in the 17th slot`).toBeTruthy();
			expect(b.shiftText, `entry ${b.name} put something in the ShiftText slot`).toBeUndefined();
			// F1 trap 2 — KDClickButton checks `button.enabled` before calling `func`.
			expect(b.enabled, `entry ${b.name} must be enabled or its hotkey is inert`).toBe(true);
		}
	});

	it('EVERY entry callback returns true — or the keypress also casts a spell (F1 trap 1)', () => {
		// The nastiest bug this feature can have, and it is invisible from the outside: the reaction
		// IS sent, so an e2e that checks the partner received it passes. Only the return value says
		// whether `1` also fired spell 1.
		const h = loadChat();
		const entries = drawn(openPicker(h), 'kdcoopemoji').filter((b: any) => /kdcoopemoji\d+$/.test(b.name));
		for (const b of entries) {
			const out = b.fn({ source: 'hotkey' });
			expect(out, `entry ${b.name} returned ${JSON.stringify(out)}; a falsy return falls through ` +
				'to KinkyDungeonGame.ts:2315 and casts a spell as well').toBe(true);
			openPicker(h);   // it closed on send — reopen for the next entry
		}
	});

	it('pressing an entry sends chat.say with that emoji, and closes', () => {
		const h = loadChat();
		const open = openPicker(h);
		const first = drawn(open, 'kdcoopemoji').find((b: any) => b.name === 'kdcoopemoji0');
		const label = first.label;
		expect(label, 'an entry must be drawn with the emoji as its label').toBeTruthy();

		press(open, 'kdcoopemoji0');
		// The SAME action shape chat sends — one pipeline, not two (R6).
		expect(h.sent, 'a reaction is a chat message').toEqual([{ mp: 'chat.say', text: label }]);
		expect(drawn(frame(h), 'kdcoopemoji').map((b: any) => b.name),
			'sending closes the picker, so the digits go back to casting spells').toEqual(['kdcoopemoji']);
	});

	it('Escape closes without sending — by mouse and by key', () => {
		const h = loadChat();
		expect(press(openPicker(h), 'kdcoopemojiclose'), 'the close button obeys the return-true rule').toBe(true);
		expect(h.sent, 'the close button sends nothing').toEqual([]);
		expect(drawn(frame(h), 'kdcoopemoji').map((b: any) => b.name)).toEqual(['kdcoopemoji']);

		openPicker(h);
		expect(key(h, 'Escape'), 'and the key is consumed while open').toBe(true);
		expect(h.ctx.window.KDCoopChat.isPickerOpen()).toBe(false);
		expect(h.sent, 'Escape cancels — nothing is sent').toEqual([]);
	});

	/* ── THE KEYBOARD ROUTE — what F1 was really about ───────────────────────────────────────── */

	it('a digit sends its slot\'s emoji and CONSUMES the key, so no spell is cast', () => {
		// The consumed/not-consumed answer IS the spell answer: `KDCheckCustomKeypress` returning
		// true makes KinkyDungeonGameKeyDown `return true` at :2287, before the spell branch at
		// :2315. Returning falsy lets the digit fall through and cast.
		const h = loadChat();
		const list = h.ctx.window.KDCoopChat.recents();
		openPicker(h);
		expect(key(h, '1'), 'the picker owns `1` while it is open').toBe(true);
		expect(h.sent, 'and slot 1 is what it sends — the same shape chat uses (R6)')
			.toEqual([{ mp: 'chat.say', text: list[0] }]);
		expect(h.ctx.window.KDCoopChat.isPickerOpen(), 'sending closes it').toBe(false);
	});

	it('EVERY slot sends ITS OWN emoji — not the last one the loop saw', () => {
		// A shared loop variable would make all eight entries send slot 8. The bug is invisible in a
		// one-slot test and obvious here.
		const h = loadChat();
		const list = h.ctx.window.KDCoopChat.recents();
		for (let i = 0; i < list.length; i++) {
			const before = h.sent.length;
			openPicker(h);
			expect(key(h, String(i + 1)), `slot ${i + 1} must consume its digit`).toBe(true);
			expect(h.sent.slice(before), `slot ${i + 1} sent the wrong emoji`)
				.toEqual([{ mp: 'chat.say', text: list[i] }]);
			// The list re-orders as we go (R2), so re-read it for the next slot.
			list.splice(0, list.length, ...h.ctx.window.KDCoopChat.recents());
		}
	});

	it('THE KEY GOES BACK once the picker closes — the whole F1 safety argument', () => {
		// If this ever reds, the feature has permanently stolen a game key: `1` would be consumed
		// here and never reach KinkyDungeonHandleSpell. The e2e asserts the same thing against KD's
		// real spell entry point; this asserts it against the contract.
		const h = loadChat();
		openPicker(h);
		key(h, '1');
		expect(h.ctx.window.KDCoopChat.isPickerOpen(), 'precondition: it closed').toBe(false);
		for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
			expect(key(h, d), `a closed picker must not consume "${d}"`).toBe(false);
		}
		expect(h.sent.length, 'and nothing further was sent').toBe(1);
	});

	it('an unclaimed key leaves an OPEN picker open and falls through', () => {
		// `9` and `0` are real spell keys with no slot behind them. Eating them silently would be a
		// key the player loses whenever the picker happens to be open.
		const h = loadChat();
		openPicker(h);
		expect(key(h, '9'), 'no slot 9, so not ours').toBe(false);
		expect(key(h, 'W'), 'and movement is never ours').toBe(false);
		expect(h.ctx.window.KDCoopChat.isPickerOpen(), 'the picker is still open').toBe(true);
		expect(h.sent, 'nothing sent').toEqual([]);
	});

	it('the close button uses Escape, which is not a KD movement or spell key', () => {
		const h = loadChat();
		const close = drawn(openPicker(h), 'kdcoopemoji').find((b: any) => b.name === 'kdcoopemojiclose');
		expect(close, 'a mouse user needs a way out too').toBeTruthy();
		expect(close.options && close.options.hotkeyPress).toBe('Escape');
		expect(close.enabled).toBe(true);
	});
});

describe('KDM-247 — recents are seeded, ordered and persisted (R2, R3, R4)', () => {
	/**
	 * The emoji an OPEN picker is offering, slot order (slot 1 first).
	 *
	 * It opens the picker itself rather than assuming it is already open, because sending CLOSES it
	 * — so "what is on offer now" and "what was on offer before I picked" need the same call. A
	 * version of this that only drew a frame reported `[]` after every send, which reads exactly like
	 * a recents list that failed to persist.
	 */
	const offered = (h: any) => {
		openPicker(h);
		return drawn(frame(h), 'kdcoopemoji')
			.filter((b: any) => /kdcoopemoji\d+$/.test(b.name))
			.map((b: any) => b.label);
	};

	it('R3 — a first run is offered the default set, not an empty picker', () => {
		// Nothing stored: the accessor must answer with the seed set, so the picker is useful before
		// any usage history exists. This is the owner's explicit ask (2026-08-22).
		const h = loadChat({ stored: null });
		press(frame(h), 'kdcoopemoji');
		const list = offered(h);
		expect(list.length, 'the seed set must be non-empty').toBeGreaterThan(0);
		expect(new Set(list).size, 'and free of duplicates').toBe(list.length);
		expect(list.every((e: string) => typeof e === 'string' && e.length > 0)).toBe(true);
	});

	it('R2 — sending an emoji moves it to the front, without duplicating it', () => {
		const h = loadChat({ stored: null });
		press(frame(h), 'kdcoopemoji');
		const before = offered(h);
		const third = before[2];

		press(openPicker(h), 'kdcoopemoji2');       // the third slot
		const after = offered(h);

		expect(after[0], 'the one just used leads the list').toBe(third);
		expect(after.filter((e: string) => e === third).length, 'and appears exactly once').toBe(1);
		// CONTROL: this is a REORDER, not a rewrite — the same set of emoji is still on offer.
		expect([...after].sort()).toEqual([...before].sort());
	});

	it('R4 — the new order is written through the store, and read back next time', () => {
		const h = loadChat({ stored: null });
		press(frame(h), 'kdcoopemoji');
		const picked = offered(h)[3];
		press(openPicker(h), 'kdcoopemoji3');

		expect(h.writes.length, 'a send must persist the new order').toBeGreaterThan(0);
		expect(JSON.parse(h.writes[h.writes.length - 1])[0], 'stored MRU-first').toBe(picked);

		// A FRESH LOAD — a new session on the same client — reads it back.
		const next = loadChat({ stored: h.read() });
		press(frame(next), 'kdcoopemoji');
		expect(offered(next)[0], 'recents survive the session (R4)').toBe(picked);
	});

	it('R4 — corrupt, hostile or absent storage degrades to the seed set, never throws', () => {
		// The stored value is untrusted: a hand-edited key must not break the picker, and must not
		// let an arbitrary string reach send(). Same "degraded, never broken" contract as
		// `briefingSeen` (KDM-272 AC3).
		const seed = (() => { const h = loadChat({ stored: null }); press(frame(h), 'kdcoopemoji'); return offered(h); })();
		for (const bad of ['', 'not json', '{}', '[]', 'null', '[1,2,3]', '["ok",{"a":1}]', '"a string"']) {
			const h = loadChat({ stored: bad });
			expect(() => { press(frame(h), 'kdcoopemoji'); }, `stored ${JSON.stringify(bad)} threw`).not.toThrow();
			const list = offered(h);
			expect(list.length, `stored ${JSON.stringify(bad)} left an unusable picker`).toBe(seed.length);
			expect(list.every((e: string) => typeof e === 'string' && e.length > 0),
				`stored ${JSON.stringify(bad)} let a non-string reach the picker`).toBe(true);
		}
	});

	it('a missing store (bootstrap absent) is survivable — no throw, no crash, no send', () => {
		// Load order makes this unreachable in production (`demo-server.js` injects coop-bootstrap.js
		// first), so this asserts DEGRADATION, not a supported mode: the game must not break because
		// one optional client file did not load.
		const h = loadChat({ noStore: true });
		expect(() => { press(frame(h), 'kdcoopemoji'); frame(h); }, 'the draw wrap must not throw').not.toThrow();
		expect(h.ctx.KinkyDungeonDrawGame._kdcoop_chat_wrapped, 'and the wrap survives').toBe(1);
	});

	it('CONTROL: the picker never touches localStorage itself — only the store', () => {
		// A3': the key string lives in coop-bootstrap.js alone. A picker that reached for
		// localStorage directly would be the "second, differently-spelled copy" that comment warns
		// about, and this file's fake scope has no localStorage at all — so it would throw.
		// Matched on the CALL, not on the word: the file is allowed to say "localStorage" in a comment
		// explaining why it does not use it, and the first version of this guard reded on exactly
		// that. What must not appear is an access — `localStorage.getItem`, `.setItem`, `.removeItem`,
		// or a bare `window.localStorage` handle.
		const src = readFileSync(SRC, 'utf8');
		const calls = src.match(/localStorage\s*\.\s*\w+|window\s*\.\s*localStorage(?!\s*`)/g) || [];
		expect(calls, 'coop-chat.js must go through window.__coopEmojiStore, never storage directly').toEqual([]);
		// DRIFT REPORT: if the file stops mentioning the seam at all, this guard is guarding nothing.
		expect(src.includes('__coopEmojiStore'), 'and it must actually use that seam').toBe(true);
		// The key string belongs to coop-bootstrap.js alone — a second spelling here is the
		// duplication that file's own comment warns about.
		expect(src.match(/['"]kdcoop\.\w+['"]/g) || [], 'no storage key may be spelled here').toEqual([]);
	});
});

describe('KDM-247 — the picker survives a reconnect re-eval, like everything else here', () => {
	it('re-evaluating the file does not double the drawn buttons', () => {
		// This file is re-evaluated on reconnect. The existing cases prove the ARRAY pushes are
		// guarded; this proves the new draw code is too — a second wrap would draw every button
		// twice, and two buttons with one name is a KDButtonsCache collision.
		const h = loadChat();
		runInContext(readFileSync(SRC, 'utf8'), h.ctx, { filename: 'coop-chat.js' });
		const f = frame(h);
		expect(f.filter((b: any) => b.name === 'kdcoopemoji').length, 'one opener, not two').toBe(1);
		expect(f.filter((b: any) => b.name === 'kdcoopchat').length, 'CONTROL: chat is still single too').toBe(1);
	});
});
