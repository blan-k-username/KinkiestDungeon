/**
 * KDM-165 — message routing WITHOUT inspecting message text.
 *
 * `_isPersonalMessage` decided who saw a line by running `/^you\b|^your\b|^you'/i` over the rendered
 * text. Two defects:
 *
 *  1. **It is an invented rule** — the gateway interpreting game content to guess an audience.
 *  2. **It is English-only.** KD ships CN/DE/ES/JP/KR/RU. In any other language nothing matches, so
 *     EVERY line classifies as shared and the acting player's private second-person lines leak to the
 *     other player.
 *
 * The swap window already answers the question exactly: the log delta captured while player X is
 * swapped in IS X's, because that is what the engine means by emitting those lines at that moment.
 *
 * And it is not merely more principled — it is more correct. KD gates messages by VISION at the source
 * (`KinkyDungeonGame.ts:2602`: `if (entity && KinkyDungeonVisionGet(entity.x, entity.y) < 1) return false`),
 * so a line only reaches the log if the ACTING player can see its subject. Broadcasting it to the peer
 * showed them things they may not be able to see — the mirror image of the leak above.
 *
 * Genuinely session-level events (defeat, recovery) are broadcast EXPLICITLY by the proxy, which is a
 * concern it legitimately owns — see `_markDefeated` / `_markRecovered`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

const logTexts = (s: any, id: string): string[] =>
	(s.snapshotFor(id).messages.log || []).map((m: any) => (m && m.text) != null ? m.text : String(m));

describe('KDM-165 — log attribution comes from the swap window, not from the text', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm165-attribution' });
		s.join('A');
		s.join('B');
		s.world.eval(`KDInputTypes['__kdSay'] = function(d){
			KinkyDungeonSendTextMessage(10, String(d && d.text || ''), '#ffffff', 5);
			return '';
		};`);
	}, BOOT_TIMEOUT);

	function say(actor: string, text: string) {
		const other = actor === 'A' ? 'B' : 'A';
		s.submit(actor, { kdType: '__kdSay', data: { text } });
		s.submit(other, { kind: 'wait' });
	}

	/**
	 * The i18n bug, stated so it cannot be satisfied by a bigger regex: the SAME routing must hold for
	 * text in any script. These are second-person lines in the languages KD ships — none of which the
	 * English regex matches, so under the old rule every one of them leaked to the peer.
	 */
	it('AC2: a private line stays private in EVERY language KD ships', () => {
		const lines: Record<string, string> = {
			DE: 'Du wirst von den Fesseln gehalten KDM165_DE',
			ES: 'Estás atado por las cuerdas KDM165_ES',
			RU: 'Вы связаны верёвками KDM165_RU',
			CN: '你被绳索束缚 KDM165_CN',
			JP: 'あなたは縄で縛られている KDM165_JP',
			KR: '당신은 밧줄에 묶여 있습니다 KDM165_KR',
		};
		for (const [lang, text] of Object.entries(lines)) say('A', text);

		const aLog = logTexts(s, 'A').join('\n');
		const bLog = logTexts(s, 'B').join('\n');
		for (const lang of Object.keys(lines)) {
			expect(aLog, `${lang}: the acting player must receive their own line`).toContain(`KDM165_${lang}`);
			expect(bLog, `${lang}: a private line must NOT leak to the peer`).not.toContain(`KDM165_${lang}`);
		}
	}, BOOT_TIMEOUT);

	/**
	 * The rule must not depend on the shape of the text AT ALL — a line that does not start with "you"
	 * is routed exactly the same way, because the window is what decides.
	 */
	it('AC1: routing is identical whether or not the text looks second-person', () => {
		say('A', 'You do KDM165_SECONDPERSON');
		say('A', 'The world does KDM165_THIRDPERSON');

		const aLog = logTexts(s, 'A').join('\n');
		const bLog = logTexts(s, 'B').join('\n');
		expect(aLog).toContain('KDM165_SECONDPERSON');
		expect(aLog).toContain('KDM165_THIRDPERSON');
		expect(bLog, 'the peer sees neither — the window decides, not the wording')
			.not.toContain('KDM165_SECONDPERSON');
		expect(bLog, 'the peer sees neither — the window decides, not the wording')
			.not.toContain('KDM165_THIRDPERSON');
	}, BOOT_TIMEOUT);

	/** Attribution is symmetric — B's window is B's. */
	it('each player receives what was emitted in their OWN window', () => {
		say('B', 'KDM165_B_ONLY happens');
		expect(logTexts(s, 'B').join('\n')).toContain('KDM165_B_ONLY');
		expect(logTexts(s, 'A').join('\n')).not.toContain('KDM165_B_ONLY');
	}, BOOT_TIMEOUT);

	/** AC1, structurally: the text-inspecting helper is gone, not merely unused. */
	it('AC1: no text-content inspection remains in the message path', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src = require('fs').readFileSync(require.resolve('../../tools/mp-server/swap-session.js'), 'utf8');
		const code = src.split('\n').filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
		expect(code, 'the English regex heuristic must be deleted').not.toMatch(/_isPersonalMessage/);
		expect(code, 'no message text may be matched against a pattern').not.toMatch(/\^you\\b/i);
		expect(typeof s._isPersonalMessage, 'the helper must not exist at runtime either').toBe('undefined');
	}, BOOT_TIMEOUT);

	/** Session-level events stay broadcast — but EXPLICITLY, which the proxy legitimately owns. */
	it('a session-level event still reaches every player', () => {
		s._markDefeated('A', 'kdm165-test');
		const marker = logTexts(s, 'B').join('\n');
		expect(marker.length, "the peer is told about a session-level event").toBeGreaterThan(0);
		expect(s.snapshotFor('B').defeatedPlayers).toContain('A');
	}, BOOT_TIMEOUT);
});
