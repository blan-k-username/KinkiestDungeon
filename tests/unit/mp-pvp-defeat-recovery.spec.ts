/**
 * Node-layer (Vitest) tests for the "freed" half of KD-099 — recovering from defeat.
 *
 * REPRODUCTION (observed in UAT, 2 browsers): once a player's Will hits the floor they are
 * flagged `defeated` and every action they submit is rewritten to a wait
 * (`swap-session.js:142`). Nothing ever removes them from the set — the API comment says
 * "Sticky until freed (future work)" — so from the player's seat the game looks broken:
 * the move is submitted, the lockstep turn advances, and nothing happens, forever.
 *
 * A defeated player SHOULD be incapacitated while they are down, and able to act again once
 * their Will has recovered.
 *
 * Assertions read the dispatched `kdType` from the turn result rather than map geometry:
 * a suppressed action becomes `tick` (wait), a live one stays `move` (`_toInput`).
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'defeat-recovery-seed' });
	s.join('A');
	s.join('B');
	return s;
}

/** Set a player's real Will in the world and persist it into their bundle. */
function setWill(s: any, id: string, will: number) {
	s.world.restorePlayer(s.bundles.get(id));
	s.world.setWill(will);
	s.bundles.set(id, s.world.capturePlayer());
	s.vitalsOf.set(id, s.world.getVitals());
}

function willMaxOf(s: any, id: string) {
	const v = s.vitalsOf.get(id) || {};
	return (v.willMax != null && v.willMax > 0) ? v.willMax : 10;
}

/** Run one turn: `id` tries to move north, the other waits. Returns the applied entry for `id`. */
function moveTurn(s: any, id: string) {
	const other = s.players.find((p: string) => p !== id);
	s.submit(id, { kind: 'move', dx: 0, dy: -1 });
	const r = s.submit(other, { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === id);
}

describe('defeat recovery (KD-099 "freed")', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('while down: the player is flagged, but KEEPS vanilla agency — their move still dispatches', () => {
		setWill(s, 'A', 0);
		moveTurn(s, 'A');                       // the turn that latches it (reconcile runs after apply)

		expect(s.isDefeated('A')).toBe(true);   // flagged (drives bindability + the HUD marker)
		// KD has no "Will = 0 ⇒ you cannot act" rule: KinkyDungeonMove has no Will check and
		// KDPlayerCanMove is terrain-only. What limits a downed player is the bondage the peer
		// then applies — enforced by the real pipeline, not by us.
		expect(moveTurn(s, 'A').kdType).toBe('move');
		expect(s.isDefeated('B')).toBe(false);          // the healthy peer is unaffected
	}, BOOT_TIMEOUT);

	it('while down: the player can still be tied by a peer (the one co-op-specific addition)', () => {
		s.setPvP(true);
		setWill(s, 'A', 0);
		moveTurn(s, 'A');
		expect(s.isDefeated('A')).toBe(true);

		// Low Will arms A's avatar as stunned so the game's own KDCanApplyBondage gate passes.
		expect(s.snapshotFor('B').defeatedPlayers).toContain('A');
		s.submit('B', { kind: 'pvpBind', target: 'A', restraint: 'DuctTapeFeet' });
		const r = s.submit('A', { kind: 'wait' });
		const bind = r.turn.applied.find((e: any) => e.id === 'B').result;
		expect(bind.applied).toBe(true);
	}, BOOT_TIMEOUT);

	it('after recovery: Will back up clears the flag and the player can act again', () => {
		setWill(s, 'A', 0);
		moveTurn(s, 'A');
		expect(s.isDefeated('A')).toBe(true);

		setWill(s, 'A', willMaxOf(s, 'A'));     // Will regenerated
		moveTurn(s, 'A');                       // the turn that should clear it

		expect(s.isDefeated('A')).toBe(false);
		expect(moveTurn(s, 'A').kdType).toBe('move');
	}, BOOT_TIMEOUT);

	it('after recovery: the client snapshot stops listing the player as defeated', () => {
		setWill(s, 'A', 0);
		moveTurn(s, 'A');
		expect(s.snapshotFor('B').defeatedPlayers).toContain('A');

		setWill(s, 'A', willMaxOf(s, 'A'));
		moveTurn(s, 'A');

		expect(s.snapshotFor('B').defeatedPlayers).not.toContain('A');
	}, BOOT_TIMEOUT);

	it('does not flap: a sliver of Will above the floor is still down (still bindable)', () => {
		setWill(s, 'A', 0);
		moveTurn(s, 'A');

		setWill(s, 'A', 0.6);                   // above the 0.52 defeat line, nowhere near recovered
		moveTurn(s, 'A');

		expect(s.isDefeated('A')).toBe(true);
		expect(s.snapshotFor('B').defeatedPlayers).toContain('A');
	}, BOOT_TIMEOUT);
});
