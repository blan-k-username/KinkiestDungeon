/**
 * Node-layer (Vitest) test for KD-090 — per-player message log.
 *
 * Bug (found in KD-089 UAT): both co-op clients saw an IDENTICAL chat log (the shared
 * world `KinkyDungeonMessageLog`), so each player saw the OTHER's action phrased as "You …".
 *
 * Fix (server-side only): SwapSession captures each player's message-log DELTA during their
 * swapped-in turn and `snapshotFor(client)` returns that client's OWN log. These tests prove
 * the two clients' logs diverge: a player's action grows ONLY their own log.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { bundleGiveMana } from './helpers/bundle';

const BOOT_TIMEOUT = 240_000;

const logTexts = (s: any, id: string): string[] =>
	(s.snapshotFor(id).messages.log || []).map((m: any) => (m && m.text) != null ? m.text : String(m));

describe('Per-player message log over the swap path (KD-090)', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'perplayer-log-seed' });
		s.join('A');
		s.join('B');
		for (const id of ['A', 'B']) bundleGiveMana(s.bundles.get(id));
		// A custom input that emits a unique personal message via the SAME world log path a
		// real spell uses (KinkyDungeonMessageLog push) — lets us assert log routing without
		// depending on (colliding, enemy-AI-randomized) real spell message text.
		s.world.eval(`KDInputTypes['__kdSay'] = function(d){
			KinkyDungeonSendTextMessage(10, String(d && d.text || ''), '#ffffff', 5);
			return '';
		};`);
	}, BOOT_TIMEOUT);

	/**
	 * KDM-165: this used to assert that a NON-second-person line emitted in A's turn reached B, while a
	 * "You …" line stayed private — a split only expressible by matching the message TEXT, in English.
	 * That rule is deleted: the swap window decides, so everything emitted in A's turn is A's.
	 *
	 * The bug this test was written for (KD-090: both clients saw one identical log) is unchanged and
	 * still asserted — the logs must diverge, and A's lines must not appear in B's log. Language
	 * independence is covered in `mp-log-attribution.spec.ts`.
	 */
	it('a player’s lines are private to them; the two logs diverge (KD-090)', () => {
		// Both start from the same shared intro log (seeded equally).
		const a0 = logTexts(s, 'A');
		const b0 = logTexts(s, 'B');
		expect(a0).toEqual(b0);

		// A logs a personal 2nd-person line AND a shared world line in one turn; B waits.
		s.submit('A', { kdType: '__kdSay', data: { text: 'You do A_PERSONAL_1' } });
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kdType: '__kdSay', data: { text: 'The world does A_SHARED_1' } });
		s.submit('B', { kind: 'wait' });

		const a1 = logTexts(s, 'A');
		const b1 = logTexts(s, 'B');

		// the logs diverge...
		expect(a1).not.toEqual(b1);
		// Both of A's lines are A's — the wording is irrelevant, the window decides.
		expect(a1.join('\n')).toContain('A_PERSONAL_1');
		expect(b1.join('\n')).not.toContain('A_PERSONAL_1');
		expect(a1.join('\n')).toContain('A_SHARED_1');
		expect(b1.join('\n'), 'a line emitted in A’s turn is A’s, however it is phrased')
			.not.toContain('A_SHARED_1');
	}, BOOT_TIMEOUT);

	it('symmetric: B’s "You …" line is private to B', () => {
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kdType: '__kdSay', data: { text: 'Your B_PERSONAL_1 happens' } });

		const a1 = logTexts(s, 'A').join('\n');
		const b1 = logTexts(s, 'B').join('\n');

		expect(b1).toContain('B_PERSONAL_1');
		expect(a1).not.toContain('B_PERSONAL_1');
	}, BOOT_TIMEOUT);

	it('a party-wide event (floor change) is duplicated into EVERY player’s log', () => {
		// Register a custom input that completes the floor: it bumps the shared level AND
		// emits a message — the swap session must broadcast that message to both players.
		// (Stands in for a real stairs-descend so we don't have to drive a full transition.)
		s.world.eval(`KDInputTypes['__kdFloorClear'] = function(d){
			MiniGameKinkyDungeonLevel = (MiniGameKinkyDungeonLevel || 0) + 1;
			KinkyDungeonSendTextMessage(10, 'FLOOR_CLEARED_MARKER', '#ffffff', 5);
			return '';
		};`);

		const a0 = logTexts(s, 'A');
		const b0 = logTexts(s, 'B');

		s.submit('A', { kdType: '__kdFloorClear', data: {} });
		s.submit('B', { kind: 'wait' });

		const a1 = logTexts(s, 'A');
		const b1 = logTexts(s, 'B');

		// KDM-165: the party-wide event still reaches everyone, but as an EXPLICIT session
		// announcement rather than by duplicating whatever game text the transition happened to emit.
		// Those game lines are the acting player's (they passed that player's vision check); "we are
		// all on floor N now" is session-level and is the proxy's to say.
		expect(a1.join('\n'), "the actor keeps the game's own line").toContain('FLOOR_CLEARED_MARKER');
		expect(b1.join('\n'), 'the peer is told the party changed floor').toMatch(/floor \d+/i);
		expect(a1.join('\n'), 'the actor is told too').toMatch(/floor \d+/i);
		// (sanity) it wasn't already there before the event.
		expect(a0).not.toContain('FLOOR_CLEARED_MARKER');
		expect(b0).not.toContain('FLOOR_CLEARED_MARKER');
	}, BOOT_TIMEOUT);
});
