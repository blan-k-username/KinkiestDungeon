/**
 * KDM-246 — co-op chat: one player types, the other reads it.
 *
 * Chat is an `mp:` action (`SwapSession._applyMPAction`), NOT a KD input. That distinction is the
 * first thing these tests pin, and it is not cosmetic: `_toInput` ends `return { kdType: 'tick' }`,
 * so anything the session does not recognise as `mp:` silently becomes a WAIT and spends the
 * sender's turn (`swap-session.js:1317` and the comment above it). A chat message that costs a turn
 * would be indistinguishable from the feature working, right up until UAT.
 *
 * WHAT EACH GROUP IS FOR
 *
 *   `sanitizeChat`  — a PURE function, tested with no session at all, because it is the whole of the
 *                     server-side length/shape control (R5/AC4). Testing it only through a booted
 *                     session would make the cheapest and most security-relevant assertions in this
 *                     file cost four minutes each.
 *   delivery        — AC1/AC2 over a real session: both logs gain the line, and the shared turn
 *                     counter does not move.
 *   the eval boundary — AC3. `sendFeedback` interpolates into an `eval` payload through
 *                     `JSON.stringify` (`headless-host.js:836`). That is correct today, but every
 *                     string that has ever crossed it was written by US. Chat is the first one an
 *                     untrusted keyboard authors, so the safety becomes a tested invariant rather
 *                     than an incidental property (memory: `Backtick in template literal`, and
 *                     `mp-eval-payload-integrity.spec.ts`, which guards our own SOURCE and cannot
 *                     see a runtime value at all).
 *   the filter tag  — AC6's server half. The client half (does the toggle stick?) is the risk F4
 *                     left open on purpose; it is asserted in the e2e, not here.
 *
 * EVERY ASSERTION HAS A CONTROL. A "the text arrived verbatim" test passes vacuously if the message
 * never arrived; a "capped at 200" test passes vacuously if nothing was logged. So each case that
 * asserts a shape also asserts the line is THERE, and the refusal cases assert the log did not grow.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Whole log entries, so a case can assert on `filter` as well as on `text`. */
const logEntries = (s: any, id: string): any[] => s.snapshotFor(id).messages.log || [];

/** The entries `id` gained since `before` — the delta is what a chat message is. */
const gained = (s: any, id: string, before: number): any[] => logEntries(s, id).slice(before);

describe('KDM-246 — sanitizeChat is the server-side control (R5, AC4)', () => {
	// A pure function: no session, no boot, milliseconds. This is deliberate — the KDTextField's
	// `MaxLength` attribute is a client COURTESY and a client can simply not send one, so the cap
	// that matters is this one and it must be cheap enough to test exhaustively.
	const san = (x: any) => SwapSession.sanitizeChat(x);

	it('caps at 200 characters', () => {
		const out = san('x'.repeat(500));
		expect(out.length, 'the cap is the server, not the input field').toBe(200);
		// CONTROL: something under the cap is not truncated, so the assertion above is about the cap
		// and not about the function returning a constant.
		expect(san('x'.repeat(199)).length).toBe(199);
	});

	it('collapses newlines, tabs and control characters to spaces', () => {
		// A log entry is ONE line: `KinkyDungeonSendTextMessage` has no notion of a break, so a
		// newline would either be swallowed by the renderer or break the layout, depending on the
		// glyph. Neither is a decision worth leaving to chance.
		expect(san('a\nb\tc\r\nd')).toBe('a b c d');
		expect(san('a b')).toBe('a b');
	});

	it('trims, and refuses anything empty afterwards', () => {
		expect(san('  hi  ')).toBe('hi');
		expect(san('   ')).toBe('');
		expect(san('\n\n')).toBe('');
		expect(san(''), 'empty is empty, not a space').toBe('');
	});

	it('coerces a non-string without throwing — a client can send anything', () => {
		expect(san(undefined)).toBe('');
		expect(san(null)).toBe('');
		expect(san(42)).toBe('42');
	});

	it('does NOT escape — the eval boundary owns that, and double-encoding would hide it', () => {
		// If this ever starts stripping backticks, AC3 below becomes vacuous: it would be asserting
		// that a sanitiser removed the hazard rather than that the eval boundary survives it.
		const nasty = 'a `b` ${c} "d" \\e';
		expect(san(nasty)).toBe(nasty);
	});
});

describe('KDM-246 — a message reaches the partner, off the turn boundary', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm246-chat-seed' });
		s.join('A');
		s.join('B');
		s.setPlayerName('A', 'Ana');
		s.setPlayerName('B', 'Bo');
	}, BOOT_TIMEOUT);

	it('AC1/AC2 — both players get the line, attributed, and no turn is spent', () => {
		const aBefore = logEntries(s, 'A').length;
		const bBefore = logEntries(s, 'B').length;
		const turnBefore = s.turn;

		const res = s.apply('A', { mp: 'chat.say', text: 'behind you' });

		// It is a ui-class action, so the bridge answers immediately and lockstep is untouched.
		expect(res.kind, 'chat must never enter lockstep (R2)').toBe('ui');
		expect(res.advanced).toBe(false);
		expect(res.changed, 'the bridge replies with a state frame, not a bare ack').toBe(true);
		expect(res.notify, 'the peer is pushed at once, as the peace offer is').toEqual(['B']);
		expect(s.turn, 'a chat message costs no turn (R2)').toBe(turnBefore);

		// AC1 — the partner sees it, under the SENDER's session name (R1).
		const bNew = gained(s, 'B', bBefore).map((m: any) => m.text);
		expect(bNew.length, 'CONTROL: the peer log actually grew').toBe(1);
		expect(bNew[0]).toContain('behind you');
		expect(bNew[0]).toContain('Ana');

		// AC2 — and so does the sender: the log IS the history, so it must hold their own words.
		const aNew = gained(s, 'A', aBefore).map((m: any) => m.text);
		expect(aNew.length, 'the sender own log is their history (AC2)').toBe(1);
		expect(aNew[0]).toBe(bNew[0]);
	}, BOOT_TIMEOUT);

	it('AC6 (server half) — the line is tagged `Chat`, and an ordinary line is not', () => {
		const before = logEntries(s, 'B').length;
		s.apply('A', { mp: 'chat.say', text: 'tagged' });
		const chat = gained(s, 'B', before);
		expect(chat.length).toBe(1);
		expect(chat[0].filter, 'the Chat filter is what makes AC6 possible at all').toBe('Chat');

		// SAME-SHAPE CONTROL: a gateway announcement travels the same `_broadcast` path and must
		// keep KD's default tag. Without this, `filter: 'Chat'` could be being written onto
		// everything and the toggle would hide the whole log.
		const b2 = logEntries(s, 'B').length;
		s._broadcast('the party arrives', '#88ccff');
		const announce = gained(s, 'B', b2);
		expect(announce.length, 'CONTROL: the announcement was logged').toBe(1);
		expect(announce[0].filter, 'only chat is tagged Chat').not.toBe('Chat');
	}, BOOT_TIMEOUT);

	it('AC3 — a hostile payload survives the eval boundary VERBATIM', () => {
		// Every character here has broken this codebase or a codebase like it. The backtick is the
		// one with a task number attached (KDM-184/218): inside `headless-host.js`'s template
		// literal it terminates the string, and the resulting SyntaxError blames the requiring file.
		const nasty = 'hi `tick` ${1+1} "q" \\slash </script>';
		const before = logEntries(s, 'B').length;

		expect(() => s.apply('A', { mp: 'chat.say', text: nasty })).not.toThrow();

		const got = gained(s, 'B', before);
		expect(got.length, 'CONTROL: it arrived at all — a swallowed message passes any verbatim test').toBe(1);
		// `${1+1}` must still read as itself and not as `2`; the backtick must still be a backtick.
		expect(got[0].text).toContain('`tick`');
		expect(got[0].text).toContain('${1+1}');
		expect(got[0].text).toContain('\\slash');
		expect(got[0].text).toContain('</script>');
		expect(got[0].text, 'no interpolation may have happened').not.toContain('hi 2');

		// And the world is still alive afterwards — a truncated payload can leave the vm usable but
		// the session incoherent, which a text assertion alone would not notice.
		expect(typeof s.world.getLevel()).toBe('number');
	}, BOOT_TIMEOUT);

	it('AC4 — an over-length message is capped ON THE WIRE, not merely in the input field', () => {
		const before = logEntries(s, 'B').length;
		s.apply('A', { mp: 'chat.say', text: 'z'.repeat(5000) });
		const got = gained(s, 'B', before);
		expect(got.length, 'CONTROL: it arrived').toBe(1);
		const zs = (got[0].text.match(/z/g) || []).length;
		expect(zs, 'the cap is enforced server-side (R5)').toBe(200);
	}, BOOT_TIMEOUT);

	it('an empty message is refused, and nothing is logged', () => {
		const aBefore = logEntries(s, 'A').length;
		const bBefore = logEntries(s, 'B').length;
		const res = s.apply('A', { mp: 'chat.say', text: '   ' });
		expect(res.error, 'a refusal says why').toBeTruthy();
		expect(res.changed).toBe(false);
		expect(logEntries(s, 'A').length, 'no blank line in the sender log').toBe(aBefore);
		expect(logEntries(s, 'B').length, 'and none in the peer log').toBe(bBefore);
	}, BOOT_TIMEOUT);

	it('an unknown mp action is still rejected — chat did not open a hole', () => {
		// The `mp:` branch is a dispatch table; a new entry must not turn its default into a no-op.
		const res = s.apply('A', { mp: 'chat.nope', text: 'x' });
		expect(res.error).toContain('unknown mp action');
	}, BOOT_TIMEOUT);

	it('chat is not gated — it works while the two are at war (no-gating decision)', () => {
		s.rel.declareWar('A', 'B');
		const before = logEntries(s, 'B').length;
		s.apply('A', { mp: 'chat.say', text: 'truce?' });
		expect(gained(s, 'B', before).length,
			'two people at two keyboards can always talk').toBe(1);
	}, BOOT_TIMEOUT);
});
