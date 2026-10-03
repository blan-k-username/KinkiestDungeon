/**
 * Node-layer (Vitest) — a noise is heard according to each HEARER's own deafness, whoever holds the
 * player slot.
 *
 * KD decides who hears an enemy's noise inside `KDEnemyAddSound` (KinkyDungeonEnemies.ts), against
 * ONE listener: the slot occupant. Co-op re-offers the same noise to every other joined human
 * (`SwapSession._broadcastNoiseToOthers` → `HeadlessHost.canHearFrom`). Two gaps, one per direction:
 *   - a deafened OTHER human was judged with the OCCUPANT's hearing — `KDCanHearSound` →
 *     `KinkyDungeonGetHearingRadius()` → `KDDeafLevel()` read the global player's restraints, whatever
 *     listener was passed in — so they heard noise they should not;
 *   - a deafened OCCUPANT queued nothing (KD's own check failed for them), and the re-offer only ever
 *     filtered the occupant's queued entries — so a hearing partner missed the noise entirely.
 *
 * DETERMINISTIC, NOT A LOTTERY. The noise is made by calling KD's own `KDEnemyAddSound` with a rising
 * sound (no random "repeat sound" roll) at a tile 7–9 tiles from both humans, then harvesting exactly
 * the way an apply does. LeatherHood (`deaf: 4`) gives deaf level 4 → hearing radius 4 → a 1.5×
 * threshold of 6 tiles, so a deafened human cannot hear it and a hearing one (radius 8 → 12) can.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

const heard = (events: any[]) => (events || []).some((e: any) => !!e && e.kind === 'noise'
	&& (((e.shockwaves || []).length + (e.sounddesc || []).length) > 0));

/** Free tiles 7–9 (Chebyshev) from both humans: inside normal hearing, outside deafened hearing. */
function spotsBetween(s: any, a: { x: number, y: number }, b: { x: number, y: number }) {
	return s.world.eval(`(function(){
		var out = [];
		for (var x = Math.min(${a.x}, ${b.x}) - 12; x <= Math.max(${a.x}, ${b.x}) + 12; x++)
			for (var y = Math.min(${a.y}, ${b.y}) - 12; y <= Math.max(${a.y}, ${b.y}) + 12; y++) {
				var dA = Math.max(Math.abs(x - ${a.x}), Math.abs(y - ${a.y}));
				var dB = Math.max(Math.abs(x - ${b.x}), Math.abs(y - ${b.y}));
				if (dA < 7 || dA > 9 || dB < 7 || dB > 9) continue;
				if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y))
					out.push({ x: x, y: y, walls: KinkyDungeonCheckPathCount(${a.x}, ${a.y}, x, y, true, false, 4, true)
						+ KinkyDungeonCheckPathCount(${b.x}, ${b.y}, x, y, true, false, 4, true) });
			}
		out.sort(function(p, q){ return p.walls - q.walls; });
		return out;
	})()`) || [];
}

/** Put KD's LeatherHood (deaf: 4) on `id`, through KD's own restraint API, and commit it. */
function deafen(s: any, id: string) {
	s._restorePlayer(id);
	const level = s.world.eval(`(function(){
		KinkyDungeonAddRestraintIfWeaker("LeatherHood", 0, true);
		return KDDeafLevel();
	})()`);
	expect(level, `setup: ${id} is really deafened`).toBeGreaterThan(0);
	s.bundles.set(id, s.world.capturePlayer());
}

/**
 * Boot two humans, deafen whoever is asked, run ONE ordinary round (so every human's own state has
 * passed through the slot since), then make one noise with `occupant` in the slot and harvest it.
 */
async function noiseWith(seed: string, deaf: string[], occupant: string) {
	const s = new SwapSession({ requiredPlayers: 2, seed, pvp: false, enemyType: 'Rat' });
	s.join('A'); s.join('B');
	await s.ready();
	expect(s.enemyId, 'setup: the noise-making enemy exists').not.toBeNull();
	for (const id of deaf) deafen(s, id);
	s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' });

	const posA = s.posOf('A'); const posB = s.posOf('B');
	const spots = spotsBetween(s, posA, posB);
	expect(spots.length, 'setup: a tile 7-9 from both humans').toBeGreaterThan(0);
	s.world.moveAvatar(s.enemyId, spots[0].x, spots[0].y);

	s._restorePlayer(occupant);
	s.world.takeNoisePresentation(); s.world.takeNoiseSources();   // start from empty queues
	s._takePendingEvents('A'); s._takePendingEvents('B');
	s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
		e.sound = 0;                 // a RISING sound: no random "repeat" roll decides it
		KDEnemyAddSound(e, 10);
	})()`);
	s._harvestNoise(occupant);
	return { A: heard(s._takePendingEvents('A')), B: heard(s._takePendingEvents('B')) };
}

describe("a hearer's deafness is their own, not the slot occupant's", () => {
	it('control: neither human deaf — the noise reaches the other human', async () => {
		const got = await noiseWith('deaf-control', [], 'A');
		expect(got.B, 'a hearing partner 7-9 tiles away hears it').toBe(true);
	}, BOOT_TIMEOUT);

	it('the OTHER human is deaf, the occupant is not — the deaf one does not hear it', async () => {
		const got = await noiseWith('deaf-other', ['B'], 'A');
		expect(got.B, "B's own deafness decides, not A's hearing").toBe(false);
	}, BOOT_TIMEOUT);

	it('the OCCUPANT is deaf, the other is not — the other still hears it', async () => {
		const got = await noiseWith('deaf-occupant', ['A'], 'A');
		expect(got.A, 'the deafened occupant does not hear it (KD\'s own check)').toBe(false);
		expect(got.B, "B's own hearing decides, not A's deafness").toBe(true);
	}, BOOT_TIMEOUT);
});
