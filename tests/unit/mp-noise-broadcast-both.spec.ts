/**
 * Node-layer (Vitest) — MEASUREMENT + regression guard: noise/ripple presentation is WORLD
 * presentation (every player within hearing perceives it in single-player), not per-slot-occupant
 * state. Before design B, each human's own apply ran the enemy pass for real, so BOTH joined players
 * got the noise event every round an enemy made one nearby. Now that enemies only act once, inside
 * the round's one real tick, `_harvestNoise` (swap-session.js) delivers the harvested
 * `KDEventData.shockwaves`/`sounddesc` ONLY to whichever human currently holds the slot — so an
 * unaware, ambient-noise enemy roughly equidistant from both joined humans (ties for who holds the
 * slot each round, per the `enemy.aware`-gated chooser in `headless-host.js`) reaches only ONE of
 * them per round, never both, even though both are within hearing range and out of sight exactly
 * like single-player would deliver to each independently.
 *
 * MEASURED (red, before the fix): over 24 rounds with both A and B within hearing range and out of
 * sight of the same wandering enemy, every round that delivered a ripple delivered it to exactly ONE
 * of the two humans — never both on the same round.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

const isShock = (e: any) => !!e && e.kind === 'noise'
	&& (((e.shockwaves || []).length + (e.sounddesc || []).length) > 0);

/** Chebyshev distance. */
const cheb = (p: any, q: any) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));

/**
 * Free tiles that are simultaneously within [min,max] Chebyshev range of BOTH `a` and `b` — "roughly
 * equidistant and both in hearing/out-of-sight range" candidates, found rather than assumed.
 */
function tilesInRangeOfBoth(s: any, a: { x: number, y: number }, b: { x: number, y: number }, min: number, max: number) {
	return s.world.eval(`(function(){
		var out = [];
		var cx = Math.round((${a.x} + ${b.x}) / 2), cy = Math.round((${a.y} + ${b.y}) / 2);
		var span = ${max} + 4;
		for (var x = cx - span; x <= cx + span; x++) {
			for (var y = cy - span; y <= cy + span; y++) {
				var dA = Math.max(Math.abs(x - ${a.x}), Math.abs(y - ${a.y}));
				var dB = Math.max(Math.abs(x - ${b.x}), Math.abs(y - ${b.y}));
				if (dA < ${min} || dA > ${max} || dB < ${min} || dB > ${max}) continue;
				if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y)) {
					out.push({ x: x, y: y });
				}
			}
		}
		return out;
	})()`) || [];
}

describe('world-presentation noise must reach every human who would perceive it, not just the slot occupant', () => {
	it('an unaware enemy within hearing of BOTH joined humans delivers the ripple to BOTH on the same '
		+ 'round, the same way single-player would deliver it to each independently', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'noise-broadcast-both', enemyType: 'Rat', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
		expect(s.enemyId).not.toBeNull();

		const posA = s.posOf('A'); const posB = s.posOf('B');
		const spots = tilesInRangeOfBoth(s, posA, posB, 6, 10);
		expect(spots.length, 'precondition: somewhere out of sight and in hearing range of both').toBeGreaterThan(0);

		let roundsWithA = 0, roundsWithB = 0, roundsWithBoth = 0, roundsWithEither = 0;
		let everAware = false;
		for (let i = 0; i < 24; i++) {
			const spot = spots[(i * 7) % spots.length];
			s.world.moveAvatar(s.enemyId, spot.x, spot.y);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			if (s.enemyView().aware) everAware = true;
			const gotA = (s.snapshotFor('A').events || []).filter(isShock).length > 0;
			const gotB = (s.snapshotFor('B').events || []).filter(isShock).length > 0;
			if (gotA) roundsWithA++;
			if (gotB) roundsWithB++;
			if (gotA && gotB) roundsWithBoth++;
			if (gotA || gotB) roundsWithEither++;
		}
		console.log('[measure]', JSON.stringify({ roundsWithA, roundsWithB, roundsWithBoth, roundsWithEither, everAware }));

		expect(everAware, 'setup: this probe only means something while the enemy stays unaware').toBe(false);
		// ANTI-DELETION: assert first — otherwise "both got none" is vacuous.
		expect(roundsWithEither, 'real rounds must still produce ripples for at least one human')
			.toBeGreaterThan(0);
		// THE REGRESSION: a human within hearing and out of sight of the SAME ambient noise, on the
		// SAME round, must perceive it too — exactly like single-player would independently deliver
		// it to each of them. Before the fix this was always 0 (one human always "wins" the slot).
		expect(roundsWithBoth, 'both humans must receive at least one ripple on the SAME round')
			.toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
