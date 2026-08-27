/**
 * E2E (KDM-246) — two browsers, one real keyboard, one message.
 *
 * The unit specs prove the SERVER carries a message and that the client script installs correctly
 * against a fake scope. Neither can see the three things that only exist in a real page:
 *
 *   AC1/AC2  a player TYPES into the real DOM field and the partner's own log grows.
 *   AC5      while that field has focus, W/A/S/D type letters instead of walking — and movement
 *            comes back afterwards. Memory `False "input lost" oracles`: KD binds WASD (not arrows),
 *            and a blocked move still resolves a turn, so this must be read as
 *            "did the position change", never as "did a turn advance".
 *   AC6      the client half of the `Chat` filter — assessment F4 left open whether a toggle
 *            SURVIVES the next state frame, because `KDGameData.LogFilters` is adopted from the
 *            server bundle (`render-client.js:343-347`). That question is settled here, by
 *            experiment, and not by an argument in a comment.
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, MP_TEST_TIMEOUT, coopRealKeyMove, coopPos, reportedPageErrors,
	recordDrawnText, readDrawnText, restoreDrawnText,
} from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Every line of this client's own message log, as KD holds it after adopting the frame. */
async function logTexts(P: any): Promise<string[]> {
	return P.evaluate(() =>
		// @ts-ignore bare let-global
		(KinkyDungeonMessageLog || []).map((m: any) => (m && m.text) != null ? m.text : String(m)));
}

/** Open the chat field the way a player does — through the drawn button's own action. */
async function openChat(P: any): Promise<boolean> {
	return P.evaluate(() => {
		const w = window as any;
		if (!w.KDCoopChat || typeof w.KDCoopChat.open !== 'function') return false;
		w.KDCoopChat.open();
		return true;
	});
}

test('a typed message reaches the partner, costs no turn, and does not eat WASD', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errsA: string[] = []; const errsB: string[] = [];
	A.on('pageerror', (e) => errsA.push(String(e && e.message ? e.message : e)));
	B.on('pageerror', (e) => errsB.push(String(e && e.message ? e.message : e)));

	try {
		await bootCoopPair(A, B, port);

		// ---- precondition: the client half is actually installed -------------------------------
		expect(await P_installed(A), 'coop-chat.js must be injected and installed').toBe(true);
		expect(await P_installed(B)).toBe(true);
		// Armed BEFORE the message is sent, so the recorder cannot miss the frame that paints it.
		await recordDrawnText(B);

		// ---- AC1/AC2 — A types, both logs grow -------------------------------------------------
		// Recorded so a failure message can show what the logs looked like beforehand.
		const bBefore = (await logTexts(B)).length;
		const aBefore = (await logTexts(A)).length;
		const turnBefore = await A.evaluate(() => (window as any).__coop.lastTick);

		expect(await openChat(A), 'the chat field opens').toBe(true);
		// One frame must pass for the wrap to actually create the DOM element. On failure, report the
		// draw wrap's own recorded error rather than a bare "waitForFunction timed out" — the wrap
		// catches so chat can never break the log, and a swallowed throw is otherwise invisible.
		await A.waitForFunction(() => !!document.getElementById('KDCoopChatInput'), null, { timeout: 15_000 })
			.catch(async () => {
				const why = await A.evaluate(() => {
					const w = window as any;
					return {
						diag: w.KDCoopChat && w.KDCoopChat.diag ? w.KDCoopChat.diag() : "no handle",
						isOpen: w.KDCoopChat && w.KDCoopChat.isOpen ? w.KDCoopChat.isOpen() : null,
						// @ts-ignore bare let-global — did KD's own draw pass run at all this frame?
						hasTextField: typeof KDTextField === 'function',
						// @ts-ignore
						state: typeof KinkyDungeonState !== 'undefined' ? KinkyDungeonState : 'undef',
						// Is the property we wrapped the SAME binding the bundle calls? A bundle
						// top-level `function` is a global-OBJECT property, so these must agree — and
						// if they do not, bare-name wrapping of a bundle function is the wrong seam.
						// @ts-ignore
						sameBinding: (w as any).KinkyDungeonDrawGame === KinkyDungeonDrawGame,
						globalIsWrapped: !!((w as any).KinkyDungeonDrawGame
							&& (w as any).KinkyDungeonDrawGame._kdcoop_chat_wrapped),
					};
				});
				throw new Error(`chat field never appeared: ${JSON.stringify(why)}`);
			});

		// A REAL keystroke sequence into the real input, not a value assignment: the point of AC5 is
		// what the keyboard does while this element has focus.
		await A.evaluate(() => (document.getElementById('KDCoopChatInput') as HTMLInputElement).focus());
		const posBeforeTyping = await coopPos(A);
		await A.keyboard.type('wasd behind you');
		await A.keyboard.press('Enter');

		// AC5, first half — those W/A/S/D keystrokes were TEXT, not movement.
		expect(await coopPos(A), 'typing must not walk the player (AC5)').toEqual(posBeforeTyping);

		// WAIT ON THE TEXT, NOT ON THE LENGTH. `_pushLog` trims to `maxLog` with a `shift()`
		// (`swap-session.js`), so once the log is at its cap an appended line does not make it longer
		// — a length oracle then waits forever for a message that has already arrived. (It did.)
			// @ts-ignore bare let-global: KinkyDungeonMessageLog is NOT a window property (CLAUDE.md).
		await B.waitForFunction(
			() => ((KinkyDungeonMessageLog as any) || [])
				.some((m: any) => m && typeof m.text === 'string' && m.text.indexOf('behind you') >= 0),
			null, { timeout: 30_000 })
			.catch(async () => {
				const why = {
					aFocused: await A.evaluate(() => document.activeElement && document.activeElement.id),
					aLogHasIt: (await logTexts(A)).some((t) => t.indexOf('behind you') >= 0),
					aTail: (await logTexts(A)).slice(-3), aBefore, bBefore,
					bTail: (await logTexts(B)).slice(-3),
				};
				throw new Error(`the message never reached B: ${JSON.stringify(why)}`);
			});

		expect((await logTexts(B)).join('\n'), 'AC1 — the partner reads it').toContain('behind you');
		expect((await logTexts(A)).join('\n'), 'AC2 — and so does the sender').toContain('behind you');
		// CONTROL — EXACTLY ONCE in each log, not merely "present".
		//
		// `_say` goes through `_broadcast`, which loops every joined player; a sender echo added on
		// top of that would double the line, and "contains" cannot tell the difference. Measured
		// note: both logs start EMPTY at boot here, so a length-based sanity check asserts nothing —
		// note: both logs start EMPTY at boot here, so a length-based sanity check asserts nothing.
		const count = (xs: string[]) => xs.filter((t) => t.indexOf('behind you') >= 0).length;
		expect(count(await logTexts(A)), 'the sender must see it once, not twice').toBe(1);
		expect(count(await logTexts(B)), 'and so must the partner').toBe(1);

		// ---- R4, at the only layer that counts: is it PAINTED? ----------------------------------
		// "It is in KinkyDungeonMessageLog" is a data assertion, and a chat nobody can read is not a
		// chat. This matters here more than usual: the co-op render client turned out NOT to call
		// `KinkyDungeonDrawMessages` at all (see the wrap note in `coop-chat.js`), so whether KD's log
		// reaches the player's screen in a co-op session is a real question, not a formality.
		// `recordDrawnText` wraps `DrawTextVisKD`, the choke point every KD text path funnels into —
		// what it records is what a player could read.
		await B.waitForTimeout(2000);           // a few frames, at the ~3 fps this host renders
		const painted = await readDrawnText(B);
		expect(painted.texts.join('\n'),
			`R4 — the chat line must actually be drawn (truncated=${painted.truncated}, texts=${JSON.stringify(painted.texts.slice(0, 12))})`)
			.toContain('behind you');
		// The project-wide invariant, asserted while we happen to be recording.
		expect(painted.unresolved, 'no unresolved text key may be painted').toEqual([]);

		// ---- CHAT DRAWS ONLY CHAT (KDM-285) -----------------------------------------------------
		//
		// This used to assert `logDraws === ourLogDraws` — "chat is the only caller of the game's log
		// draw" — because chat called `KinkyDungeonDrawMessages()` itself. That call was a symptom
		// fix for a defect of ours (`ensureQuickBind` leaving a targeting spell armed forever, which
		// makes KD hide the log); with the cause fixed, KD paints its own log and chat calls nothing.
		// `mp-coop-log-visible.spec.ts` owns that assertion now. What is left to check here is that
		// chat's per-frame hook is alive and not swallowing throws — the line above already proved
		// the message itself was PAINTED, which is the outcome those counters existed to protect.
		const draws = await B.evaluate(() => (window as any).KDCoopChat.diag());
		expect(draws.drawCalls, "chat's own per-frame hook is running").toBeGreaterThan(0);
		expect(draws.lastError, 'chat must not be swallowing a throw every frame').toBe(null);

		// R2 — the shared turn counter never moved for this.
		expect(await A.evaluate(() => (window as any).__coop.lastTick),
			'chat resolves no turn (R2)').toBe(turnBefore);

		// ---- AC5, second half — movement comes back --------------------------------------------
		// `coopRealKeyMove` drives KD's OWN binding through a real keypress. `moved` is the oracle;
		// `advanced` is not, because a blocked move still resolves a turn.
		const walk = await coopRealKeyMove(A, B);
		expect(walk.advanced, 'the session still resolves turns after chatting').toBe(true);
		expect(walk.moved || walk.control.moved,
			`movement is back after Escape/Enter (walk=${JSON.stringify(walk)})`).toBe(true);

		// ---- AC6 (client half) — does a Chat filter toggle SURVIVE the next frame? --------------
			// @ts-ignore bare let-global
		expect(await A.evaluate(() => ((KDLogFilters as any) || []).indexOf("Chat") >= 0),
			'the Chat filter tab is registered').toBe(true);

		await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore bare let-global: KDGameData is NOT on window (CLAUDE.md).
			KDGameData.LogFilters = KDGameData.LogFilters || {};
			// @ts-ignore
			KDGameData.LogFilters.Chat = false;
			// CONTROL: a filter KD owns, toggled in the same breath. If BOTH revert, the finding is
			// "the server owns LogFilters", not "our key is special".
			// @ts-ignore
			KDGameData.LogFilters.__kdControl = false;
		});
		// Force at least one server frame to be adopted, which is the thing that might clobber it.
		await A.evaluate(() => (window as any).__coop.sendAction({ mp: 'chat.say', text: 'after' }));
		await A.waitForTimeout(1500);

		const filters = await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore
			return { chat: KDGameData.LogFilters.Chat, control: KDGameData.LogFilters.__kdControl };
		});
		expect(filters,
			'F4: a player toggle must survive a state frame — if this reds, LogFilters is client-owned '
			+ 'state that must be excluded from the captured bundle')
			.toEqual({ chat: false, control: false });

		// ---- invariants required of every e2e in this project ----------------------------------
		for (const [label, errs] of [['A', errsA], ['B', errsB]] as const) {
			const { real, ignored } = reportedPageErrors(errs);
			expect(real, `${label} page errors (ignored known noise: ${ignored.join(', ')})`).toEqual([]);
		}
		await restoreDrawnText(B).catch(() => {});
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise((r) => server.close(r));
		if (bridge && typeof bridge.close === 'function') bridge.close();
	}
});

/** Is the client script installed on this page? Kept out of the test body for readability. */
async function P_installed(P: any): Promise<boolean> {
	return P.evaluate(() => {
		const w = window as any;
		// @ts-ignore bare let-global
		return !!(typeof KinkyDungeonDrawGame === 'function'
			// @ts-ignore
			&& (KinkyDungeonDrawGame as any)._kdcoop_chat_wrapped && w.KDCoopChat);
	});
}

/**
 * E2E (KDM-247) — a quick reaction, and the digit KD gets back afterwards.
 *
 * The unit specs prove the picker declares its buttons correctly against a fake scope, and that the
 * server carries the text. Two things live only in a real page:
 *
 *   R1/R5  a reaction sent from the picker lands in the PARTNER's log, attributed, over a real
 *          session — the same journey a typed message makes, which is what "one pipeline" means.
 *   F1     PRESSING `1` CASTS A SPELL AGAIN ONCE THE PICKER CLOSES. This is the whole safety
 *          argument for using the digits, and no fake can carry it: it rests on KD wiping
 *          `KDButtonsCache` every frame (`KinkyDungeon.ts:1668-1669`) so an undrawn entry is not
 *          hotkeyable, and on `KDCheckCustomKeypress` running before the spell branch
 *          (`KinkyDungeonGame.ts:2287` vs `:2315`). Both are game code we do not own.
 *
 * R7 BINDS THIS FILE: assert on log DATA and call counts, never on pixels. Emoji render through
 * `PIXI.Text` via the browser's font stack, and the Docker test images may carry no colour-emoji
 * font at all — a glyph assertion here would red on the harness's fonts rather than on this feature.
 * A missing glyph is a UAT finding by owner decision, not a suite failure.
 */
test('a picked reaction reaches the partner, and the digits go back to casting spells', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errsA: string[] = []; const errsB: string[] = [];
	A.on('pageerror', (e) => errsA.push(String(e && e.message ? e.message : e)));
	B.on('pageerror', (e) => errsB.push(String(e && e.message ? e.message : e)));

	try {
		await bootCoopPair(A, B, port);

		expect(await A.evaluate(() => !!(window as any).KDCoopChat),
			'coop-chat.js (which now carries the picker) must be installed').toBe(true);

		/**
		 * Count KD's own spell entry point. This is the F1 oracle, and it is deliberately a COUNTER
		 * on the game's function rather than any state of ours: it answers "did KD's spell branch
		 * run for that keypress", which is exactly the question, and it stays true whether or not
		 * the player actually has a spell in that slot (the branch calls it either way).
		 */
		await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore bare let-global — bundle functions are not on window (CLAUDE.md).
			if (typeof KinkyDungeonHandleSpell !== 'function') { w.__spellCalls = null; return; }
			w.__spellCalls = 0;
			// @ts-ignore
			const prev = KinkyDungeonHandleSpell;
			// @ts-ignore bare-name assignment, per CLAUDE.md — NOT via globalThis.
			KinkyDungeonHandleSpell = function (...a: any[]) { w.__spellCalls++; return prev.apply(this, a); };
		});
		expect(await A.evaluate(() => (window as any).__spellCalls),
			'the spell oracle must be armed, or every F1 assertion below is vacuous').toBe(0);

		// ---- R1/R5 — pick slot 1, and the partner reads it -------------------------------------
		// Read what slot 1 holds BEFORE opening, so the assertion names the emoji rather than
		// guessing one and asserting against its own guess.
		const slot1 = await A.evaluate(() => (window as any).KDCoopChat.recents()[0]);
		expect(slot1, 'slot 1 must offer something even on a first run (R3)').toBeTruthy();

		// A REAL `U` keypress — not `openPicker()`. This is the assertion the whole KDKeyCheckers
		// rework exists for: the first design hung the hotkey off the drawn button's `hotkeyPress`,
		// and a probe inside KDCheckCustomKeypress proved our buttons are absent from KDButtonsCache
		// at match time (`oursAtMatch: []`), because our draw lands after the frame's key pump. Only
		// a real page can tell those two designs apart, so only a real key may be pressed here.
		//
		// Held, not tapped: this harness renders at a few fps and KD samples the key once per frame.
		await A.keyboard.down('u');
		await A.waitForTimeout(600);
		await A.keyboard.up('u');
		await A.waitForFunction(() => (window as any).KDCoopChat.isPickerOpen(), null, { timeout: 15_000 })
			.catch(() => { throw new Error('a real `U` keypress did not open the picker — the keyboard route is broken'); });

		// A REAL held keypress. Held, not pressed: this harness renders at a few fps and KD samples
		// key state once per frame, so a keydown+keyup can land entirely between two polls
		// (the reason `coopRealKeyMove` holds too).
		await A.keyboard.down('1');
		await A.waitForTimeout(600);
		await A.keyboard.up('1');

		// @ts-ignore bare let-global: KinkyDungeonMessageLog is NOT a window property.
		await B.waitForFunction((emoji) => ((KinkyDungeonMessageLog as any) || [])
			.some((m: any) => m && typeof m.text === 'string' && m.text.indexOf(emoji) >= 0),
		slot1, { timeout: 30_000 })
			.catch(async () => {
				const why = {
					slot1,
					stillOpen: await A.evaluate(() => (window as any).KDCoopChat.isPickerOpen()),
					aTail: await A.evaluate(() => ((KinkyDungeonMessageLog as any) || []).slice(-3).map((m: any) => m && m.text)),
					bTail: await B.evaluate(() => ((KinkyDungeonMessageLog as any) || []).slice(-3).map((m: any) => m && m.text)),
					diag: await A.evaluate(() => (window as any).KDCoopChat.diag()),
				};
				throw new Error(`the reaction never reached B: ${JSON.stringify(why)}`);
			});

		const bTexts = await B.evaluate(() => ((KinkyDungeonMessageLog as any) || [])
			.map((m: any) => (m && m.text) != null ? m.text : String(m)));
		// Attributed, and exactly once — `_broadcast` loops every joined player, so a sender echo on
		// top would double it and `toContain` could not tell.
		expect(bTexts.filter((t: string) => t.indexOf(slot1) >= 0).length,
			'the partner sees the reaction once, not twice').toBe(1);
		expect(bTexts.find((t: string) => t.indexOf(slot1) >= 0),
			'and it carries the sender name, like any chat line').toMatch(/\S+:\s*/);

		// ---- F1 — that keypress must NOT have cast a spell -------------------------------------
		expect(await A.evaluate(() => (window as any).__spellCalls),
			'while the picker was open, `1` belonged to the picker alone').toBe(0);
		expect(await A.evaluate(() => (window as any).KDCoopChat.isPickerOpen()),
			'sending closes the picker').toBe(false);

		// ---- F1, the half that only a real page can answer -------------------------------------
		// The picker is closed, so its entries are no longer drawn, so they are no longer in
		// KDButtonsCache, so `1` should reach the spell branch exactly as it did before this feature
		// existed. If this stays 0, the feature has permanently stolen a game key.
		await A.keyboard.down('1');
		await A.waitForTimeout(600);
		await A.keyboard.up('1');
		await A.waitForFunction(() => (window as any).__spellCalls > 0, null, { timeout: 15_000 })
			.catch(async () => {
				throw new Error('after the picker closed, `1` never reached KD\'s spell branch — the '
					+ 'picker has permanently stolen a game key. '
					+ JSON.stringify({ spellCalls: await A.evaluate(() => (window as any).__spellCalls) }));
			});

		// CONTROL: no second reaction leaked out of that keypress.
		const bAfter = await B.evaluate(() => ((KinkyDungeonMessageLog as any) || [])
			.map((m: any) => (m && m.text) != null ? m.text : String(m)));
		expect(bAfter.filter((t: string) => t.indexOf(slot1) >= 0).length,
			'a closed picker sends nothing').toBe(1);

		// ---- KDM-246 REGRESSION — chat's own `Y` hotkey, pressed for real ----------------------
		// It shipped broken and nothing saw it: KDM-246's e2e opens the field through
		// `KDCoopChat.open()`, so no test at any layer ever pressed the key. Same root cause, same
		// fix (KDKeyCheckers), and the lesson is that only a real keypress can assert a hotkey — so
		// it is asserted here, on the pair this test has already booted.
		expect(await A.evaluate(() => (window as any).KDCoopChat.isOpen()),
			'CONTROL: the chat field is closed to begin with').toBe(false);
		await A.keyboard.down('y');
		await A.waitForTimeout(600);
		await A.keyboard.up('y');
		await A.waitForFunction(() => (window as any).KDCoopChat.isOpen(), null, { timeout: 15_000 })
			.catch(() => { throw new Error('a real `Y` keypress did not open the chat field (KDM-246 regression)'); });
		await A.evaluate(() => (window as any).KDCoopChat.close());

		// ---- the project-wide invariants -------------------------------------------------------
		const diag = await A.evaluate(() => (window as any).KDCoopChat.diag());
		expect(diag.lastError, 'the draw wrap must not be swallowing a throw every frame').toBe(null);
		for (const [label, errs] of [['A', errsA], ['B', errsB]] as const) {
			const { real, ignored } = reportedPageErrors(errs);
			expect(real, `${label} page errors (ignored known noise: ${ignored.join(', ')})`).toEqual([]);
		}
	} finally {

		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
		if (bridge && typeof bridge.close === 'function') bridge.close();
	}
});
