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

	const avatarDisabled = (sess: any, id: string) => {
		const eid = sess.avatars.get(id);
		return sess.world.eval(`(function(){ var e=KDMapData.Entities.find(function(x){return x.id===${eid};});
			return e ? !!(typeof KinkyDungeonIsDisabled==='function' && KinkyDungeonIsDisabled(e)) : null; })()`);
	};
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		sess.submit('B', { kind: 'wait' });
	}

	it("a HEALTHY peer's avatar is NOT disabled — can't be tied yet (real 'must be subdued' rule)", () => {
		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		expect(avatarDisabled(s, 'B')).toBe(false);
	}, BOOT_TIMEOUT);

	/**
	 * KDM-164: this used to assert that a peer at HALF Will is already bindable — an MP-only rule we
	 * invented (`will <= 0.5 * willMax`). The owner's directive is narrower and is the whole feature:
	 * *default behaviour unchanged, PLUS a 0-WP peer may be tied.* So the line is KD's own floor.
	 *
	 * Both halves are asserted, because "bindable at zero" is only meaningful if it is NOT bindable
	 * before that — otherwise the rule has quietly become "always bindable".
	 */
	it('a peer is bindable at KD\'s own floor (0 Will) — and not while still standing', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		expect(avatarDisabled(s, 'B'), 'a peer who is still up must not be bindable').toBe(false);

		for (let i = 0; i < 40 && s.vitalsFor('B').will > 0; i++) bumpB(s);
		expect(s.vitalsFor('B').will, 'wear the peer down to the floor').toBeLessThanOrEqual(0);

		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		expect(avatarDisabled(s, 'B'), 'at 0 WP the real bind gate must allow the tie').toBe(true);
	}, BOOT_TIMEOUT);
});
