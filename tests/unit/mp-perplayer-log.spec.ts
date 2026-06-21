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

const BOOT_TIMEOUT = 240_000;

const logTexts = (s: any, id: string): string[] =>
	(s.snapshotFor(id).messages.log || []).map((m: any) => (m && m.text) != null ? m.text : String(m));

describe('Per-player message log over the swap path (KD-090)', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'perplayer-log-seed' });
		s.join('A');
		s.join('B');
		for (const id of ['A', 'B']) {
			s.bundles.get(id).stats.mana = 100;
			s.bundles.get(id).stats.manaMax = 100;
		}
		// A custom input that emits a unique personal message via the SAME world log path a
		// real spell uses (KinkyDungeonMessageLog push) — lets us assert log routing without
		// depending on (colliding, enemy-AI-randomized) real spell message text.
		s.world.eval(`KDInputTypes['__kdSay'] = function(d){
			KinkyDungeonSendTextMessage(10, String(d && d.text || ''), '#ffffff', 5);
			return '';
		};`);
	}, BOOT_TIMEOUT);

	it('a player’s PERSONAL ("You …") line is private; SHARED lines reach both (KD-097)', () => {
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
		// A's personal "You …" line is private to A...
		expect(a1.join('\n')).toContain('A_PERSONAL_1');
		expect(b1.join('\n')).not.toContain('A_PERSONAL_1');
		// ...but the shared (non-2nd-person) line reaches BOTH (fixes "P1 empty log").
		expect(a1.join('\n')).toContain('A_SHARED_1');
		expect(b1.join('\n')).toContain('A_SHARED_1');
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

		// The shared floor-clear line is in BOTH logs even though only A triggered it.
		expect(a1).toContain('FLOOR_CLEARED_MARKER');
		expect(b1).toContain('FLOOR_CLEARED_MARKER');
		// (sanity) it wasn't already there before the event.
		expect(a0).not.toContain('FLOOR_CLEARED_MARKER');
		expect(b0).not.toContain('FLOOR_CLEARED_MARKER');
	}, BOOT_TIMEOUT);
});
