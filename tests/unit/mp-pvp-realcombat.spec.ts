/**
 * Node-layer (Vitest) tests for KD-100 — PvP through the REAL combat pipeline.
 *
 * The peer is armed as a real hostile Enemy (hp = their Will); the attacker's stock `move`/attack runs
 * the game's REAL `KinkyDungeonMove`→`KDDoAttack`→`KDDamageEnemy` against it (real damage roll, real
 * combat text, real defeat), and the result is reconciled back into the victim's bundle. No synthetic
 * `_applyPvP`/feedback in the gameplay path. `await session.ready()` loads the text so combat messages
 * resolve to real text instead of "[NotFound] …".
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('PvP via the REAL combat pipeline (KD-100)', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'realcombat-seed', pvp: true });
		s.join('A');
		s.join('B');
		await s.ready();   // load real combat text (textProvider.readyAll)
	}, BOOT_TIMEOUT);

	/** A walks into B's avatar — a real bump-attack through KD's own pipeline; B waits. */
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		sess.submit('B', { kind: 'wait' });
	}
	const willB = (sess: any) => sess.snapshotFor('B').stats.will;
	const aLog = (sess: any) => (sess.logs.get('A') || []).map((m: any) => (m && m.text) || '').join('\n');

	it("a real bump-attack drops the victim's Will via the game's own damage", () => {
		const before = willB(s);
		bumpB(s);
		const after = willB(s);
		expect(after).toBeLessThan(before);            // real damage landed
		expect(before - after).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it("combat uses the game's REAL messages (not synthetic, not [NotFound])", () => {
		bumpB(s);
		const log = aLog(s);
		expect(log).toMatch(/attack/i);                // a real KDAttack-style line
		expect(log).not.toMatch(/\[NotFound\]/);       // text actually loaded
		expect(log).not.toMatch(/for 1\.5 arcane/);    // NOT the old synthetic constant
		expect(log).toMatch(/Player B/);               // names the real peer, not the generic "Rival"
		expect(log).not.toMatch(/Rival/);
	}, BOOT_TIMEOUT);

	it('draining Will to the floor defeats the peer (real player-defeat condition)', () => {
		expect(s.isDefeated('B')).toBe(false);
		for (let i = 0; i < 25 && !s.isDefeated('B'); i++) bumpB(s);
		expect(s.isDefeated('B')).toBe(true);
		expect(willB(s)).toBeLessThanOrEqual(0.52);
		// the defeat rides the snapshot for the HUD
		expect(s.snapshotFor('A').defeatedPlayers).toContain('B');
	}, BOOT_TIMEOUT);

	it('a defeated peer is incapacitated (cannot act)', () => {
		for (let i = 0; i < 25 && !s.isDefeated('B'); i++) bumpB(s);
		expect(s.isDefeated('B')).toBe(true);
		const pos = s.posOf('B');
		s.submit('B', { kdType: 'move', data: { dir: { x: 1, y: 0 }, delta: 1 } });
		s.submit('A', { kind: 'wait' });
		expect(s.posOf('B')).toEqual(pos);             // down — no move
	}, BOOT_TIMEOUT);
});
