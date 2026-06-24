/**
 * Node-layer (Vitest) tests for KD-101 — the server half of real "tie": a restraint tied onto a
 * peer's AVATAR (the real addNPCRestraint apply, replayed server-side) is reconciled onto the
 * VICTIM's real player bundle via the game's real KinkyDungeonAddRestraint.
 *
 * The full flow's front end (right-click "Attempt to Tie" → the real tie submenu → addNPCRestraint)
 * is browser UI and is verified live; here we cover the server reconcile glue deterministically by
 * tying a restraint onto the avatar directly (what the routed addNPCRestraint does) and checking the
 * victim ends up wearing it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const BIND = 'DuctTapeFeet';

describe('PvP real tie — avatar restraint reconciles to the victim (KD-101)', () => {
	let s: any;
	beforeEach(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-bind-reconcile-seed', pvp: true });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	it('a restraint on B’s avatar this turn ends up worn on B’s real bundle', () => {
		const bEid = s.avatars.get('B');
		const before = s.snapshotFor('B').restraints.length;

		// Arm peers (A acting), then simulate the attacker's real addNPCRestraint applying a restraint
		// to B's avatar this turn (the routed submenu apply does exactly this server-side).
		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		s.world.eval(`KDSetNPCRestraints(${bEid}, { sgrp: { name: ${JSON.stringify(BIND)} } })`);

		// reconcile (runs at the end of every real turn)
		s._reconcilePeers();

		const after = s.snapshotFor('B').restraints.length;
		expect(after).toBeGreaterThan(before);
		expect(s.snapshotFor('B').restraints.some((r: any) => r.name === BIND)).toBe(true);
	}, BOOT_TIMEOUT);

	it('no tie this turn → no new restraint (the gauge is cleared on arm)', () => {
		const before = s.snapshotFor('B').restraints.length;
		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');     // clears the avatar bondage gauge
		s._reconcilePeers();
		expect(s.snapshotFor('B').restraints.length).toBe(before);
	}, BOOT_TIMEOUT);
});
