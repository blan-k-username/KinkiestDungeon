/**
 * KDM-184 — a peer is defended by THEIR OWN evasion/block, not by the stand-in's.
 *
 * KDM-164 routed peer damage through KD's real player pipeline, so from the moment damage is dealt the
 * victim's own armour, spell resist, type resistances, damage reduction and `beforePlayerDamage` /
 * `duringPlayerDamage` events all apply. What did NOT apply is what the game evaluates BEFORE that —
 * hit-or-miss — because that is read off the stand-in ENTITY, never off the player slot:
 *
 *   KinkyDungeonAttackEnemy (KinkyDungeonFight.ts:1649) passes the player slot as the ATTACKER and
 *   asks KinkyDungeonEvasion about the ENTITY; KinkyDungeonGetEvasion:486 then reads
 *   `MultiplicativeStat(GetBuffedStat(Enemy.buffs, "Evasion"))`.
 *
 * The avatar had no `buffs` at all and its def carried `evasion: -100`
 * (`MultiplicativeStat(-100) = 101`), so every PvP attack landed unconditionally.
 *
 * ⚠️ BOTH causes must be fixed together or this suite is vacuous. Measured in the KDM-184 probe: an
 * Evasion buff with the def still at -100 gives hitChance 25.25 — a mirror that "works" and changes
 * nothing. Case 2 exists to catch exactly that.
 *
 * These read the NUMBER KinkyDungeonGetEvasion returns rather than sampling hits, so they are
 * deterministic and contention-immune.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('KDM-184 — peer defences apply at attack time', () => {
	let s: any;

	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm184', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		s._shuffle = () => ['A', 'B'];
	}, BOOT_TIMEOUT);

	/**
	 * Give a player a real KD buff of `stat`, on their own bundle, through the GAME's own
	 * `KinkyDungeonApplyBuffToEntity` — not by assigning into `KinkyDungeonPlayerBuffs`.
	 *
	 * ⚠️ Writing the key directly reads back as 0. `KinkyDungeonGetBuffedStat` memoises per stat type
	 * in `KDBuffedStatTypeMemo`, a Map keyed by the buff-list OBJECT (`KinkyDungeonBuffs.ts:300`), and
	 * boot has already populated that memo — so an in-place mutation is invisible to every later read.
	 * KD's own path registers the invalidation. This cost one red run; do not "simplify" it back.
	 */
	function buildDefence(id: string, stat: string, power: number) {
		s.world.restorePlayer(s.bundles.get(id));
		const applied = s.world.eval(`(function(){
			KinkyDungeonApplyBuffToEntity(KinkyDungeonPlayerEntity,
				{ id: ${JSON.stringify('kdm184' + stat)}, type: ${JSON.stringify(stat)},
				  power: ${Number(power)}, duration: 9999 });
			return KinkyDungeonGetBuffedStat(KinkyDungeonPlayerBuffs, ${JSON.stringify(stat)});
		})()`);
		// Guard the setup itself: a silent 0 here would make every assertion below vacuous.
		expect(applied).toBeCloseTo(power, 5);
		s.bundles.set(id, s.world.capturePlayer());
		s.vitalsOf.set(id, s.world.getVitals());
	}

	/** The hit chance KD would use for an attack on `id`'s stand-in, after the turn's arming. */
	function hitChanceOn(id: string): number {
		s._armPeerEnemies(id === 'A' ? 'B' : 'A');
		const eid = s.avatars.get(id);
		return s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${eid | 0}; });
			if (!e) return null;
			return KinkyDungeonGetEvasion(e, undefined, false, undefined, true, undefined);
		})()`);
	}

	it('a peer who built Evasion is harder to hit than one who did not', () => {
		buildDefence('B', 'Evasion', 3.0);
		const evasive = hitChanceOn('B');
		const plain = hitChanceOn('A');   // A built nothing
		expect(evasive).toBeLessThan(plain);
		expect(evasive).toBeLessThan(1);  // a real chance to miss, not merely "less"
	}, BOOT_TIMEOUT);

	it('the stand-in def no longer cancels the mirror (the vacuous-green trap)', () => {
		// With `evasion: -100` on the def this returns 25.25 — mirrored, and still an unconditional hit.
		buildDefence('B', 'Evasion', 3.0);
		expect(hitChanceOn('B')).toBeLessThan(1);
	}, BOOT_TIMEOUT);

	it('a bigger Evasion build evades more than a smaller one', () => {
		buildDefence('B', 'Evasion', 3.0);
		const small = hitChanceOn('B');
		buildDefence('B', 'Evasion', 10.0);
		const big = hitChanceOn('B');
		expect(big).toBeLessThan(small);
	}, BOOT_TIMEOUT);

	it('mirrors Block as well as Evasion, from the victim own buffs', () => {
		buildDefence('B', 'Block', 4.0);
		s._armPeerEnemies('A');
		const eid = s.avatars.get('B');
		const got = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${eid | 0}; });
			if (!e || !e.buffs) return null;
			return { block: KinkyDungeonGetBuffedStat(e.buffs, 'Block'),
			         evasion: KinkyDungeonGetBuffedStat(e.buffs, 'Evasion') };
		})()`);
		expect(got).toBeTruthy();
		expect(got.block).toBeCloseTo(4.0, 5);
		expect(got.evasion).toBeCloseTo(0, 5);
	}, BOOT_TIMEOUT);

	it('AC4 — an undefended peer is still hit every time (the 12 PvP e2e specs rely on this)', () => {
		expect(hitChanceOn('B')).toBeGreaterThanOrEqual(1);
	}, BOOT_TIMEOUT);

	it('the mirror TRACKS the victim: dropping the buff restores a plain hit chance', () => {
		buildDefence('B', 'Evasion', 3.0);
		expect(hitChanceOn('B')).toBeLessThan(1);
		s.world.restorePlayer(s.bundles.get('B'));
		const left = s.world.eval(`(function(){
			KinkyDungeonExpireBuff(KinkyDungeonPlayerEntity, 'kdm184Evasion');
			return KinkyDungeonGetBuffedStat(KinkyDungeonPlayerBuffs, 'Evasion');
		})()`);
		expect(left).toBeCloseTo(0, 5);
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', s.world.getVitals());
		// A stale mirror would keep evading forever — this is the memo-identity trap.
		expect(hitChanceOn('B')).toBeGreaterThanOrEqual(1);
	}, BOOT_TIMEOUT);
});
