/**
 * Node-layer (Vitest) — enemy noise generated while the per-enemy slot switch has put the NON-HOST
 * human in the slot (one real tick per round, design B) must still reach THAT human, exactly once.
 *
 * CONTEXT. `tests/e2e/mp-presentation-once.spec.ts` ("ripples draw once per event…") fails on real
 * browsers: "real snapshots must still queue ripples — otherwise the assertions below are vacuous",
 * received 0. That e2e spec always instruments and checks client A while cycling the shared enemy
 * through tiles chosen relative to A's own position — so if the per-enemy slot switch (armed only
 * around the round's one real `KinkyDungeonUpdateEnemies` call, `headless-host.js`'s `installTurnModel`)
 * ever decides a DIFFERENT human than A is nearest, or A is not hosting the round's one real tick, the
 * noise is attributed elsewhere and A sees nothing. This is a NODE-LEVEL reproduction of that same
 * shape, pinned so it cannot depend on turn order or which human the round's host happens to be: B is
 * forced NON-host (applies first, muted + nested) and the enemy is forced to engage B specifically
 * (`placeEnemyBeside`-style, but far enough to stay out of sight so the noise/ripple path, not just the
 * alert path, fires — see `KinkyDungeonEnemies.ts:9607`, `KDEnemyAddSound`).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

/** A noise event that actually carries a ripple / echo to draw (an empty one only CLEARS). */
const isShock = (e: any) => !!e && e.kind === 'noise'
	&& (((e.shockwaves || []).length + (e.sounddesc || []).length) > 0);

/** Move a joined player's authoritative position (bundle + avatar) to (x,y) directly. */
function moveClientTo(s: any, cid: string, x: number, y: number) {
	s.world.restorePlayer(s.bundles.get(cid));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0}; })()`);
	s.bundles.set(cid, s.world.capturePlayer());
	s.world.moveAvatar(s.avatars.get(cid), x, y);
}

/** Free tiles between `min` and `max` Chebyshev steps from (x0,y0) — out-of-sight noise candidates. */
function tilesAround(s: any, x0: number, y0: number, min: number, max: number) {
	return s.world.eval(`(function(){
		var out = [];
		for (var dx = -${max}; dx <= ${max}; dx++) for (var dy = -${max}; dy <= ${max}; dy++) {
			var d = Math.max(Math.abs(dx), Math.abs(dy));
			if (d < ${min} || d > ${max}) continue;
			var x = ${x0} + dx, y = ${y0} + dy;
			if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y)) {
				out.push({x: x, y: y});
			}
		}
		return out;
	})()`) || [];
}

describe('per-enemy slot switch: noise reaches the engaged NON-HOST human', () => {
	it('an enemy engaged with the non-host human delivers its noise to that human, not the host', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'noise-nonhost-slot', enemyType: 'Rat', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

		// B applies FIRST (muted, nested); A applies LAST (hosts the round's one real tick).
		s._shuffle = () => ['B', 'A'];

		// Keep A far away so "nearest human" is unambiguous, and cycle the enemy through tiles
		// around B that are free and out of sight — same recipe as the e2e repro, pinned to B.
		const farFromB = tilesAround(s, s.posOf('B').x, s.posOf('B').y, 20, 20)[0]
			|| (() => { const nb = freeNeighbour(s, 'B'); return nb ? { x: nb.x + 15, y: nb.y } : null; })();
		if (farFromB) moveClientTo(s, 'A', farFromB.x, farFromB.y);

		const spots = tilesAround(s, s.posOf('B').x, s.posOf('B').y, 6, 10);
		expect(spots.length, 'precondition: somewhere to put an unseen enemy near B').toBeGreaterThan(0);

		let bEvents: any[] = [];
		let aEvents: any[] = [];
		for (let i = 0; i < 24 && !bEvents.length; i++) {
			const spot = spots[(i * 7) % spots.length];
			s.world.moveAvatar(s.enemyId, spot.x, spot.y);
			s.submit('B', { kind: 'wait' });
			s.submit('A', { kind: 'wait' });
			bEvents = (s.snapshotFor('B').events || []).filter(isShock);
			aEvents = (s.snapshotFor('A').events || []).filter(isShock);
		}

		// ANTI-DELETION: assert FIRST — otherwise "B got none" could just mean nothing ever fired.
		expect(bEvents.length, 'the engaged non-host human must receive the noise her enemy made')
			.toBeGreaterThan(0);
		// Control: the far-away host must not ALSO get a copy of a ripple that was never near them —
		// pairs the "did not happen" read with proof the same probe CAN see it happen (above).
		expect(aEvents.length, 'the far-away host must not receive a ripple that happened near B').toBe(0);
	}, BOOT_TIMEOUT);
});
