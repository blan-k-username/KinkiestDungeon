/**
 * Node-layer (Vitest) tests for KD-093 (KD-073b) — PvP binding + persistence.
 *
 * A applies a restraint to B via the swap path (route to B's bundle through the player-path
 * KinkyDungeonAddRestraint). Proves the KD-073 §B finding: the restraint lands in B's bundle
 * AND B's restraint-DERIVED slow level self-heals from the captured inventory on B's next turn
 * (KinkyDungeonUpdateStats → CalculateSlowLevel), so the bind sticks across swaps.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
// DuctTapeFeet has blockfeet:true ⇒ KinkyDungeonCalculateSlowLevel returns >0 once worn.
const BIND = 'DuctTapeFeet';

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-bind-seed' });
	s.join('A');
	s.join('B');
	return s;
}

function bindTurn(s: any) {
	s.submit('A', { kind: 'pvpBind', target: 'B', restraint: BIND });
	const r = s.submit('B', { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === 'A').result;
}

describe('PvP binding — A binds B (KD-093)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('R1: with PvP OFF, an A→B bind is a no-op', () => {
		const pvp = bindTurn(s);
		expect(pvp.applied).toBe(false);
		expect(pvp.reason).toBe('pvp-off');
	}, BOOT_TIMEOUT);

	it('R2/R3: with PvP ON + adjacent, A binds B (B gains a restraint); A unaffected', () => {
		s.setPvP(true);
		const aStatsBefore = JSON.stringify(s.bundles.get('A').stats);
		const pvp = bindTurn(s);

		expect(pvp.applied).toBe(true);
		// B gained a worn restraint
		expect(pvp.after.restraints).toBe(pvp.before.restraints + 1);
		// A is unchanged by binding B
		expect(JSON.stringify(s.bundles.get('A').stats)).toBe(aStatsBefore);
	}, BOOT_TIMEOUT);

	it('persistence: B’s slow level self-heals from the restraint after B’s next turn', () => {
		s.setPvP(true);
		bindTurn(s);                 // A binds B; B took a wait turn (UpdateStats ran)
		// Restore B and re-derive slow level from B's captured restraints — the bind sticks.
		s.world.restorePlayer(s.bundles.get('B'));
		expect(s.world.playerSlowLevel()).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
