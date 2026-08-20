/**
 * KDM-224 — a peer avatar is KNOCKED DOWN, never DELETED.
 *
 * Two PvP specs failed intermittently with a null where a peer position/entity should be
 * (`mp-pvp-realcombat` "a defeated peer keeps agency", `mp-pvp-bind-reconcile` "bindable once WORN
 * DOWN"). Both nulls are one fault: the avatar entity is gone from `KDMapData.Entities`.
 *
 * The mechanism, in the game's own code:
 *   `_armPeerEnemies` mirrors the peer's Will onto the avatar as hp —
 *   `hp = Math.max(0.01, frac * full)` (swap-session.js) — so a peer worn to a sliver is armed AT
 *   the 0.01 floor. The actor's real attack then runs `KinkyDungeonDamageEnemy`, which takes hp
 *   straight through zero (KinkyDungeonFight.ts:1451 `if (Enemy.hp <= 0) KinkyDungeonKilledEnemy = …`;
 *   the game's own "knocked down instead of killed" branch at :1370 needs bound>3 / in-party /
 *   `Damage.nokill`, none of which an avatar has). The enemy loop then reaches
 *   `KinkyDungeonEnemyCheckHP` (KinkyDungeonEnemies.ts:3340, `if (enemy.hp <= 0 …)`) and
 *   `KDRemoveEntity`s it — permanently, mid-turn.
 *
 * In a live run that band is narrow (the avatar is only fragile when the peer's Will is a sliver
 * above zero at TURN START), which is why it read as a rare flake and why five reproduction attempts
 * driven through real bumps came back negative. Armed hp is the deciding input, so this test sets
 * that input directly instead of gambling on damage rolls landing in the band.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('KDM-224 — a peer avatar survives being worn down (down ≠ deleted)', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'avatar-lifetime-seed', pvp: true });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	/** A walks into B's avatar — a real bump-attack through KD's own pipeline; B waits. */
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		sess.submit('B', { kind: 'wait' });
	}

	/** Put B's Will where the flake finds it: a sliver above zero, so arming hits the 0.01 hp floor. */
	function wearBToASliver(sess: any) {
		const v = sess.vitalsFor('B');
		sess.vitalsOf.set('B', { ...v, will: 0.02 });
	}

	it('an avatar armed at the hp floor is not removed from the map by the next real hit', () => {
		wearBToASliver(s);
		const before = s.posOf('B');
		expect(before, 'precondition: the avatar is on the map before the hit').not.toBeNull();

		bumpB(s);

		expect(s.posOf('B'),
			"the worn-down peer's avatar was DELETED from the map by the hit that put it down — " +
			'a peer avatar must be knocked down, never killed').not.toBeNull();
	}, BOOT_TIMEOUT);

	it('…and it keeps taking hits afterwards without vanishing', () => {
		wearBToASliver(s);
		for (let i = 0; i < 5; i++) {
			bumpB(s);
			expect(s.posOf('B'), `avatar vanished on hit ${i + 1} while at the hp floor`).not.toBeNull();
			wearBToASliver(s);   // hold it at the sliver: every hit lands on a floored avatar
		}
	}, BOOT_TIMEOUT);

	it('a worn-down peer still appears in the other player’s snapshot map', () => {
		wearBToASliver(s);
		bumpB(s);
		const ents = (s.snapshotFor('A').map || {}).Entities || [];
		expect(ents.some((e: any) => e.id === s.avatars.get('B')),
			"B's avatar is missing from A's snapshot — the bind gate cannot even be evaluated").toBe(true);
	}, BOOT_TIMEOUT);
});
