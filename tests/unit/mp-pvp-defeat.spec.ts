/**
 * Node-layer (Vitest) tests for KD-099 — PvP defeat at Will 0.
 *
 * A player's Will is their defeat meter. PvP melee/bump drains it, but at 0 nothing happened —
 * the loser kept acting. This flags a Will≤0 player as `defeated`, broadcasts it to everyone, and
 * incapacitates them (their move/attack becomes a no-op). The defeated set rides the snapshot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('PvP defeat at Will 0 (KD-099)', () => {
	let s: any;
	beforeEach(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-defeat-seed', pvp: true });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	/** A bump-attacks B (drains B's Will); B waits. */
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1 } });
		sess.submit('B', { kind: 'wait' });
	}
	const willB = (sess: any) => sess.snapshotFor('B').stats.will;
	const logHas = (sess: any, id: string, re: RegExp) =>
		(sess.logs.get(id) || []).some((m: any) => m && re.test(m.text || ''));

	function defeatB(sess: any) {
		for (let i = 0; i < 20 && !sess.isDefeated('B'); i++) bumpB(sess);
	}

	it("draining B's Will to 0 flags them defeated and broadcasts it to everyone", () => {
		expect(s.isDefeated('B')).toBe(false);
		defeatB(s);
		expect(s.isDefeated('B')).toBe(true);
		expect(willB(s)).toBeLessThanOrEqual(0);
		expect(logHas(s, 'A', /defeated/i)).toBe(true);   // shared — both see it
		expect(logHas(s, 'B', /defeated/i)).toBe(true);
	}, BOOT_TIMEOUT);

	it('a defeated player is incapacitated — their move does nothing', () => {
		defeatB(s);
		expect(s.isDefeated('B')).toBe(true);
		const posBefore = s.posOf('B');
		s.submit('B', { kdType: 'move', data: { dir: { x: 1, y: 0 }, delta: 1 } });
		s.submit('A', { kind: 'wait' });
		expect(s.posOf('B')).toEqual(posBefore);   // did not move while down
	}, BOOT_TIMEOUT);

	it('the snapshot exposes the defeated player(s) for the HUD', () => {
		defeatB(s);
		const snap = s.snapshotFor('A');
		expect(Array.isArray(snap.defeatedPlayers)).toBe(true);
		expect(snap.defeatedPlayers).toContain('B');
	}, BOOT_TIMEOUT);
});
