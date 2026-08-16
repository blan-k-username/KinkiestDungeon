/**
 * KD-093 / KD-073 §B — a bind STICKS across swaps.
 *
 * This file used to drive `{kind:'pvpBind'}`, the synthetic PvP primitive that wrote a restraint onto
 * the target's bundle outside the game. KDM-164 deleted that primitive — there is one combat model now
 * — so the bind here is applied through KD's own player path (`KinkyDungeonAddRestraint`, with the
 * victim swapped in), which is exactly what `_reconcilePeers` uses in real play.
 *
 * What this file uniquely covers, and why it is not redundant with `mp-pvp-bind-reconcile.spec.ts`
 * (which covers the real tie GATE — who may be tied and when): **persistence**. A restraint is worn
 * state, and the derived consequences of wearing it (slow level) are NOT carried in the bundle — they
 * self-heal from the captured inventory on the victim's next turn. That is the KD-073 §B finding, and
 * a swap model can silently lose it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { bundleStats } from './helpers/bundle';

const BOOT_TIMEOUT = 240_000;
// DuctTapeFeet has blockfeet:true ⇒ KinkyDungeonCalculateSlowLevel returns >0 once worn.
const BIND = 'DuctTapeFeet';

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-bind-seed', pvp: true });
	s.join('A');
	s.join('B');
	return s;
}

/** Tie B through the game's REAL player path — the same call `_reconcilePeers` makes. */
function bindB(s: any) {
	s.world.restorePlayer(s.bundles.get('B'));
	const r = s.world.addRestraint(BIND);
	s.bundles.set('B', s.world.capturePlayer());
	s.vitalsOf.set('B', s.world.getVitals());
	return r;
}

describe('PvP binding persists across swaps (KD-093 / KD-073 §B)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('the restraint lands on the victim and not on the attacker', () => {
		const aBefore = bundleStats(s.bundles.get('A'));
		const before = s.vitalsFor('B').restraints;
		const r = bindB(s);
		expect(r && r.count, 'the real KinkyDungeonAddRestraint applied it').toBeGreaterThan(0);
		expect(s.vitalsFor('B').restraints, 'the victim gained a worn restraint').toBeGreaterThan(before);
		expect(bundleStats(s.bundles.get('A')), 'the attacker is untouched').toBe(aBefore);
	}, BOOT_TIMEOUT);

	it("the victim's slow level self-heals from the restraint after their next turn", () => {
		bindB(s);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });          // B's turn runs UpdateStats → CalculateSlowLevel
		s.world.restorePlayer(s.bundles.get('B'));
		expect(s.world.playerSlowLevel(), 'a worn bind still slows the victim after the swap')
			.toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
