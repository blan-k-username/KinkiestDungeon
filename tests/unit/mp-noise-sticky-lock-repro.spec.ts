/**
 * Node-layer (Vitest) — DIAGNOSTIC: the per-enemy sticky target must be gated on REAL engagement
 * (`enemy.aware`), not on a cached distance comparison.
 *
 * `swap-session.js`'s own doc comment (`_advanceTurn`) describes the per-enemy slot switch as
 * choosing "its own sticky current target, ELSE nearest by that round's FINAL positions". The first
 * fix attempt read that as "keep sticky while its distance is still the best (or close to best)" —
 * but with this codebase's own co-op spawn (A and B start ADJACENT, one tile apart —
 * tests/e2e/helpers/coop.ts), EVERY free tile in a 6-10 tile ring around either human ties in
 * Chebyshev distance to BOTH of them (measured directly: 45 of 45 candidate tiles around A tied
 * exactly with B's own distance too). A tie-honouring rule therefore reduces to "whichever human the
 * FIRST round's tie-break happened to favour, forever" — the exact same permanent-lock bug, just
 * hidden behind a distance comparison that is always a tie in practice. This is why the e2e repro
 * (tests/e2e/mp-presentation-once.spec.ts) could cycle an idle, non-chasing Rat through 24 spots near
 * A and still deliver zero ripples to A.
 *
 * The actual fix: `headless-host.js`'s `__kdSlotChoose` now only consults the sticky map while
 * `enemy.aware` is true — KD's own flag for "this enemy is actively tracking/chasing a target". An
 * unaware/ambient enemy (any out-of-sight noise, including a Rat cycled through a ring of ties) has
 * no engagement to protect and always uses the freshly computed nearest human, whose natural
 * tie-break (first in that round's own roster order) genuinely varies with the turn shuffle. An AWARE
 * enemy mid-chase keeps its sticky target regardless of a one-tile distance wobble — that is the real
 * anti-flicker case this mechanism exists for.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { tilesAtRange, freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

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

/** Move a joined player's authoritative position (bundle + avatar) to (x,y) directly. */
function moveClientTo(s: any, cid: string, x: number, y: number) {
	s.world.restorePlayer(s.bundles.get(cid));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0}; })()`);
	s.bundles.set(cid, s.world.capturePlayer());
	s.world.moveAvatar(s.avatars.get(cid), x, y);
}

describe('per-enemy sticky target is gated on real engagement (enemy.aware)', () => {
	it('an unaware enemy (ambient noise, out of sight) re-derives its nearest human every round — it '
		+ 'does not lock onto whichever human won the first round\'s distance tie', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'sticky-lock-diag', enemyType: 'Rat', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId).not.toBeNull();

		// Out-of-sight range (6-10 tiles), same recipe as the e2e repro and `tilesAtRange`'s own doc
		// comment — adjacency would trigger KD's real vision/aggro and make the enemy genuinely
		// `aware`, which is the OTHER test below, not this one.
		const spots = tilesAtRange(s, 'B', 6, 10);
		expect(spots.length, 'precondition: somewhere out of sight near B').toBeGreaterThan(0);

		let sawB = false;
		let sawA = false;
		let everAware = false;
		for (let i = 0; i < 24 && !(sawA && sawB); i++) {
			const spot = spots[(i * 7) % spots.length];
			s.world.moveAvatar(s.enemyId, spot.x, spot.y);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			if (s.enemyView().aware) everAware = true;
			const log = s.world.slotChoiceLog() || {};
			const who = log[String(s.enemyId)];
			if (who === 'B') sawB = true;
			if (who === 'A') sawA = true;
		}
		expect(everAware, 'setup: this probe only means something while the enemy stays unaware').toBe(false);
		console.log('[diag] sawB', sawB, 'sawA', sawA);
		// A real per-round re-derivation's tie-break naturally varies with the turn shuffle, so BOTH
		// humans must win at least one of these 24 rounds — proof this is NOT the old permanent lock
		// (which would show one of them false for all 24 rounds, as the first fix attempt still did).
		expect(sawB, 'an exact-tie ambient enemy must be attributed to B at least once').toBe(true);
		expect(sawA, 'an exact-tie ambient enemy must be attributed to A at least once too').toBe(true);
	}, BOOT_TIMEOUT);

	it('an AWARE (actively engaged) enemy keeps its sticky target even when another human becomes '
		+ 'just as close — the real anti-flicker case this mechanism exists for', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'sticky-lock-diag-2', enemyType: 'Rat', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();

		// Separate A and B first (the default spawn is adjacent, which would tie this setup the same
		// way it ties the ambient case above) so "engaged with A" is unambiguous.
		const far = farTile(s, s.posOf('B'), 12);
		expect(far, 'setup: a tile far from B').not.toBeNull();
		moveClientTo(s, 'A', far.x, far.y);

		// Place the enemy next to A and establish A as its sticky target.
		const nbA = freeNeighbour(s, 'A');
		expect(nbA, 'setup: a free tile beside A').not.toBeNull();
		s.world.moveAvatar(s.enemyId, nbA.x, nbA.y);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const firstLog = s.world.slotChoiceLog() || {};
		expect(firstLog[String(s.enemyId)], 'setup: engaged with A').toBe('A');

		// FORCE the demo "Rat" (a passive, non-aggressive type that rarely raises its own `aware`
		// flag organically) into the real-engagement state this gating exists for, directly on the
		// live entity — the same "poke one KD field, let the rest of the pipeline run for real"
		// technique `mp-coop-slot-swap-human-context.spec.ts` uses for its own one-shot setup. This
		// tests OUR gating logic's response to `aware`, not KD's own aggression algorithm for Rats.
		const isAware = () => s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${s.enemyId}; });
			return !!(e && e.aware);
		})()`);
		s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${s.enemyId}; });
			if (e) e.aware = true;
			return true;
		})()`);
		// listEntities()/enemyView() only projects a fixed, small field set (id/x/y/hp/name/faction) —
		// not `aware` — so check the live engine field directly via eval, not through that projection.
		expect(isAware(), 'setup: enemy is now forced aware').toBe(true);

		// B steps in right onto the enemy's own tile — tied (as close as possible). A genuinely
		// engaged enemy must not ping-pong onto B just because of that.
		moveClientTo(s, 'B', nbA.x, nbA.y);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const secondLog = s.world.slotChoiceLog() || {};
		expect(secondLog[String(s.enemyId)], 'an aware, engaged enemy keeps its target through a tie')
			.toBe('A');
	}, BOOT_TIMEOUT);
});
