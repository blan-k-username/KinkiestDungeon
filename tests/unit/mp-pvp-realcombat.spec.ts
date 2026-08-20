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
	const willB = (sess: any) => sess.vitalsFor('B').will;
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

	// KDM-154: this used to assert "a defeated peer cannot act" — a rule WE invented. KD has no
	// Will-based action gate (KinkyDungeonMove has no Will check; KDPlayerCanMove is terrain-only),
	// so a downed player keeps full agency and it is the bondage a peer then applies — enforced by
	// the real pipeline — that limits them. The flag now only marks them bindable + down on the HUD.
	it('a defeated peer keeps agency (down ≠ frozen)', () => {
		for (let i = 0; i < 25 && !s.isDefeated('B'); i++) bumpB(s);
		expect(s.isDefeated('B')).toBe(true);
		const pos = s.posOf('B');
		/*
		 * KDM-224: assert the avatar EXISTS before asserting it moved.
		 *
		 * `posOf` returns null when the avatar entity is not in the map (swap-session.js:1021-1024),
		 * so without this the final assertion compares null against null — a peer avatar that VANISHED
		 * and one that merely stood still produce the identical failure, and the message
		 * ("expected null to not deeply equal null") names neither. Worse in the other direction: a
		 * non-null before-value and a null after-value would PASS, reporting a disappeared avatar as
		 * proof of agency. Observed as an intermittent red; this is what makes the next one legible.
		 */
		expect(pos, 'the defeated peer avatar is GONE from the map before it even tried to move — ' +
			'down must not mean deleted').not.toBeNull();
		s.submit('B', { kdType: 'move', data: { dir: { x: 1, y: 0 }, delta: 1 } });
		s.submit('A', { kind: 'wait' });
		const after = s.posOf('B');
		expect(after, 'the defeated peer avatar VANISHED from the map during its own move')
			.not.toBeNull();
		expect(after).not.toEqual(pos);                // down, but still moves under their own power
	}, BOOT_TIMEOUT);
});
