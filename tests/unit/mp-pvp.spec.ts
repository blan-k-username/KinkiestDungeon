/**
 * Node-layer (Vitest) tests for KD-092 (KD-073a) — PvP core: A damages B.
 *
 * Swap-model PvP (KD-073 Architecture, Strategy B): a player's authoritative damage can only
 * be applied via the global-player path, so B must be SWAPPED IN to receive it. Per A→B:
 * compute A's weapon attack while A is swapped in → swap B's bundle in → apply via the
 * player path (KinkyDungeonDealDamage) → capture B; A's own bundle is untouched.
 *
 * Gated by a per-session PvP toggle (OFF by default = co-op) and world adjacency.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-seed' });
	s.join('A');
	s.join('B');
	return s;
}

/** A attacks B this turn (B waits) and returns A's resolved PvP result. */
function pvpTurn(s: any) {
	s.submit('A', { kind: 'pvpAttack', target: 'B' });
	const r = s.submit('B', { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === 'A').result;
}

describe('PvP core — A damages B (KD-092)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('R1: with PvP OFF (co-op default), an A→B attack is a no-op', () => {
		expect(s.pvp).toBe(false); // default off
		const pvp = pvpTurn(s);
		expect(pvp.applied).toBe(false);
		expect(pvp.reason).toBe('pvp-off');
	}, BOOT_TIMEOUT);

	it('R2/R3: with PvP ON and adjacent, A reduces B’s stats; A is unaffected', () => {
		s.setPvP(true);
		// Players spawn adjacent (A at base.x, B avatar at base.x+1).
		const aStatsBefore = JSON.stringify(s.bundles.get('A').stats);
		const pvp = pvpTurn(s);

		expect(pvp.applied).toBe(true);
		// the hit changed B's authoritative vitals (measured at apply time, not B's own wait)
		expect(JSON.stringify(pvp.after)).not.toBe(JSON.stringify(pvp.before));
		// A's own stats are untouched by attacking (independent bundles)
		expect(JSON.stringify(s.bundles.get('A').stats)).toBe(aStatsBefore);
	}, BOOT_TIMEOUT);

	it('R4: with PvP ON but B out of range, the attack is rejected', () => {
		s.setPvP(true);
		// Move B far in both the bundle (authoritative pos) and the avatar so it is
		// out-of-range regardless of random turn order.
		const bp = s.bundles.get('B').player;
		bp.x = bp.x + 6;
		s.world.moveAvatar(s.avatars.get('B'), bp.x, bp.y);

		const pvp = pvpTurn(s);
		expect(pvp.applied).toBe(false);
		expect(pvp.reason).toBe('out-of-range');
	}, BOOT_TIMEOUT);
});
