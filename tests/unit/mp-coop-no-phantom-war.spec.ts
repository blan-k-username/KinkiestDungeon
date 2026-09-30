/**
 * KDM-311 — plain co-op must not declare war between the players on turn 1, with nobody attacking.
 *
 * Found while diagnosing KDM-310: the server log read `WAR A <-> B (KD aggro on the avatar:
 * hostile=9997)` after one ordinary move. The war detector (`_reconcilePeers`, KDM-225) reads KD's own
 * aggro on an avatar — `hostile`/`rage` — as "an attack happened". But the same function restores each
 * avatar's hp every turn through `setAvatarEnemy`, which ALSO stamps `hostile = 9999`; the next turn the
 * detector read our own stamp (counted down to 9997) as an attack. So every co-op session went to war.
 *
 * CONTROL: KD's real aggro (`KDMakeHostile`, what an attack or the sneak option writes) still starts a
 * war — the detector is not simply switched off.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function coop(seed: string) {
	const s = new SwapSession({ requiredPlayers: 2, seed, pvp: false });
	s.join('A');
	s.join('B');
	return s;
}

describe('KDM-311 — no phantom war in plain co-op', () => {
	it('players who only wait and move stay at peace', () => {
		const s = coop('kdm311-quiet');
		expect(s.started, 'precondition: the session started').toBe(true);
		expect(s.rel.atWar('A', 'B'), 'precondition: co-op starts at peace').toBe(false);
		for (let i = 0; i < 5; i++) {
			s.submit('A', { kind: 'wait' });
			const r = s.submit('B', { kind: 'wait' });
			expect(r.advanced, 'precondition: each turn resolved').toBe(true);
		}
		expect(s.rel.atWar('A', 'B'), 'nobody attacked').toBe(false);
	}, BOOT_TIMEOUT);

	it('CONTROL — KD\'s own aggro on an avatar still declares war', () => {
		const s = coop('kdm311-aggro');
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(s.rel.atWar('A', 'B'), 'precondition: at peace before the aggro').toBe(false);
		s.world.setAvatarHostile(s.avatars.get('B'), true);   // KDMakeHostile — the game's aggro write
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(s.rel.atWar('A', 'B'), 'real aggro is an attack').toBe(true);
	}, BOOT_TIMEOUT);
});
