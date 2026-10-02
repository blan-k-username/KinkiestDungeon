/**
 * Node-layer (Vitest) acceptance tests for the co-op turn model: one real engine tick per round,
 * hosted by the round's LAST apply, with the player slot switched per enemy before it decides its
 * target — every human still acts simultaneously from the enemy/engine's point of view, and nothing
 * is frozen, skipped or half-run to get there.
 *
 * UAT bug this was written against: "the enemy NPC does two actions per turn. i moved out of his
 * attack, he misses AND tries to attack another cell." Reported from a 2-player co-op session.
 *
 * What a round must cost, regardless of player count, against a 1-player control:
 *   - `KinkyDungeonUpdateEnemies` REAL (unmuted) runs = the 1-player count.
 *   - a given enemy's own action (`KinkyDungeonEnemyLoop`) = exactly once.
 *   - the pure-`world`-verdict systems (per `turn-classification.js`) — jail keys, commander update,
 *     the map tick — each run REAL exactly once. Bullets and effect tiles are classified `mixed` (a
 *     step for the ACTING player alongside their world-wide loop) and are deliberately NOT asserted
 *     here — wholesale-muting them would drop that player step; splitting them is a follow-up.
 *   - the world clock advances by exactly 1.
 *   - an enemy engaged with the NON-host player binds that player for real (through the player
 *     pipeline, not an NPC-style hit on a parked avatar).
 *   - an enemy sees both players' FINAL positions for the round, even when the engaged player applies
 *     last and moves toward it that same round.
 *   - each player's own per-turn effects (`KinkyDungeonItemCheck`) tick exactly once.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

/**
 * Count REAL (unmuted) invocations of a world-shared engine function, alongside the raw call count —
 * the production distinction, not a test-invented proxy: `installTurnModel` mutes a call by returning
 * before it does any work while `globalThis.__kdWorldMuted` is armed, so reading that SAME flag at
 * call time is what "real" means here. A control with the flag never armed (any 1-player round) is
 * what proves this is not vacuous: every call there is real by construction.
 */
function installWorldCallCounters(s: any, names: string[]) {
	s.world.eval(`(function(){
		if (!globalThis.__kdWorldCounterWrapped) globalThis.__kdWorldCounterWrapped = {};
		var names = ${JSON.stringify(names)};
		names.forEach(function(name){
			if (globalThis.__kdWorldCounterWrapped[name]) return;
			var prev = eval(name);
			var wrapped = function(){
				globalThis.__kdWorldCallCounts[name] = (globalThis.__kdWorldCallCounts[name] || 0) + 1;
				if (!globalThis.__kdWorldMuted) {
					globalThis.__kdWorldRealCounts[name] = (globalThis.__kdWorldRealCounts[name] || 0) + 1;
				}
				return prev.apply(this, arguments);
			};
			eval(name + ' = wrapped;');
			globalThis.__kdWorldCounterWrapped[name] = true;
		});
		return true;
	})()`);
	resetWorldCallCounters(s);
}
function resetWorldCallCounters(s: any) {
	s.world.eval('globalThis.__kdWorldCallCounts = {}; globalThis.__kdWorldRealCounts = {};');
}
function realCalls(s: any, name: string): number {
	return s.world.eval(`(globalThis.__kdWorldRealCounts || {})[${JSON.stringify(name)}] || 0`);
}

/** Count real `KinkyDungeonEnemyLoop` invocations for ONE specific enemy id, logging who was swapped
 *  in and where at the moment of each call. */
function installPerEnemyActionCounter(s: any, enemyId: number) {
	s.world.eval(`(function(){
		if (!globalThis.__kdEnemyActionWrapped) {
			var _prev = KinkyDungeonEnemyLoop;
			KinkyDungeonEnemyLoop = function(enemy){
				if (enemy && enemy.id === globalThis.__kdEnemyActionTargetId) {
					globalThis.__kdEnemyActionCalls = (globalThis.__kdEnemyActionCalls || 0) + 1;
					globalThis.__kdEnemyActionLog = globalThis.__kdEnemyActionLog || [];
					globalThis.__kdEnemyActionLog.push({
						playerX: KinkyDungeonPlayerEntity.x, playerY: KinkyDungeonPlayerEntity.y,
					});
				}
				return _prev.apply(this, arguments);
			};
			globalThis.__kdEnemyActionWrapped = true;
		}
		globalThis.__kdEnemyActionTargetId = ${enemyId};
		globalThis.__kdEnemyActionCalls = 0;
		globalThis.__kdEnemyActionLog = [];
		return true;
	})()`);
}
function enemyActionCalls(s: any): number { return s.world.eval('globalThis.__kdEnemyActionCalls') || 0; }
function enemyActionLog(s: any): any[] { return s.world.eval('globalThis.__kdEnemyActionLog') || []; }
function resetPerEnemyActionCounter(s: any) {
	s.world.eval('globalThis.__kdEnemyActionCalls = 0; globalThis.__kdEnemyActionLog = [];');
}

/** Count real `KinkyDungeonItemCheck` invocations — a player-local per-turn effect that must run
 *  exactly once per player per round, never muted (it is not in `WORLD_MUTE_FNS`). */
function installItemCheckCounter(s: any) {
	s.world.eval(`(function(){
		if (!globalThis.__kdItemCheckWrapped) {
			var _prev = KinkyDungeonItemCheck;
			KinkyDungeonItemCheck = function(){
				globalThis.__kdItemCheckCalls = (globalThis.__kdItemCheckCalls || 0) + 1;
				return _prev.apply(this, arguments);
			};
			globalThis.__kdItemCheckWrapped = true;
		}
		globalThis.__kdItemCheckCalls = 0;
		return true;
	})()`);
}
function itemCheckCalls(s: any): number { return s.world.eval('globalThis.__kdItemCheckCalls') || 0; }

/**
 * Put the shared enemy on a tile adjacent to B and re-arm its awareness, BY ID — but only MOVE it if
 * it has drifted away. Repositioning an enemy mid-attack resets its own in-progress attack commitment
 * (`enemy.warningTiles`, computed for a specific tile/direction), so re-pinning it to a possibly
 * DIFFERENT free neighbour every single round — rather than only when it actually wandered off —
 * would never let a multi-tick attack (telegraph, then land) complete. Staying adjacent is left alone.
 */
function pinEnemyNextToB(s: any, enemyId: number) {
	const posB = s.posOf('B');
	const already = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${enemyId}; });
		return e ? (Math.max(Math.abs(e.x - ${posB.x}), Math.abs(e.y - ${posB.y})) === 1) : false;
	})()`);
	if (!already) {
		const nb = freeNeighbour(s, 'B');
		if (!nb) throw new Error('setup invalid: no free tile beside B');
		s.world.moveAvatar(enemyId, nb.x, nb.y);
	}
	s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${enemyId}; });
		if (e) { e.aware = true; e.hostile = 9999; e.gx = ${posB.x}; e.gy = ${posB.y}; }
		KDUpdateEnemyCache = true;
	})()`);
}

/** A free tile at least `min` (Chebyshev) from `from` — found, never assumed. */
function farTile(s: any, from: { x: number, y: number }, min: number) {
	return s.world.eval(`(function(){
		for (var r = ${min | 0}; r < ${min | 0} + 30; r++)
			for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				var x = ${from.x | 0} + dx, y = ${from.y | 0} + dy;
				if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y)) return { x: x, y: y };
			}
		return null;
	})()`);
}

function restraintsOf(s: any, id: string): number {
	s.world.restorePlayer(s.bundles.get(id));
	return s.world.getVitals().restraints | 0;
}

// `KinkyDungeonUpdateEnemies` gets its own dedicated wrap (the slot switch) regardless of its
// `mixed` verdict in `turn-classification.js` — its per-enemy decision loop must still run exactly
// once per round; what remains `mixed` about it (player-only pre/post code) is a separate, tracked
// residual. The other three are the ACTUAL `WORLD_MUTE_FNS` contents — pure `world` verdict, derived
// from the same table `headless-host.js` derives from, not re-asserted independently here.
const WORLD_FN_NAMES = [
	'KinkyDungeonUpdateEnemies', 'KinkyDungeonUpdateJailKeys', 'KDCommanderUpdate', 'KDTickMaps',
];

describe('one engine tick per round', () => {
	/** The 1-player baseline every world-shared system's REAL per-round call count must match,
	 *  regardless of player count — some (e.g. `KinkyDungeonUpdateEnemies`, allied + hostile pass)
	 *  are legitimately > 1 even for a single real engine turn. */
	async function soloBaseline() {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'enemy-once-solo', enemyType: 'Rat' });
		solo.join('A');
		await solo.ready();
		installWorldCallCounters(solo, WORLD_FN_NAMES);
		installPerEnemyActionCounter(solo, solo.enemyId);
		const t0 = solo.tick();
		solo.submit('A', { kind: 'wait' });
		const counts: Record<string, number> = {};
		for (const name of WORLD_FN_NAMES) counts[name] = realCalls(solo, name);
		return { counts, enemyActs: enemyActionCalls(solo), tick: solo.tick() - t0 };
	}

	it('control: a 1-player round\'s own counts are internally consistent (liveness)', async () => {
		const base = await soloBaseline();
		// Liveness: every world system the duo test checks must have been seen running for real at
		// least once in a plain single-player turn, or "matches the baseline" below would be vacuous.
		for (const name of WORLD_FN_NAMES) {
			expect(base.counts[name], `control: ${name} ran for real at least once`).toBeGreaterThan(0);
		}
		expect(base.enemyActs, 'control: the enemy acts once').toBe(1);
		expect(base.tick, 'control: the world clock advances by 1').toBe(1);
	}, BOOT_TIMEOUT);

	it('a 2-player round costs exactly the 1-player baseline, not once per player', async () => {
		const base = await soloBaseline();

		const s = new SwapSession({ requiredPlayers: 2, seed: 'enemy-once-duo', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		installWorldCallCounters(s, WORLD_FN_NAMES);
		installPerEnemyActionCounter(s, s.enemyId);
		const t0 = s.tick();

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		for (const name of WORLD_FN_NAMES) {
			expect(realCalls(s, name),
				`${name} must run for real exactly the 1-player count per round, not once per player`)
				.toBe(base.counts[name]);
		}
		expect(enemyActionCalls(s),
			'a session ROUND must update a given enemy exactly once, regardless of how many players ' +
			'are seated — not once per player').toBe(1);
		expect(s.tick() - t0, 'the world clock must advance by exactly 1 per round').toBe(1);
	}, BOOT_TIMEOUT);

	it('sees the FINAL positions of the round, even when the engaged player applies LAST', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'enemy-once-final-pos', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		installPerEnemyActionCounter(s, s.enemyId);

		// A is far away and irrelevant. B starts a few tiles from the enemy and MOVES toward it this
		// round — the engaged enemy's one action must see where B ENDED UP, not where B started.
		const avA = s.avatars.get('A');
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval('(function(){ KinkyDungeonPlayerEntity.x = 2; KinkyDungeonPlayerEntity.y = 2; })()');
		s.bundles.set('A', s.world.capturePlayer());
		s.world.moveAvatar(avA, 2, 2);

		const enemyPos = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${s.enemyId}; });
			return e ? { x: e.x, y: e.y } : null;
		})()`);
		// Put B two tiles from the enemy (not adjacent yet) and force awareness so engagement picks B.
		s.world.restorePlayer(s.bundles.get('B'));
		const bStart = { x: enemyPos.x + 2, y: enemyPos.y };
		s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${bStart.x}; KinkyDungeonPlayerEntity.y = ${bStart.y}; })()`);
		s.bundles.set('B', s.world.capturePlayer());
		s.world.moveAvatar(s.avatars.get('B'), bStart.x, bStart.y);
		s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${s.enemyId}; });
			if (e) { e.aware = true; e.hostile = 9999; e.gx = ${bStart.x}; e.gy = ${bStart.y}; }
			KDUpdateEnemyCache = true;
		})()`);

		// Fix the order so B applies LAST (hosts the round's one real tick), and have B step one tile
		// toward the enemy this round.
		s._shuffle = () => ['A', 'B'];
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'move', dx: enemyPos.x > bStart.x ? 1 : -1, dy: 0 });

		expect(enemyActionCalls(s), 'the engaged enemy must still act exactly once').toBe(1);
		const log = enemyActionLog(s);
		expect(log.length, 'liveness: the action log must have captured the one call').toBe(1);
		// B's final position this round (after their own move) — NOT bStart.
		const bFinal = s.posOf('B');
		expect(bFinal).not.toEqual(bStart);
		expect({ x: log[0].playerX, y: log[0].playerY },
			"the enemy's one action must see B's FINAL position, not B's position before B's own move")
			.toEqual(bFinal);
	}, BOOT_TIMEOUT);

	it('an enemy engaged with B ONLY still binds B through the real player pipeline', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'enemy-once-bind', enemyType: 'NawashiZombie' });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId, 'setup: the binding enemy exists').not.toBeNull();

		const posB = s.posOf('B');
		const far = farTile(s, posB, 12);
		expect(far, 'setup: a tile far from B').not.toBeNull();
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${far.x}; KinkyDungeonPlayerEntity.y = ${far.y}; })()`);
		s.bundles.set('A', s.world.capturePlayer());
		s.world.moveAvatar(s.avatars.get('A'), far.x, far.y);

		const nb = freeNeighbour(s, 'B');
		expect(nb, 'setup: a free tile beside B').not.toBeNull();
		s.world.moveAvatar(s.enemyId, nb.x, nb.y);
		s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${s.enemyId}; });
			e.aware = true; e.hostile = 9999; KDUpdateEnemyCache = true;
		})()`);

		installPerEnemyActionCounter(s, s.enemyId);
		let roundsRun = 0;
		let enemyActs = 0;
		for (let r = 1; r <= 30; r++) {
			resetPerEnemyActionCounter(s);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			roundsRun = r;
			enemyActs += enemyActionCalls(s);
			if (restraintsOf(s, 'B') > 0) break;
		}
		const log = enemyActionLog(s);

		expect(enemyActs, 'the enemy acts once per round').toBe(roundsRun);
		expect(log[0] && log[0].playerX, 'the enemy faced a REAL player slot, not an avatar').not.toBeUndefined();
		expect(restraintsOf(s, 'B'), 'B wears a restraint the enemy put on them through the real pipeline')
			.toBeGreaterThan(0);
		expect(restraintsOf(s, 'A'), 'nothing leaked onto A').toBe(0);
	}, BOOT_TIMEOUT);

	it("does not double-tick a player's own per-turn effects", async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'enemy-once-no-double-tick', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		installItemCheckCounter(s);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		// Once per player's OWN apply, never again during the round's one real world tick, which does
		// not re-run anyone's per-turn effects a second time.
		expect(itemCheckCalls(s),
			"a player-local per-turn effect must tick once per player per round, not twice").toBe(2);
	}, BOOT_TIMEOUT);

	it('a REAL enemy beside B is pinned and re-armed every round without ever double-acting', async () => {
		// Regression for the exact reported shape: a telegraphing melee enemy kept adjacent and
		// re-armed every round must still act exactly once per round over many rounds, never twice.
		const s = new SwapSession({ requiredPlayers: 2, seed: 'enemy-once-sustained', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		installPerEnemyActionCounter(s, s.enemyId);

		for (let r = 1; r <= 10; r++) {
			resetPerEnemyActionCounter(s);
			pinEnemyNextToB(s, s.enemyId);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			expect(enemyActionCalls(s), `round ${r}: exactly one action`).toBe(1);
		}
	}, BOOT_TIMEOUT);
});
