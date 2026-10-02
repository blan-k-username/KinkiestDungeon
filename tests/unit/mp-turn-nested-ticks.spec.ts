/**
 * Node-layer (Vitest) acceptance tests for nested ticks — removing the one-round delay the turn
 * model's own design notes accepted for v1 (design B step 7).
 *
 * THE REMAINING ASYMMETRY. A round applies every joined human's own input, then runs ONE real engine
 * tick, hosted by the round's LAST apply, with the player slot switched per enemy so every human can
 * still be engaged through the real player pipeline. For a human who does NOT host that one real tick,
 * their own per-turn tail — everything `KinkyDungeonAdvanceTime` runs AFTER the enemy/bullet passes
 * (`KinkyDungeonUpdateStats`, `KinkyDungeonHandleMoveToTile`, delayed actions, flags, …) — already ran
 * earlier in the SAME round, during their own (muted) apply, before the round's one real tick existed.
 * So the player-local consequences of being hit this round (a derived stat recomputed from current
 * restraints, for instance) only show up in THAT human's bundle on their NEXT round's own apply — one
 * round later than single-player.
 *
 * THE ORACLE. `KDGameData.Restriction` (`KinkyDungeonStats.ts`, inside `KinkyDungeonUpdateStats`) is
 * written in exactly one place, derived fresh from whatever restraints are currently worn, every time
 * `KinkyDungeonUpdateStats` runs. It is a clean "player-pipeline effect only visible after end-of-turn
 * processing" — unlike raw Will, which `_reconcilePeers` folds in from avatar damage regardless of
 * whose tail ran when (a previously-found vacuous-oracle trap), nothing but `KinkyDungeonUpdateStats`
 * itself ever touches `KDGameData.Restriction`, so its value is a direct read of "did my own post-enemy
 * tail run against the CURRENT (post-hit) restraint state yet, or not".
 *
 * THE FIX UNDER TEST. Nested ticks: a non-last apply's own dispatch, on reaching the engine's first
 * per-round world call (the `KinkyDungeonUpdateEnemies` hook `installTurnModel` already wraps), hands
 * control to the NEXT player's own apply before continuing — recursively, down to the round's last
 * apply, which hosts the real tick as before. Unwinding back out restores each human's own state and
 * lets their own tail run, now AFTER the real tick, in engine order — the same "I act, the world acts,
 * my own turn finishes" order single-player already guarantees for the host.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

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

/** `KDGameData.Restriction` off a player's own captured bundle — the end-of-turn-only oracle. */
function restrictionOf(s: any, id: string): number {
	const b = s.bundles.get(id);
	return (b && b.gameData && b.gameData.Restriction) || 0;
}

function placeFar(s: any, id: string, pos: { x: number, y: number }) {
	s.world.restorePlayer(s.bundles.get(id));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${pos.x}; KinkyDungeonPlayerEntity.y = ${pos.y}; })()`);
	s.bundles.set(id, s.world.capturePlayer());
	s.world.moveAvatar(s.avatars.get(id), pos.x, pos.y);
}

function pinEnemyBeside(s: any, enemyId: number, cid: string) {
	const nb = freeNeighbour(s, cid);
	if (!nb) throw new Error(`setup invalid: no free tile beside ${cid}`);
	s.world.moveAvatar(enemyId, nb.x, nb.y);
	s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${enemyId}; });
		if (e) { e.aware = true; e.hostile = 9999; }
		KDUpdateEnemyCache = true;
	})()`);
}

/** Run rounds (whichever order the caller armed via `_shuffle`) until B wears a restraint, or give
 *  up. The enemy is pinned ONCE before the loop, not every round — repositioning mid-attack resets
 *  its in-progress attack commitment (`enemy.warningTiles`) and a multi-tick attack would never land. */
function runUntilBound(s: any, enemyId: number, maxRounds: number): number {
	pinEnemyBeside(s, enemyId, 'B');
	let roundsRun = 0;
	for (let r = 1; r <= maxRounds; r++) {
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		roundsRun = r;
		if (restraintsOf(s, 'B') > 0) break;
	}
	return roundsRun;
}

/** Count real `KinkyDungeonUpdateStats` invocations — part of the per-turn TAIL, must run exactly
 *  once per player per round regardless of nesting depth. */
function installUpdateStatsCounter(s: any) {
	s.world.eval(`(function(){
		if (!globalThis.__kdUpdateStatsWrapped) {
			var _prev = KinkyDungeonUpdateStats;
			KinkyDungeonUpdateStats = function(){
				globalThis.__kdUpdateStatsCalls = (globalThis.__kdUpdateStatsCalls || 0) + 1;
				return _prev.apply(this, arguments);
			};
			globalThis.__kdUpdateStatsWrapped = true;
		}
		globalThis.__kdUpdateStatsCalls = 0;
		return true;
	})()`);
}
function updateStatsCalls(s: any): number { return s.world.eval('globalThis.__kdUpdateStatsCalls') || 0; }

describe('nested ticks remove the non-host one-round delay', () => {
	it('a non-host human sees the consequence of being hit in the SAME round, not the next one', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'nested-tick-nonhost', enemyType: 'NawashiZombie' });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId, 'setup: the binding enemy exists').not.toBeNull();

		// B always applies FIRST (never hosts the round's one real tick); A always applies LAST (hosts).
		s._shuffle = () => ['B', 'A'];
		const far = farTile(s, s.posOf('B'), 12);
		expect(far, 'setup: a tile far from B').not.toBeNull();
		placeFar(s, 'A', far);

		const roundsRun = runUntilBound(s, s.enemyId, 30);
		expect(restraintsOf(s, 'B'), 'setup: B really got bound within 30 rounds').toBeGreaterThan(0);

		// The bind landed IN the round that just ran (`roundsRun`), through B's own real player
		// pipeline, while B never hosted. B's own `KDGameData.Restriction` — written only inside
		// `KinkyDungeonUpdateStats`, part of the post-enemy tail — must already reflect the new
		// restraint by the END of this SAME round, not B's next one.
		expect(roundsRun, 'sanity: the loop actually ran at least one round').toBeGreaterThan(0);
		expect(restrictionOf(s, 'B'),
			"B's own post-enemy derived stat must reflect the NEW restraint within the SAME round " +
			'it was applied, not one round later').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('symmetric: the host\'s own case is unchanged — already correct before this fix', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'nested-tick-host', enemyType: 'NawashiZombie' });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId, 'setup: the binding enemy exists').not.toBeNull();

		// B always applies LAST (hosts the round's one real tick) and is the one the enemy engages.
		s._shuffle = () => ['A', 'B'];
		const far = farTile(s, s.posOf('B'), 12);
		expect(far, 'setup: a tile far from A').not.toBeNull();
		placeFar(s, 'A', far);

		const roundsRun = runUntilBound(s, s.enemyId, 30);
		expect(restraintsOf(s, 'B'), 'setup: B really got bound within 30 rounds').toBeGreaterThan(0);
		expect(roundsRun, 'sanity: the loop actually ran at least one round').toBeGreaterThan(0);
		expect(restrictionOf(s, 'B'),
			"the host's own derived stat was already correct within the same round before this fix " +
			'— must stay correct').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it("each player's own per-turn tail still ticks exactly once per round, never doubled by nesting", async () => {
		// `KinkyDungeonUpdateStats` is called TWICE inside one real `KinkyDungeonAdvanceTime`
		// (`KinkyDungeonGame.ts`: once with the real delta, once more with 0) — a 1-player round's
		// own count is the baseline every joined human's own apply must cost exactly once more of,
		// never doubled by the nested-dispatch mechanism re-entering the same apply twice.
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'nested-tick-once-solo', enemyType: 'Rat' });
		solo.join('A');
		await solo.ready();
		installUpdateStatsCounter(solo);
		solo.submit('A', { kind: 'wait' });
		const perPlayerBaseline = updateStatsCalls(solo);
		expect(perPlayerBaseline, 'liveness: the control itself calls KinkyDungeonUpdateStats')
			.toBeGreaterThan(0);

		const s = new SwapSession({ requiredPlayers: 2, seed: 'nested-tick-once', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		installUpdateStatsCounter(s);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(updateStatsCalls(s),
			"each joined human's own post-enemy tail must cost exactly the 1-player baseline, " +
			'not more — nesting must never re-enter the same apply twice').toBe(perPlayerBaseline * 2);
	}, BOOT_TIMEOUT);
});
