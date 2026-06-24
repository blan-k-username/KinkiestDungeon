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

describe('Routed bind (Truss/Bondage spell) is WP-gated — bind only when subdued (KD-098)', () => {
	let s: any;
	beforeEach(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-bind-gate-seed', pvp: true });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	/** A casts the Bondage spell (the Truss option) at B's tile; B waits. Returns A's result. */
	function castBindAtB(sess: any) {
		const b = sess.posOf('B');
		sess.submit('A', { kdType: 'tryCastSpell', data: { tx: b.x, ty: b.y, spellname: 'Bondage' } });
		const r = sess.submit('B', { kind: 'wait' });
		return r.turn.applied.find((e: any) => e.id === 'A').result;
	}
	/** A bumps B (melee) to drain B's Will; B waits. */
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1 } });
		sess.submit('B', { kind: 'wait' });
	}
	const willFracB = (sess: any) => {
		const st = sess.snapshotFor('B').stats;
		return st.will / st.willMax;
	};

	it('at full WP the bind is REFUSED (not subdued) and applies no restraint', () => {
		expect(willFracB(s)).toBeGreaterThan(0.5);
		const r = castBindAtB(s);
		expect(r.applied).toBe(false);
		expect(r.reason).toBe('not-subdued');
		expect(s.snapshotFor('B').restraints.length).toBe(0);
	}, BOOT_TIMEOUT);

	it('once WP is worn low, the bind LANDS (restraint added to B)', () => {
		// drain B's Will under the threshold with bump-attacks
		for (let i = 0; i < 5 && willFracB(s) > 0.5; i++) bumpB(s);
		expect(willFracB(s)).toBeLessThanOrEqual(0.5);

		const r = castBindAtB(s);
		expect(r.applied).toBe(true);
		expect(r.after.restraints).toBe(r.before.restraints + 1);
		expect(s.snapshotFor('B').restraints.length).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
