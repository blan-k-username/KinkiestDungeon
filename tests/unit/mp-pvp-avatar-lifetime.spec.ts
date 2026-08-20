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

	/**
	 * THE HOLE THE FIRST FIX LEFT (UAT, 2026-08-20).
	 *
	 * KDM-224 floored the avatar's hp inside a wrapper around `KinkyDungeonDamageEnemy`. That is ONE
	 * of the paths that writes enemy hp: the game has ~30 others that assign `enemy.hp` directly —
	 * damage-over-time ticks (`KinkyDungeonEvents.ts:11225/11237/11249`), spells
	 * (`KinkyDungeonMagicCode.ts:95/785/839`), dialogue outcomes, prison code. None of them is a
	 * `KinkyDungeonDamageEnemy` call, so none of them was floored, and the avatar could still reach
	 * `hp <= 0` and be deleted mid-turn.
	 *
	 * MEASURED IN A LIVE SESSION: `[mp] arm A hp=0.01/10` at turn 54. The `/10` is the giveaway —
	 * `_armPeerEnemies` falls back to `full = 10` only when `getEntityCombat` returns null, i.e. the
	 * avatar was ALREADY gone from `KDMapData.Entities`. Player A had vanished from B's screen, and
	 * B's log carried the kill line for it: `[NotFound] KillRemotePlayer_PlayerA`.
	 *
	 * So the floor belongs at the DEATH GATE, not on one writer. `KinkyDungeonEnemyCheckHP` is the
	 * single function that decides `hp <= 0` → `KDRemoveEntity` (or `KinkyDungeonCapture`, which
	 * removes it just as thoroughly), and every one of those ~30 writers funnels into it. Asserting
	 * there is asserting at the layer that actually deletes.
	 */
	it('survives an hp=0 written OUTSIDE KinkyDungeonDamageEnemy — the death gate must refuse', () => {
		const eid = s.avatars.get('B');
		const r = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
			if (!e) return { pre: 'the avatar is not on the map to begin with' };
			var logBefore = (typeof KinkyDungeonMessageLog !== 'undefined' && KinkyDungeonMessageLog)
				? KinkyDungeonMessageLog.length : 0;
			// A DoT tick / spell / event write. The KDM-224 damage wrapper never sees this one.
			e.hp = 0;
			// …and the fight path leaves the dying entity here, which is what makes the kill line print.
			if (typeof KinkyDungeonKilledEnemy !== 'undefined') KinkyDungeonKilledEnemy = e;
			// The REAL index. KDRemoveEntity splices \`forceIndex\` blindly (KinkyDungeonEnemies.ts:10555),
			// so passing 0 here would delete whatever entity sits first and leave the avatar in place —
			// a green that proves nothing.
			var idx = KDMapData.Entities.findIndex(function(x){ return x.id === ${eid}; });
			var removed = KinkyDungeonEnemyCheckHP(e, idx, KDMapData);
			var log = (typeof KinkyDungeonMessageLog !== 'undefined' && KinkyDungeonMessageLog)
				? KinkyDungeonMessageLog.slice(logBefore) : [];
			return {
				removed: !!removed, hp: e.hp,
				onMap: !!KDMapData.Entities.find(function(x){ return x.id === ${eid}; }),
				unresolved: log.map(function(m){ return (m && (m.text || m.message)) || ''; })
					.filter(function(t){ return String(t).indexOf('NotFound') >= 0; }),
				// The kill line is gated on identity with this global (KinkyDungeonEnemies.ts:3354).
				// An avatar left standing here is what printed "[NotFound] KillRemotePlayer_PlayerA".
				stillPendingKill: (typeof KinkyDungeonKilledEnemy !== 'undefined')
					&& KinkyDungeonKilledEnemy === e,
			};
		})()`);

		expect(r.pre, 'precondition').toBeUndefined();
		// eslint-disable-next-line no-console
		console.log('\ndeath gate on a zeroed avatar: ' + JSON.stringify(r) + '\n');

		expect(r.removed, "KD's death gate DELETED the peer avatar — a peer is knocked down, never killed")
			.toBe(false);
		expect(r.onMap, 'the avatar must still be on the map after the gate ran').toBe(true);
		expect(r.hp, "the avatar must be left alive at KD's own knockdown floor").toBeGreaterThan(0);
		expect(r.unresolved, 'the kill line has no text key for an avatar def — it prints "[NotFound] Kill…"')
			.toEqual([]);
		expect(r.stillPendingKill,
			'the avatar must not be left as the pending kill — that is what prints "[NotFound] KillRemotePlayer_…"')
			.toBe(false);
	}, BOOT_TIMEOUT);

	/**
	 * …and through the REAL caller. The gate is called from the entity sweeps inside
	 * `KinkyDungeonAdvanceTime` (KinkyDungeonGame.ts:3584 / :3603), with the loop's own index.
	 *
	 * NOT driven through `submit()`: `_armPeerEnemies` re-arms hp from the peer's Will at the START of
	 * every turn, so an hp written before a turn would be overwritten and the test would assert
	 * nothing. Advancing the world directly is what puts the zeroed avatar in front of the sweep.
	 */
	it('a real turn does not delete an avatar sitting at hp 0', () => {
		const eid = s.avatars.get('B');
		const r = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
			if (!e) return { pre: 'the avatar is not on the map to begin with' };
			e.hp = 0;
			KinkyDungeonAdvanceTime(1);
			var after = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
			return { onMap: !!after, hp: after ? after.hp : null };
		})()`);
		expect(r.pre, 'precondition').toBeUndefined();
		expect(r.onMap, 'a real turn deleted the peer avatar — this is the UAT "player disappears"')
			.toBe(true);
		expect(r.hp, 'and it must be left alive').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
