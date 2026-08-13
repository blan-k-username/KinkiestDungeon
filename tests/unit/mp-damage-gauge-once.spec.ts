/**
 * Node-layer (Vitest): peer damage is charged ONCE, not every turn.
 *
 * UAT bug: a defeated player drank a Willpower potion ("You drink the willpower potion and feel
 * motivated"), Will went 0 → 2.50, and the same turn's reconcile knocked it straight back to 0.
 * The server log showed the giveaway — the IDENTICAL damage value re-applied on consecutive turns:
 *
 *     turn=4  reconcile A dmg=6.30 will 0.65 -> 0.00
 *     turn=5  reconcile A dmg=6.30 will 2.50 -> 0.00     (A had just drunk the potion)
 *
 * The peer avatar is a per-turn DAMAGE GAUGE (`ARM_HP - hp`), but it was only reset by
 * _armPeerEnemies when a PvP peer ACTED against it. If nobody attacked that turn the gauge kept its
 * old value, so reconcile charged the same hit again — forever. That pins a downed player at 0 Will
 * and eats any healing, which is why they could never recover.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Will as the server tracks it for the HP bar / defeat check. */
function willOf(s: any, id: string) {
	const v = s.vitalsOf.get(id) || {};
	return v.will;
}

/** Both players take a quiet turn (nobody attacks anybody). */
function quietTurn(s: any) {
	s.submit('A', { kind: 'wait' });
	s.submit('B', { kind: 'wait' });
}

describe('peer damage gauge is consumed once', () => {
	let s: any;
	beforeEach(() => {
		// PvP OFF on purpose: that is the live case. The gauge is only reset by _armPeerEnemies,
		// which skips non-PvP peers — but the avatar still takes damage from WORLD enemies (the rat),
		// so nothing ever clears it and reconcile re-charges the same hit every turn.
		s = new SwapSession({ requiredPlayers: 2, seed: 'gauge-seed' });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	it('does not re-charge the same hit on later turns', () => {
		// Simulate a landed hit: A's avatar gauge shows damage taken.
		const eid = s.avatars.get('A');
		s.world.setAvatarEnemy(eid, s._armHp - 3, s._armHp, 0);

		quietTurn(s);
		const afterHit = willOf(s, 'A');            // the hit is charged once

		quietTurn(s);
		expect(willOf(s, 'A')).toBe(afterHit);      // and NOT charged again

		quietTurn(s);
		expect(willOf(s, 'A')).toBe(afterHit);
	}, BOOT_TIMEOUT);

	it('healing sticks while nobody is attacking', () => {
		const eid = s.avatars.get('A');
		s.world.setAvatarEnemy(eid, s._armHp - 3, s._armHp, 0);
		quietTurn(s);

		// A "drinks a potion": Will restored on their own bundle.
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.setWill(5);
		s.bundles.set('A', s.world.capturePlayer());
		s.vitalsOf.set('A', s.world.getVitals());

		quietTurn(s);
		expect(willOf(s, 'A')).toBeGreaterThan(1);   // was: dragged straight back to 0
	}, BOOT_TIMEOUT);
});
