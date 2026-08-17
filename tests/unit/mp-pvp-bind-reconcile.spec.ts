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
		expect(s.snapshotFor('B').restraints.length).toBe(before);
	}, BOOT_TIMEOUT);

	/**
	 * KD's OWN gate, evaluated on the SNAPSHOT entity — the object the browser holds and where the tie
	 * submenu actually runs. Asserting against the SERVER world object made three earlier fixes look
	 * correct while changing nothing in play.
	 */
	const bindGateOpen = (sess: any, id: string) => {
		const actor = (id === "B") ? "A" : "B";
		sess.world.restorePlayer(sess.bundles.get(actor));
		sess._armPeerEnemies(actor);
		const snap = sess.snapshotFor(actor);
		const ent = ((snap.map && snap.map.Entities) || []).find((e: any) => e.id === sess.avatars.get(id));
		if (!ent) return null;
		return sess.world.eval("(function(){ var e = " + JSON.stringify(ent) + ";"
			+ " return !!((typeof KDCanApplyBondage === 'function' && typeof KDPlayer === 'function')"
			+ "   && KDCanApplyBondage(e, KDPlayer())); })()");
	};
	/** A walks into B avatar — a real bump-attack through KD own pipeline; B waits. */
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		sess.submit('B', { kind: 'wait' });
	}

	it("a HEALTHY peer's avatar is NOT disabled — can't be tied yet (real 'must be subdued' rule)", () => {
		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		expect(bindGateOpen(s, 'B')).toBe(false);
	}, BOOT_TIMEOUT);

	/**
	/**
	 * KDM-164 removed a "half Will" rule we invented; KDM-199 removed its successor (0 Will => stun the
	 * avatar). Neither was KD's. The avatar is now armed FROM the peer — hp from Will, stun from their
	 * own engine countdown, bondage mirrored via specialBoundLevel — so KD's own KDCanApplyBondage
	 * decides, and it needs boundLevel > 0 (KDBoundEffects short-circuits at KinkyDungeonEnemies.ts:4228).
	 *
	 * Both halves asserted, or the rule quietly becomes "always" / "never" bindable.
	 */
	it('a peer is bindable once WORN DOWN — and not while still standing', () => {
		expect(bindGateOpen(s, 'B'), 'a healthy peer must not be bindable').toBe(false);

		for (let i = 0; i < 40 && s.vitalsFor('B').will > 0; i++) bumpB(s);
		expect(s.vitalsFor('B').will, 'precondition: the peer really was worn down').toBeLessThanOrEqual(0);
		expect(bindGateOpen(s, 'B'), 'KDM-200: a worn-down (defeated) opponent IS tie-able').toBe(true);

		s.world.restorePlayer(s.bundles.get('B'));
		const added = s.world.addRestraint('HingedCuffs');
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', s.world.getVitals());
		expect(added && added.count, 'precondition: B must really be wearing a restraint').toBeGreaterThan(0);

		expect(bindGateOpen(s, 'B'), 'worn down AND bound: KD own gate allows the tie').toBe(true);
	}, BOOT_TIMEOUT);
});
