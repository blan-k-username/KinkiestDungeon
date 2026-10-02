/**
 * Node-layer (Vitest) acceptance tests for routing an ENGINE-TRIGGERED defeat to the right human
 * under the co-op turn model's per-enemy slot switch.
 *
 * THE BUG. `KDRunDefeatForEnemy` (`KinkyDungeonEnemies.ts:5070`, called from the end of the round's
 * one unmuted `KinkyDungeonUpdateEnemies` pass, and again as a backstop at the end of
 * `KinkyDungeonAdvanceTime` itself) finalises a defeat with whoever currently holds the player slot
 * at that moment — not necessarily the human the DEFEATING enemy actually faced. The per-enemy slot
 * switch (the one-world-tick-per-round turn model) regroups enemies by their chosen human and processes them group
 * by group, so once the defeating enemy's own group has been processed, a LATER group (engaged with
 * a different human) can pull the slot away before the end-of-pass defeat check ever runs. The round's
 * HOST (the apply that drives the real engine tick) is always the highest-ranked group and therefore
 * always processed last, so a defeat caused by a host-engaged enemy already lands correctly by
 * construction — the broken case needs a SECOND enemy, engaged with the host, processed after the
 * first one, to pull the slot away from the actually-defeated non-host player.
 *
 * MEASURED: the "host defeated" half of this pair is GREEN even before any fix — the host is always
 * the highest-ranked group (it is literally the round's last apply) so its own engaged enemies are
 * always the LAST group the per-pass sort processes, which is exactly what the end-of-pass defeat
 * check reads. It stays in this file as a symmetry / non-regression guard on the fix below, not as a
 * second repro of the bug — the suite is still "red first" as a whole (the non-host case is red).
 *
 * ORACLE. `KDGameData.TimesJailed` is incremented by the real `KinkyDungeonDefeat`
 * (`KinkyDungeonJail.ts:1639-1640`) on BOTH its branches (jailed or held in place) — exactly the
 * signal `mp-coop-capture-held.spec.ts` already reads for "did a real capture land on this human".
 * Read off each player's own captured bundle, never the live world (which ends a round parked on
 * whoever is host).
 *
 * WHAT IS FAKED, AND WHY. Reproducing a genuine leash-to-jail defeat deterministically (the real
 * trigger for `ret.defeat`) needs a multi-tick chase that is not what this bug is about. Instead,
 * `KinkyDungeonEnemyLoop` is wrapped to override only the RETURNED `defeat`/`defeatEnemy` fields for
 * one chosen enemy, one shot — every other field (idle, etc.) stays exactly what the real engine
 * computed. Everything downstream of that flag (`KDCustomDefeatEnemy`, `KDRunDefeatForEnemy`,
 * `KDRunRegularJailDefeatAttempt`, `KinkyDungeonDefeat`) runs for real. `KDRunRegularJailDefeatAttempt`
 * is additionally stubbed to return `true` immediately — it only decides WHICH jail room a capture
 * goes to (a real floor move, irrelevant to "which human"), not WHO is defeated; `mp-coop-capture-held`
 * already covers that decision in isolation.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

/** `KDGameData.TimesJailed` off a player's own captured bundle — 0 if never jailed. */
function timesJailed(s: any, cid: string): number {
	const b = s.bundles.get(cid);
	return (b && b.gameData && b.gameData.TimesJailed) || 0;
}

/**
 * Force exactly ONE enemy's next real `KinkyDungeonEnemyLoop` call to report a defeat, without
 * changing anything else that call computes. One-shot: clears itself once consumed, so a later round
 * (or a different enemy) is never affected by accident.
 */
function armForcedDefeat(s: any, enemyId: number) {
	s.world.eval(`(function(){
		if (!globalThis.__kdForceDefeatWrapped) {
			var _prev = KinkyDungeonEnemyLoop;
			KinkyDungeonEnemyLoop = function(enemy){
				var ret = _prev.apply(this, arguments);
				if (enemy && enemy.id === globalThis.__kdForceDefeatEnemyId) {
					globalThis.__kdForceDefeatEnemyId = null;
					return Object.assign({}, ret, { defeat: true, defeatEnemy: enemy });
				}
				return ret;
			};
			globalThis.__kdForceDefeatWrapped = true;
		}
		globalThis.__kdForceDefeatEnemyId = ${enemyId};
		return true;
	})()`);
}

/** Stub `KDRunRegularJailDefeatAttempt` to succeed immediately — room selection is not under test. */
function stubJailRoomSelection(s: any) {
	s.world.eval(`(function(){
		if (globalThis.__kdStubJailAttempt) return true;
		var _prev = KDRunRegularJailDefeatAttempt;
		KDRunRegularJailDefeatAttempt = function(){ return true; };
		KDRunRegularJailDefeatAttempt.__kdStubOriginal = _prev;
		globalThis.__kdStubJailAttempt = true;
		return true;
	})()`);
}

/**
 * Move `cid`'s own player entity (bundle + avatar) to (x,y) directly. Needed before placing the two
 * engagement-test enemies: the party spawns adjacent, so two enemies each "beside" a different
 * player are still a near-tie for BOTH players' distance, and a tie keeps whichever human was
 * checked FIRST (`__kdSlotChoose`'s `<` comparison) regardless of which one is actually closer.
 */
function moveClientTo(s: any, cid: string, x: number, y: number) {
	s.world.restorePlayer(s.bundles.get(cid));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0}; })()`);
	s.bundles.set(cid, s.world.capturePlayer());
	s.world.moveAvatar(s.avatars.get(cid), x, y);
}

/** A free tile at least `min` (Chebyshev) steps from `from` — found, never assumed. */
function farTile(s: any, from: { x: number, y: number }, min: number) {
	return s.world.eval(`(function(){
		for (var r = ${min | 0}; r < ${min | 0} + 30; r++)
			for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				var x = ${from.x | 0} + dx, y = ${from.y | 0} + dy;
				if (x <= 0 || y <= 0 || x >= KDMapData.GridWidth || y >= KDMapData.GridHeight) continue;
				if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y)) return { x: x, y: y };
			}
		return null;
	})()`);
}

/** Place a REAL shared enemy (by id) on a free tile beside `cid`, so "nearest" engagement picks them. */
function placeEnemyBeside(s: any, enemyId: number, cid: string) {
	const nb = freeNeighbour(s, cid);
	if (!nb) throw new Error(`setup invalid: no free tile beside ${cid}`);
	s.world.moveAvatar(enemyId, nb.x, nb.y);
}

/**
 * Summon a SECOND real enemy near (x,y) — direct `KinkyDungeonSummonEnemy`, not
 * `HeadlessHost.summonEnemy`'s convenience wrapper. The wrapper hardcodes `goToTarget: true,
 * pathfind: true`, which paths every candidate spawn tile to `KinkyDungeonTargetX/Y` — valid at
 * session boot (still near the party's landing spot) but stale afterwards (measured: `{1,1}`,
 * usually unreachable from a spawn tile), so every one of its 30 placement attempts fails and it
 * silently returns the LAST existing entity instead of a new one. Not a product bug (nothing in the
 * session calls it a second time) — just the wrong tool for a second mid-test spawn. `goToTarget:
 * false, pathfind: false` needs no path at all for a stationary spawn.
 */
function summonSecondEnemy(s: any, x: number, y: number, type: string): number {
	const id = s.world.eval(`(function(){
		var created = KinkyDungeonSummonEnemy(${x | 0}, ${y | 0}, ${JSON.stringify(type)}, 1, 6,
			false, undefined, false, false, "Beast", true, 1, true, true, undefined, false);
		return created.length ? created[0].id : null;
	})()`);
	if (id == null) throw new Error(`setup invalid: could not summon a second ${type} near (${x},${y})`);
	return id;
}

describe('an engine-triggered defeat lands on the human the enemy faced', () => {
	it('an enemy engaged with the NON-host player defeats them, not the host', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'defeat-routing-nonhost', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

		// B applies FIRST (non-host, muted apply); A applies LAST (host, drives the real tick) — so
		// the host's own engaged enemy is grouped and processed AFTER B's, which is the one condition
		// that can pull the slot away from B before the end-of-pass defeat check.
		s._shuffle = () => ['B', 'A'];

		// Pull A far away first — the party spawns adjacent, so two enemies each "beside" a
		// different player would otherwise be a near-tie for BOTH players' distance.
		const far = farTile(s, s.posOf('B'), 12);
		expect(far, 'setup: a tile far from B').not.toBeNull();
		moveClientTo(s, 'A', far.x, far.y);

		placeEnemyBeside(s, s.enemyId, 'B');
		const secondId = summonSecondEnemy(s, s.posOf('A').x, s.posOf('A').y, 'Rat');
		placeEnemyBeside(s, secondId, 'A');

		armForcedDefeat(s, s.enemyId);
		stubJailRoomSelection(s);

		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		expect(timesJailed(s, 'B'), 'B — the human the defeating enemy actually faced — is defeated')
			.toBe(1);
		expect(timesJailed(s, 'A'), 'the host must NOT inherit a defeat that was not theirs').toBe(0);
	}, BOOT_TIMEOUT);

	it('symmetric: an enemy engaged with the HOST defeats them, and only them', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'defeat-routing-host', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

		// A applies FIRST (non-host); B applies LAST (host, drives the real tick) — the defeat is
		// forced on the enemy engaged with B, the host. The host's own group is always processed
		// last by construction, so this is also the symmetry/non-regression half of the pair: it
		// must stay green across the fix, not just end up green by it.
		s._shuffle = () => ['A', 'B'];

		// Pull A far away first — see the non-host test above for why.
		const far = farTile(s, s.posOf('B'), 12);
		expect(far, 'setup: a tile far from B').not.toBeNull();
		moveClientTo(s, 'A', far.x, far.y);

		placeEnemyBeside(s, s.enemyId, 'B');
		const secondId = summonSecondEnemy(s, s.posOf('A').x, s.posOf('A').y, 'Rat');
		placeEnemyBeside(s, secondId, 'A');

		armForcedDefeat(s, s.enemyId);
		stubJailRoomSelection(s);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(timesJailed(s, 'B'), 'the host — the human the defeating enemy actually faced — is defeated')
			.toBe(1);
		expect(timesJailed(s, 'A'), 'the non-host must NOT inherit the host\'s defeat').toBe(0);
	}, BOOT_TIMEOUT);

	it('control: neither player is defeated when no enemy reports a defeat', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'defeat-routing-control', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(timesJailed(s, 'A'), 'control: nobody is defeated').toBe(0);
		expect(timesJailed(s, 'B'), 'control: nobody is defeated').toBe(0);
	}, BOOT_TIMEOUT);
});
