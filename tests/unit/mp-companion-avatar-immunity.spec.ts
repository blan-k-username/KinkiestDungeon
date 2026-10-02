/**
 * Node-layer (Vitest) acceptance test: a player's own real ally/companion must never deal damage to
 * ANOTHER joined player — via the other player's avatar, while that player is not the one swapped in.
 *
 * UAT bug (co-op): "the friendly NPC (earth witch) is the companion of the Orange-haired player
 * (left). But NPC attacks the Owner. The reputation looks correct 'it likes you'." Screenshot showed
 * BOTH players' avatars taking the companion's hits via its own spell.
 *
 * Root cause: plain (non-PvP) co-op avatars are unconditionally stamped `faction = 'Enemy'` every
 * round, purely to restore their hp gauge (`HeadlessHost.setAvatarEnemy`, called every round from
 * `SwapSession._reconcilePeers`, regardless of war state). KD's own faction rule hard-codes
 * `KDFactionHostile('Player', 'Enemy') === true` (`KinkyDungeonFactions.ts`), so any real
 * Player-faction follower (a recruited ally, `KDAddToParty`) reads every other player's avatar as a
 * valid hostile target, through the same nearby-entity targeting a real hostile monster uses
 * (`KinkyDungeonNearestPlayer`'s `KDNearbyEnemies` scan) -- not merely a bump collision.
 *
 * MEASURED: a hit landed this way does not show up as a change on the avatar's OWN hp -- the avatar is
 * a cosmetic representation that `_reconcilePeers` restores to full every round BY DESIGN (a hit is
 * taken from `takePeerHits`, the per-turn damage recorder, and re-applied onto the REAL victim's Will --
 * exactly the channel a PvP peer's attack uses). The message log proves the hit is real ("Player B took
 * 13 Pain damage.") while `getEntityCombat(avatarB).hp` stays at its max the entire time. So the correct
 * oracle is the real player's Will (`SwapSession.vitalsOf`), not the avatar's hp -- asserting on avatar
 * hp alone would be a vacuous probe that cannot see this bug at all.
 *
 * Control: the SAME mechanism, given a genuinely hostile monster to stand next to instead, must still
 * damage it -- proving the probe can see damage happen and isn't vacuously green.
 *
 * Imports the harness under tools/mp-server/** only -- never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;
const ROUNDS = 20;

/**
 * Drop a real entity straight into the world via the engine's own `KDAddNewEntity` (the same
 * primitive `HeadlessHost.ensureAvatar` uses to inject an avatar) -- skipping
 * `KinkyDungeonSummonEnemy`'s goToTarget/pathfind requirement, which has no reachable target this
 * early in a headless session and silently summons NOTHING (measured: `KDMapData.Entities.length`
 * unchanged), so a caller that doesn't check would unknowingly operate on a stale "last entity".
 */
function spawnEntityDirect(s: any, x: number, y: number, type: string): { id: number, name: string } {
	const before = s.world.eval('KDMapData.Entities.length');
	const out = s.world.eval(`(function(){
		var Enemy = KinkyDungeonGetEnemyByName(${JSON.stringify(type)});
		if (!Enemy) return null;
		var e = { summoned: true, Enemy: Enemy, id: KinkyDungeonGetEnemyID(),
			x: ${x | 0}, y: ${y | 0}, hp: Enemy.startinghp || Enemy.maxhp,
			movePoints: 0, attackPoints: 0 };
		e = KDAddNewEntity(e);
		KDUpdateEnemyCache = true;
		return { id: e.id, name: e.Enemy && e.Enemy.name };
	})()`);
	const after = s.world.eval('KDMapData.Entities.length');
	if (!out || after !== before + 1) throw new Error(`setup invalid: failed to spawn ${type} at (${x},${y})`);
	return out;
}

/** Recruit a real ally near `ownerCid` -- KD's own party mechanism (`KDAddToParty`), which stamps
 *  `faction = 'Player'` on the live entity, exactly what happens to a real recruited companion. */
function recruitCompanion(s: any, ownerCid: string, type: string): number {
	const pos = s.posOf(ownerCid);
	const summoned = spawnEntityDirect(s, pos.x, pos.y, type);
	const ok = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${summoned.id}; });
		if (!e || typeof KDAddToParty !== 'function') return false;
		return !!KDAddToParty(e);
	})()`);
	if (!ok) throw new Error('setup invalid: KDAddToParty did not accept the summoned companion');
	return summoned.id;
}

function factionOf(s: any, entityId: number): string | null {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? ((typeof KDGetFaction === 'function') ? KDGetFaction(e) : e.faction) : null;
	})()`);
}

function hpOf(s: any, entityId: number): { hp: number, maxhp: number } | null {
	const c = s.world.getEntityCombat(entityId);
	return c ? { hp: c.hp, maxhp: c.maxhp } : null;
}

function posOfEntity(s: any, entityId: number): { x: number, y: number } | null {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? { x: e.x, y: e.y } : null;
	})()`);
}

/**
 * Move `entityId` onto a free tile next to `nearCid`'s avatar (unless already adjacent --
 * repositioning mid-attack would reset an in-progress attack commitment, see
 * mp-enemy-ai-once-per-round), and arm it as already locked onto that avatar (`gx`/`gy`, the same
 * real fields `pinEnemyNextToB` sets in that spec).
 *
 * `gx`/`gy` matter here specifically: the avatar def is deliberately `lowpriority`
 * (`HeadlessHost._ensureAvatarDef`'s doc comment) so a real hostile monster PREFERS the actual
 * swapped-in player when it can reach them -- `KinkyDungeonNearestPlayer` only accepts a lowpriority
 * candidate when the seeker is already locked onto it (`enemy.gx == e.x && enemy.gy == e.y`) or cannot
 * path/see the real player. A real session reaches that lock the ordinary way -- the companion loses
 * line of sight to the real player for even one tick (a corner, a doorway) and opportunistically locks
 * onto whichever avatar IS visible -- and the lock then persists even once the real player is visible
 * again. Setting `gx`/`gy` directly here pins that already-reached, ordinary state without needing to
 * build a real line-of-sight-blocking corridor.
 */
function pinNextTo(s: any, nearCid: string, entityId: number) {
	const p = s.posOf(nearCid);
	const already = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? (Math.max(Math.abs(e.x - ${p.x}), Math.abs(e.y - ${p.y})) === 1) : false;
	})()`);
	if (!already) {
		const nb = freeNeighbour(s, nearCid);
		if (!nb) throw new Error(`setup invalid: no free tile beside ${nearCid}`);
		s.world.moveAvatar(entityId, nb.x, nb.y);
	}
	const target = s.posOf(nearCid);
	s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		if (e) { e.aware = true; e.gx = ${target.x}; e.gy = ${target.y}; }
		KDUpdateEnemyCache = true;
	})()`);
}

/**
 * Park `mobileCid`'s avatar onto a free tile next to `anchorCid` -- the ordinary co-op case of two
 * players standing together. `KinkyDungeonNearestPlayer`'s own leash check ("pdist_enemy") only lets
 * a Player-faction follower consider a candidate target within a handful of tiles of the REAL
 * swapped-in player; a target merely near the FOLLOWER itself, far from whoever is actually driving,
 * is invisible to it. So the companion only has a chance to see the other player's avatar as a target
 * when that avatar is near the real acting player, exactly as it would be in a real party.
 */
function standTogether(s: any, mobileCid: string, anchorCid: string) {
	const a = s.posOf(anchorCid), m = s.posOf(mobileCid);
	if (Math.max(Math.abs(a.x - m.x), Math.abs(a.y - m.y)) === 1) return;
	const nb = freeNeighbour(s, anchorCid);
	if (!nb) throw new Error(`setup invalid: no free tile beside ${anchorCid}`);
	s.world.moveAvatar(s.avatars.get(mobileCid), nb.x, nb.y);
}

describe('a real companion never damages another player via their avatar', () => {
	it('control: a real ally still damages an ACTUAL hostile monster beside it', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'companion-control', enemyType: null });
		s.join('A'); s.join('B');
		await s.ready();

		const companionId = recruitCompanion(s, 'A', 'WitchEarth');
		expect(factionOf(s, companionId), 'setup: the companion must really be Player-faction')
			.toBe('Player');

		// A real hostile monster, standing next to the companion (Rat's own def faction -- not Player).
		const posA = s.posOf('A');
		const monster = spawnEntityDirect(s, posA.x + 2, posA.y, 'Rat');
		expect(factionOf(s, monster.id)).not.toBe('Player');

		let anyDamage = false;
		for (let round = 1; round <= ROUNDS; round++) {
			const cPos = posOfEntity(s, companionId)!;
			s.world.moveAvatar(monster.id, cPos.x, cPos.y + 1);
			s.world.eval(`(function(){
				var e = KDMapData.Entities.find(function(en){ return en.id === ${monster.id}; });
				if (e) { e.aware = true; e.hostile = 0; }
				var c = KDMapData.Entities.find(function(en){ return en.id === ${companionId}; });
				if (c) c.aware = true;
				KDUpdateEnemyCache = true;
			})()`);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });

			// `getEntityCombat` returns null once the entity is gone -- a one-shot kill (measured: the
			// companion's spell nearly one-shots a Rat) is still proof of real damage, not an absence of it.
			const mhp = hpOf(s, monster.id);
			if (!mhp || mhp.hp < mhp.maxhp) { anyDamage = true; break; }
		}

		expect(anyDamage,
			`liveness: the real ally must be ABLE to damage a genuine hostile target over ${ROUNDS} rounds ` +
			'-- otherwise the main assertion below would be vacuous').toBe(true);
	}, BOOT_TIMEOUT);

	it("a real companion never reduces the OTHER player's real Will via their avatar", async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-repro', enemyType: null });
		s.join('A'); s.join('B');
		await s.ready();

		const companionId = recruitCompanion(s, 'A', 'WitchEarth');
		expect(factionOf(s, companionId)).toBe('Player');

		// Lock the companion's round-to-round engagement onto its OWNER first (its own follower
		// behaviour would do this naturally) before testing whether it ever turns on the other avatar.
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		const willMaxB = s.vitalsOf.get('B').willMax;
		const willMaxA = s.vitalsOf.get('A').willMax;

		for (let round = 1; round <= ROUNDS; round++) {
			// The ordinary co-op case: both players standing together, companion right next to B's
			// avatar specifically (KD's AI picks a target by the FOLLOWER's own adjacency/vision, while
			// separately leashing to within a few tiles of the REAL acting player -- see `standTogether`).
			standTogether(s, 'B', 'A');
			pinNextTo(s, 'B', companionId);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });

			const willB = s.vitalsOf.get('B').will;
			const willA = s.vitalsOf.get('A').will;
			expect(willB, `round ${round}: the OTHER player's real Will must never drop from the companion`)
				.toBe(willMaxB);
			expect(willA, `round ${round}: the owner's OWN real Will must never drop from their companion`)
				.toBe(willMaxA);
		}
	}, BOOT_TIMEOUT);
});
