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
function loadChat(opts: { sendAction?: (a: any) => void } = {}) {
	(vanillaDrawMessages as any).calls = [];
	const armed: string[] = [];
	const sent: any[] = [];
	const buttons: any[] = [];
	const fields: any[] = [];
	const textKeys: Record<string, string> = {};
	const listeners: Record<string, (e: any) => void> = {};

	const element: any = {
		id: 'KDCoopChatInput',
		value: '',
		addEventListener: (t: string, fn: any) => { listeners[t] = fn; },
		removeEventListener: (t: string) => { delete listeners[t]; },
		blur: () => {},
		focus: () => {},
	};

	const ctx: any = {
		window: { __coop: { sendAction: opts.sendAction || ((a: any) => sent.push(a)) } },
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
		) => { buttons.push({ name, fn, options, shiftText: _shiftText }); return true; },
		addTextKey: (k: string, v: string) => { textKeys[k] = v; },
		TextGet: (k: string) => textKeys[k] || k,
		KinkyDungeonRootDirectory: '',
		setInterval: (_fn: any, ms: number) => { armed.push(`setInterval(${ms})`); return 0; },
		setTimeout: (_fn: any, ms: number) => { armed.push(`setTimeout(${ms})`); return 0; },
		clearInterval: () => {}, clearTimeout: () => {},
		console: { warn: () => {}, log: () => {}, error: () => {} },
	};
	createContext(ctx);
	runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'coop-chat.js' });
	return { ctx, armed, sent, buttons, fields, textKeys, listeners, element };
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

		const opener = buttons[buttons.length - 1];
		opener.fn({});                       // the player clicks it (or presses the hotkey)
		ctx.KinkyDungeonDrawGame(false, 0);
		expect(fields.length, 'now it is drawn, so it exists and stays alive').toBe(1);
		expect(fields[0][0], 'and it is the id registered as focusable').toBe('KDCoopChatInput');
	});

	it('Enter sends a chat.say action and closes; Escape sends nothing', () => {
		const { ctx, buttons, listeners, element, sent, fields } = loadChat();
		ctx.KinkyDungeonDrawGame(false, 0);
		buttons[buttons.length - 1].fn({});
		ctx.KinkyDungeonDrawGame(false, 0);

		element.value = 'behind you';
		listeners.keydown({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
		expect(sent, 'one message, in the shape KDM-247 will reuse').toEqual([{ mp: 'chat.say', text: 'behind you' }]);

		const drawn = fields.length;
		ctx.KinkyDungeonDrawGame(false, 0);
		expect(fields.length, 'sending closes it — the field stops being drawn').toBe(drawn);

		// Escape: reopen, type, cancel.
		buttons[buttons.length - 1].fn({});
		ctx.KinkyDungeonDrawGame(false, 0);
		element.value = 'never mind';
		listeners.keydown({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} });
		expect(sent.length, 'Escape cancels — nothing is sent').toBe(1);
	});

	it('an empty Enter sends nothing — the server refusal is a backstop, not the UI', () => {
		const { ctx, buttons, listeners, element, sent } = loadChat();
		ctx.KinkyDungeonDrawGame(false, 0);
		buttons[buttons.length - 1].fn({});
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
		const btn = buttons[buttons.length - 1];
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
