/**
 * Node-layer (Vitest) acceptance tests for splitting the turn model's MIXED functions (functions
 * that run a step for the ACTING player alongside a world-wide loop, under one name — `turn-
 * classification.js` verdict `split`): effect tiles, buffs, and bullets.
 *
 * UAT this was written against: "projectiles travel at double speed with 2 players" — every MIXED
 * function's world half was running once per PLAYER-PHASE apply instead of once per round, same bug
 * shape as the enemy-AI double-action report `mp-enemy-ai-once-per-round.spec.ts` fixed, just for the
 * four names `turn-classification.js` excluded from `WORLD_MUTE_FNS` (effect tiles x2, bullets x2).
 *
 * What a round must cost, regardless of player count, against a 1-player control:
 *   - `KDUpdateEffectTiles`, `KinkyDungeonUpdateTileEffects`, `KinkyDungeonUpdateBullets`,
 *     `KinkyDungeonUpdateBulletsCollisions` each run REAL (unmuted) exactly the 1-player count —
 *     their world-wide loop/physics runs once per round, not once per player.
 *   - each player's OWN per-turn step inside those same functions (standing-on-tile effect tiles,
 *     own buff decay) still runs once per THEM, every round — never dropped by the muting.
 *   - an AOE bullet's player-effect (KinkyDungeonPlayerEffect) reaches a human it lands on even when
 *     they are not the slot occupant at that moment.
 *   - a followPlayer bullet owned by a non-slot human tracks ITS OWNER's avatar, not the slot.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour, placePlayerAt } from '../helpers/session-tiles';
import { bundleHasBuff } from './helpers/bundle';

const BOOT_TIMEOUT = 240_000;

/**
 * Count REAL (unmuted) invocations of a world-shared engine function — same production distinction
 * `mp-enemy-ai-once-per-round.spec.ts` uses: `installTurnModel` mutes a call by returning before it
 * does any work while `globalThis.__kdWorldMuted` is armed, so reading that SAME flag at call time is
 * what "real" means here.
 */
function installWorldCallCounters(s: any, names: string[]) {
	s.world.eval(`(function(){
		if (!globalThis.__kdMixedCounterWrapped) globalThis.__kdMixedCounterWrapped = {};
		var names = ${JSON.stringify(names)};
		names.forEach(function(name){
			if (globalThis.__kdMixedCounterWrapped[name]) return;
			var prev = eval(name);
			var wrapped = function(){
				globalThis.__kdMixedCallCounts[name] = (globalThis.__kdMixedCallCounts[name] || 0) + 1;
				if (!globalThis.__kdWorldMuted) {
					globalThis.__kdMixedRealCounts[name] = (globalThis.__kdMixedRealCounts[name] || 0) + 1;
				}
				return prev.apply(this, arguments);
			};
			eval(name + ' = wrapped;');
			globalThis.__kdMixedCounterWrapped[name] = true;
		});
		return true;
	})()`);
	resetWorldCallCounters(s);
}
function resetWorldCallCounters(s: any) {
	s.world.eval('globalThis.__kdMixedCallCounts = {}; globalThis.__kdMixedRealCounts = {};');
}
function realCalls(s: any, name: string): number {
	return s.world.eval(`(globalThis.__kdMixedRealCounts || {})[${JSON.stringify(name)}] || 0`);
}

/** A tile's remaining `duration`, read live — `null` once it has expired/been removed. */
function effectTileDuration(s: any, x: number, y: number, name: string): number | null {
	return s.world.eval(`(function(){
		var loc = KDGetEffectTiles(${x | 0}, ${y | 0});
		var t = loc && loc[${JSON.stringify(name)}];
		return t ? t.duration : null;
	})()`);
}

const SPLIT_FN_NAMES = [
	'KDUpdateEffectTiles', 'KinkyDungeonUpdateTileEffects',
	'KinkyDungeonUpdateBullets', 'KinkyDungeonUpdateBulletsCollisions',
];

describe('mixed-function split: world halves run once per round', () => {
	/** The 1-player baseline every split function's REAL per-round call count must match. */
	async function soloBaseline() {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'mixed-split-solo' });
		solo.join('A');
		await solo.ready();
		installWorldCallCounters(solo, SPLIT_FN_NAMES);
		solo.submit('A', { kind: 'wait' });
		const counts: Record<string, number> = {};
		for (const name of SPLIT_FN_NAMES) counts[name] = realCalls(solo, name);
		return counts;
	}

	it('control: a 1-player round\'s own counts are internally consistent (liveness)', async () => {
		const base = await soloBaseline();
		for (const name of SPLIT_FN_NAMES) {
			expect(base[name], `control: ${name} ran for real at least once`).toBeGreaterThan(0);
		}
	}, BOOT_TIMEOUT);

	it('a 2-player round costs exactly the 1-player baseline, not once per player', async () => {
		const base = await soloBaseline();

		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-duo' });
		s.join('A'); s.join('B');
		await s.ready();
		installWorldCallCounters(s, SPLIT_FN_NAMES);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		for (const name of SPLIT_FN_NAMES) {
			expect(realCalls(s, name),
				`${name} must run for real exactly the 1-player count per round, not once per player`)
				.toBe(base[name]);
		}
	}, BOOT_TIMEOUT);
});

describe('mixed-function split: effect tiles', () => {
	it('each player\'s own standing-on-tile step still fires every round, for every player', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-icetiles' });
		s.join('A'); s.join('B');
		await s.ready();

		const posA = s.posOf('A');
		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);
		const posB = s.posOf('B');

		// One Ice tile under EACH player — a long duration so one round's tick-down never expires it,
		// and KDCreateEffectTile's own tile-merge rule (keep the longer duration) cannot interfere.
		s.world.eval(`(function(){ KDCreateEffectTile(${posA.x}, ${posA.y}, { name: "Ice", duration: 10 }, 0); })()`);
		s.world.eval(`(function(){ KDCreateEffectTile(${posB.x}, ${posB.y}, { name: "Ice", duration: 10 }, 0); })()`);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(bundleHasBuff(s.bundles.get('A'), 'Chilled'),
			'A stood on their own Ice tile this round and must have been Chilled by it').toBe(true);
		expect(bundleHasBuff(s.bundles.get('B'), 'Chilled'),
			'B stood on their own Ice tile this round and must have been Chilled by it, not just A\'s').toBe(true);
	}, BOOT_TIMEOUT);

	it('the world-wide tick-down ages a tile by the 1-player amount, not once per player', async () => {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'mixed-split-tileage-solo' });
		solo.join('A');
		await solo.ready();
		const pSolo = solo.posOf('A');
		// A SECOND tile, away from the player, isolates the world-wide tick-down loop from the
		// player's own standing-on-tile step (which only touches the tile under their own feet).
		const away = { x: pSolo.x + 3, y: pSolo.y };
		solo.world.eval(`(function(){ KDCreateEffectTile(${away.x}, ${away.y}, { name: "Ice", duration: 10 }, 0); })()`);
		solo.submit('A', { kind: 'wait' });
		const soloDuration = effectTileDuration(solo, away.x, away.y, 'Ice');
		expect(soloDuration, 'liveness: the tile must still exist after one round').not.toBeNull();
		const soloDecrement = 10 - (soloDuration as number);
		expect(soloDecrement, 'control: the tile ages by a non-zero amount in one round').toBeGreaterThan(0);

		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-tileage-duo' });
		s.join('A'); s.join('B');
		await s.ready();
		const pA = s.posOf('A');
		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);
		const awayDuo = { x: pA.x + 3, y: pA.y };
		s.world.eval(`(function(){ KDCreateEffectTile(${awayDuo.x}, ${awayDuo.y}, { name: "Ice", duration: 10 }, 0); })()`);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const duoDuration = effectTileDuration(s, awayDuo.x, awayDuo.y, 'Ice');
		expect(duoDuration, 'liveness: the tile must still exist after the round').not.toBeNull();
		const duoDecrement = 10 - (duoDuration as number);

		expect(duoDecrement, 'a 2-player round must age the tile by the 1-player amount per round, ' +
			'not once per player').toBe(soloDecrement);
	}, BOOT_TIMEOUT);
});

describe('mixed-function split: buffs (verifying the pre-existing per-entity split, not a new wrap)', () => {
	/** A buff with no gameplay side effect to measure, just a duration to watch decay. */
	const TEST_BUFF = () => `{ id: "MixedSplitProbe", type: "MoveSpeed", power: 0, player: true, enemies: true, duration: 20 }`;

	it('an enemy\'s own buff decays by the 1-player amount per round, not once per player', async () => {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'mixed-split-buff-enemy-solo', enemyType: 'Rat' });
		solo.join('A');
		await solo.ready();
		solo.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${solo.enemyId}; });
			if (e) { if (!e.buffs) e.buffs = {}; KinkyDungeonApplyBuffToEntity(e, ${TEST_BUFF()}); }
		})()`);
		const soloBefore = solo.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${solo.enemyId}; });
			return e && e.buffs && e.buffs.MixedSplitProbe ? e.buffs.MixedSplitProbe.duration : null;
		})()`);
		solo.submit('A', { kind: 'wait' });
		const soloAfter = solo.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${solo.enemyId}; });
			return e && e.buffs && e.buffs.MixedSplitProbe ? e.buffs.MixedSplitProbe.duration : null;
		})()`);
		expect(soloBefore, 'liveness: the buff must have been applied').not.toBeNull();
		expect(soloAfter, 'liveness: the buff must still exist after one round').not.toBeNull();
		const soloDecrement = soloBefore - soloAfter;
		expect(soloDecrement, 'control: the buff decays by a non-zero amount in one round').toBeGreaterThan(0);

		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-buff-enemy-duo', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			if (e) { if (!e.buffs) e.buffs = {}; KinkyDungeonApplyBuffToEntity(e, ${TEST_BUFF()}); }
		})()`);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const duoAfter = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			return e && e.buffs && e.buffs.MixedSplitProbe ? e.buffs.MixedSplitProbe.duration : null;
		})()`);
		expect(duoAfter, 'liveness: the buff must still exist after the round').not.toBeNull();
		const duoDecrement = soloBefore - duoAfter;

		expect(duoDecrement, 'a 2-player round must decay the enemy\'s buff by the 1-player amount, ' +
			'not once per player').toBe(soloDecrement);
	}, BOOT_TIMEOUT);

	it('each player\'s OWN buff decays once per round, for every player, never doubled', async () => {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'mixed-split-buff-player-solo' });
		solo.join('A');
		await solo.ready();
		solo.world.restorePlayer(solo.bundles.get('A'));
		solo.world.eval(`(function(){ KinkyDungeonApplyBuffToEntity(KinkyDungeonPlayerEntity, ${TEST_BUFF()}); })()`);
		solo.bundles.set('A', solo.world.capturePlayer());
		solo.submit('A', { kind: 'wait' });
		solo.world.restorePlayer(solo.bundles.get('A'));
		const soloAfter = solo.world.eval(`(KinkyDungeonPlayerBuffs.MixedSplitProbe ? KinkyDungeonPlayerBuffs.MixedSplitProbe.duration : null)`);
		expect(soloAfter, 'liveness: the player\'s buff must still exist after one round').not.toBeNull();
		const soloDecrement = 20 - soloAfter;
		expect(soloDecrement, 'control: the player\'s own buff decays by a non-zero amount in one round').toBeGreaterThan(0);

		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-buff-player-duo' });
		s.join('A'); s.join('B');
		await s.ready();
		for (const id of ['A', 'B']) {
			s.world.restorePlayer(s.bundles.get(id));
			s.world.eval(`(function(){ KinkyDungeonApplyBuffToEntity(KinkyDungeonPlayerEntity, ${TEST_BUFF()}); })()`);
			s.bundles.set(id, s.world.capturePlayer());
		}
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		for (const id of ['A', 'B']) {
			s.world.restorePlayer(s.bundles.get(id));
			const after = s.world.eval(`(KinkyDungeonPlayerBuffs.MixedSplitProbe ? KinkyDungeonPlayerBuffs.MixedSplitProbe.duration : null)`);
			expect(after, `liveness: ${id}'s own buff must still exist after the round`).not.toBeNull();
			const decrement = 20 - after;
			expect(decrement, `${id}'s own buff must decay by the 1-player amount per round, not be ` +
				'doubled and not be skipped').toBe(soloDecrement);
		}
	}, BOOT_TIMEOUT);
});

describe('mixed-function split: bullets', () => {
	it('an AOE bullet landing on the non-host player hits them through the real player pipeline', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-bullet-aoe' });
		s.join('A'); s.join('B');
		await s.ready();

		const posA = s.posOf('A');
		// Put B one tile from A, well within Firecracker's aoe (1) of where A's cast will land.
		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);

		// Give A mana so the cast is not resource-gated.
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval('KinkyDungeonStatManaMax = 100; KinkyDungeonStatMana = 100;');
		s.bundles.set('A', s.world.capturePlayer());

		s.world.restorePlayer(s.bundles.get('B'));
		const bWillBefore = s.world.getVitals().will;
		s.world.restorePlayer(s.bundles.get('A'));
		const aWillBefore = s.world.getVitals().will;

		// A applies LAST every round, hosting the round's one real tick each time — Firecracker
		// (onhit:"aoe", delay:1) detonates a tick or two after launch, same as mp-spell-cast.spec.ts's
		// "pump a few more ticks" pattern, just one round at a time through the real session.
		//
		// Targeted at A's OWN tile, not B's: a Player-faction bullet does not collide with a peer's
		// avatar (co-op peers are allies, not hostile — the engine's own real behaviour, not a co-op
		// bug), so a cast aimed AT B's tile flies straight through it without detonating there at
		// all. Aimed at the caster's own tile, the blast is guaranteed to land — B, one tile away,
		// is still well within the aoe=1 radius, exercising exactly the mechanism this split adds:
		// the engine's own AOE check only ever reaches the slot occupant (A); B is only hit because
		// KinkyDungeonPlayerEffect's wrap replays the same check against every other joined human.
		s._shuffle = () => ['B', 'A'];
		s.submit('B', { kind: 'wait' });
		s.submit('A', {
			kdType: 'tryCastSpell',
			data: { tx: posA.x, ty: posA.y, spellname: 'Firecracker', player: { __kdEnt: 'player' } },
		});
		let bWillAfter = bWillBefore;
		for (let i = 0; i < 5 && bWillAfter >= bWillBefore; i++) {
			s.submit('B', { kind: 'wait' });
			s.submit('A', { kind: 'wait' });
			s.world.restorePlayer(s.bundles.get('B'));
			bWillAfter = s.world.getVitals().will;
		}
		// KD has no player "hp" (KinkyDungeonDealDamage, KinkyDungeonStats.ts:635, reduces Will/
		// Stamina, never an hp field) — Will is the real, observable damage signal here.
		expect(bWillAfter, 'the AOE must have damaged B through the real player-effect pipeline, not ' +
			'just A (the slot occupant at cast time)').toBeLessThan(bWillBefore);

		// The AOE must still hit BOTH humans, not trade A's own hit away for B's: A is the caster,
		// standing on the blast's own origin tile, so the engine's own (unwrapped) slot-occupant check
		// must still have damaged A exactly as it always did before this split existed.
		s.world.restorePlayer(s.bundles.get('A'));
		const aWillAfter = s.world.getVitals().will;
		expect(aWillAfter, 'A (the slot occupant at cast time) must still take the AOE\'s own damage, ' +
			'same as a 1-player cast — B\'s replay is an ADDITION, not a substitution').toBeLessThan(aWillBefore);
	}, BOOT_TIMEOUT);

	it('a followPlayer bullet owned by a non-host player tracks ITS OWNER, not whoever holds the slot', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-bullet-follow' });
		s.join('A'); s.join('B');
		await s.ready();

		const posA = s.posOf('A');
		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);
		const posB = s.posOf('B');

		// Fabricate a followPlayer bullet (no real spell in Game/src/** data uses this field; the
		// engine itself snaps it to the slot occupant — Game/src/fight/KinkyDungeonFight.ts:1864) and
		// tag it owned by B via the SAME mechanism a real cast would (tagOwnedBullets).
		s.world.eval(`(function(){
			KDMapData.Bullets.push({
				spriteID: 'mixedSplitFollowProbe', x: ${posA.x}, y: ${posA.y}, xx: ${posA.x}, yy: ${posA.y},
				vx: 0, vy: 0, time: 50, born: 0, lifetime: 50,
				bullet: { faction: 'Player', followPlayer: true, name: 'mixedSplitFollowProbe' },
			});
		})()`);
		s.world.tagOwnedBullets('B');

		// A applies LAST (hosts the round's one real tick, holds the slot at the end), so the slot
		// occupant and the bullet's owner are DIFFERENT humans — the discriminating case.
		s._shuffle = () => ['B', 'A'];
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		const bulletPos = s.world.eval(`(function(){
			var b = KDMapData.Bullets.find(function(x){ return x.spriteID === 'mixedSplitFollowProbe'; });
			return b ? { x: b.x, y: b.y } : null;
		})()`);
		expect(bulletPos, 'liveness: the fabricated bullet must still exist after the round').not.toBeNull();
		expect(bulletPos, 'a followPlayer bullet owned by B must track B\'s avatar, not A (the slot ' +
			'occupant at the end of this round)').toEqual({ x: posB.x, y: posB.y });
	}, BOOT_TIMEOUT);

	it('CONTROL: a 1-player session\'s followPlayer bullet still tracks the (only) player, unaffected', async () => {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'mixed-split-bullet-follow-solo' });
		solo.join('A');
		await solo.ready();
		const posA = solo.posOf('A');
		solo.world.eval(`(function(){
			KDMapData.Bullets.push({
				spriteID: 'mixedSplitFollowSolo', x: ${posA.x}, y: ${posA.y}, xx: ${posA.x}, yy: ${posA.y},
				vx: 0, vy: 0, time: 50, born: 0, lifetime: 50,
				bullet: { faction: 'Player', followPlayer: true, name: 'mixedSplitFollowSolo' },
			});
		})()`);
		solo.world.tagOwnedBullets('A');
		solo.submit('A', { kind: 'wait' });
		const bulletPos = solo.world.eval(`(function(){
			var b = KDMapData.Bullets.find(function(x){ return x.spriteID === 'mixedSplitFollowSolo'; });
			return b ? { x: b.x, y: b.y } : null;
		})()`);
		expect(bulletPos, 'liveness: the fabricated bullet must still exist').not.toBeNull();
		expect(bulletPos, 'control: with one player, followPlayer snapping to the slot is already correct')
			.toEqual(posA);
	}, BOOT_TIMEOUT);

	it('a direct (non-AOE) bullet hitting the non-host player\'s avatar resolves through the real ' +
		'player pipeline, not NPC-only damage', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-bullet-direct' });
		s.join('A'); s.join('B');
		await s.ready();

		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);

		const avatarId = s.avatars.get('B');

		// A hosts the round's one real tick; B's avatar sits on the map, parked back at its own tile
		// before A's apply runs. A stationary bullet with time>=0 is resolved every round regardless of
		// velocity (KinkyDungeonBulletsCheckCollision, KinkyDungeonFight.ts:3118/3130-3131 — AoE there
		// means "time>=0", not literally an AoE spell) — this is the "already standing on a live
		// bullet" case the engine itself handles, not a travelling shot requiring exact flight-path
		// timing. `faction: 'Beast'` (an ordinary monster faction, simulating a real enemy bolt) —
		// needed on two counts: a bullet with NO faction at all crashes the engine's own
		// KinkyDungeonUpdateBullets allied-pass faction lookup (KDFactionAllied expects a string or an
		// entity, never undefined); and `faction: 'Player'` specifically does NOT work here — co-op
		// avatars are stamped `allied` toward the Player faction (same "co-op peers are allies" rule
		// the AOE test above documents), so a Player-faction bullet is FAVORABLE to them and never
		// registers as a hit via KDBulletCanHitEntity's enemy branch at all. Beast has no such
		// relation to the avatar's own 'Enemy' stamp (an earlier investigation's own finding: relation
		// 0, below the favorable threshold), so it collides normally — this is also the more realistic case: a real
		// monster's bolt, not the player's own.
		//
		// playerEffect "GhostHaunt" (applies the "Haunted" buff to its target — no damage at all), not
		// "Damage": a damage-type playerEffect is the WRONG oracle here, found the hard way — ANY
		// damage dealt to a joined human's avatar, through EITHER pipeline, is independently folded
		// back into that human's real Will by `SwapSession._reconcilePeers`'s pre-existing
		// `takePeerHits`/`dealDamage` replay (every round, so co-op avatars taking damage is never
		// silently lost) — so Will moving proves nothing about which pipeline resolved THIS hit.
		// `_reconcilePeers` only ever mirrors DAMAGE and restraint-tag bookkeeping, never an arbitrary
		// buff — GhostHaunt's buff is therefore a clean, undoubled signal: it can ONLY appear on B's own
		// bundle if this exact call went through the real KinkyDungeonPlayerEffect pipeline for B.
		s._shuffle = () => ['B', 'A'];
		s.world.eval(`(function(){
			var av = KDMapData.Entities.find(function(e){ return e.id === ${avatarId}; });
			KDMapData.Bullets.push({
				spriteID: 'directHitProbe', x: av.x, y: av.y, xx: av.x, yy: av.y, vx: 0, vy: 0,
				time: 5, born: 0, lifetime: 5,
				bullet: { name: 'directHitProbe', faction: 'Beast', damage: { damage: 1, type: 'fire' },
					playerEffect: { name: 'GhostHaunt' }, spell: { power: 1 } },
			});
		})()`);
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		expect(bundleHasBuff(s.bundles.get('B'), 'Haunted'), 'a direct bullet hit on B\'s avatar must ' +
			'resolve through the real PLAYER pipeline (KinkyDungeonPlayerEffect -> the GhostHaunt ' +
			'handler), exactly as it would if B already held the slot — the enemy path has no mechanism ' +
			'that could ever apply this buff').toBe(true);
	}, BOOT_TIMEOUT);

	it('a playerEffect with a hitTag dedupes per human, not once for the whole round', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'mixed-split-bullet-hittag' });
		s.join('A'); s.join('B');
		await s.ready();

		const posA = s.posOf('A');
		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);

		// A hosts; the fabricated AOE bullet sits on A's own tile with a radius wide enough to also
		// reach B one tile away — both humans are in range of the SAME hitTag effect this round.
		// `faction: 'Beast'` for the same reason as the direct-hit test above: a Player-faction bullet
		// is favorable (allied) to a co-op avatar and would never register B as hit at all.
		//
		// playerEffect "GhostHaunt" (a buff, no damage) for the same reason as the direct-hit test
		// above: a damage-type effect is folded into Will for EITHER pipeline by
		// `SwapSession._reconcilePeers`'s pre-existing avatar-hit mirror, so it cannot tell "hit via the
		// real per-human pipeline" apart from "hit via the enemy path, then mirrored after the fact" —
		// a buff has no such mirror and is therefore the clean signal for per-human hitTag dedup too.
		s._shuffle = () => ['B', 'A'];
		s.world.eval(`(function(){
			KDMapData.Bullets.push({
				spriteID: 'hitTagProbe', x: ${posA.x}, y: ${posA.y}, xx: ${posA.x}, yy: ${posA.y},
				vx: 0, vy: 0, time: 5, born: 0, lifetime: 5,
				bullet: { name: 'hitTagProbe', faction: 'Beast', aoe: 2, damage: { damage: 1, type: 'fire' },
					playerEffect: { name: 'GhostHaunt', hitTag: 'hitTagProbe' }, spell: { power: 1 } },
			});
		})()`);
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		// CONTROL: A, the slot occupant, is hit through the engine's own UNWRAPPED call site — proves
		// the probe's hitTag effect fires at all (liveness) before asking whether B, the swapped-in
		// replay target, ALSO gets through the shared KDPlayerHitBy dedup array.
		expect(bundleHasBuff(s.bundles.get('A'), 'Haunted'),
			'liveness/control: A must take the hitTag effect\'s own buff').toBe(true);
		expect(bundleHasBuff(s.bundles.get('B'), 'Haunted'), 'B must ALSO take the hitTag effect\'s ' +
			'buff — KDPlayerHitBy (a shared, non-blacklisted GLOBAL) is swapped per-human by the real ' +
			'slot switch exactly like any other player state, so the SAME hitTag must not dedupe B out ' +
			'just because A already consumed it this round').toBe(true);
	}, BOOT_TIMEOUT);
});
