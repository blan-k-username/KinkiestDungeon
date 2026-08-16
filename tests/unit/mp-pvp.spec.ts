/**
 * KD-092 PvP policy, re-expressed on the REAL pipeline (KDM-164).
 *
 * This file used to drive `{kind:'pvpAttack'}` — a synthetic primitive that computed its own attack
 * and wrote the result onto the target's bundle, bypassing the game. That primitive is deleted: it was
 * a second, parallel combat model kept alive for tests, and the whole point of KDM-164 is that there is
 * exactly ONE combat model, KD's.
 *
 * What survives, because nothing else covers it and it is legitimately server-side (the task's own
 * "Out of scope" keeps session policy on the server): the **PvP toggle**. Whether A can hurt B at all
 * is a session decision; how much it hurts is the game's.
 *
 * Damage numbers, messages and defeat are covered by `mp-pvp-realcombat.spec.ts`; ties by
 * `mp-pvp-bind-reconcile.spec.ts`; the real player-damage pipeline by `mp-real-damage-pipeline.spec.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-seed' });
	s.join('A');
	s.join('B');
	// A acts first, so B's avatar is still where we put it when A swings. Under random order the
	// peer's own turn re-syncs its avatar back and silently undoes the setup.
	s._shuffle = () => ['A', 'B'];
	return s;
}

/** A really walks into B's avatar — KD's own bump-attack. */
function realAttack(s: any) {
	const a = s.posOf('A');
	s.world.moveAvatar(s.avatars.get('B'), a.x, a.y + 1);
	s.submit('A', { kdType: 'move', data: { dir: { x: 0, y: 1 }, delta: 1, AllowInteract: true } });
	s.submit('B', { kind: 'wait' });
}

describe('PvP policy on the real pipeline (KD-092 / KDM-164)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('R1: with PvP OFF (co-op default), walking into a partner does not hurt them', () => {
		expect(s.pvp).toBe(false);                       // default off
		const before = s.vitalsFor('B').will;
		realAttack(s);
		expect(s.vitalsFor('B').will, 'a partner must not be damaged while PvP is off').toBe(before);
	}, BOOT_TIMEOUT);

	it('R2/R3: with PvP ON, the real attack costs B Will and leaves A untouched', () => {
		s.setPvP(true);
		const bBefore = s.vitalsFor('B').will;
		const aBefore = s.vitalsFor('A').will;
		realAttack(s);
		expect(s.vitalsFor('B').will, "the victim takes the game's own damage").toBeLessThan(bBefore);
		expect(s.vitalsFor('A').will, 'attacking must not damage the attacker').toBe(aBefore);
	}, BOOT_TIMEOUT);

	it('R4: with PvP ON but the peer out of reach, nothing happens', () => {
		s.setPvP(true);
		const a = s.posOf('A');
		s.world.moveAvatar(s.avatars.get('B'), a.x + 6, a.y + 6);
		const before = s.vitalsFor('B').will;
		s.submit('A', { kdType: 'move', data: { dir: { x: 0, y: 1 }, delta: 1, AllowInteract: true } });
		s.submit('B', { kind: 'wait' });
		expect(s.vitalsFor('B').will, 'an attack cannot reach a peer six tiles away').toBe(before);
	}, BOOT_TIMEOUT);
});
