/**
 * KDM-208 — a contested-tile move must be CANCELLED, never promoted to a bump attack.
 *
 * Two players submit a move into the SAME empty tile in the same turn. `_advanceTurn` applies them
 * in random order, so one arrives first. Before KDM-208 the loser's move was then applied against a
 * world where the peer's avatar — armed as a REAL hostile enemy by `_armPeerEnemies` (KD-100) — now
 * stood on the target tile, so KD's stock bump-to-attack fired: real damage, real bondage, real
 * defeat. A move became an attack purely because of intra-turn application ORDER.
 *
 * The discriminator is the world at TURN START: a peer who was already there is a legitimate attack
 * target (stock behaviour, kept — see the anti-deletion case below); a peer who only ARRIVED this
 * turn is not, and the mover must simply stall.
 *
 * Both orderings are asserted explicitly (`_shuffle` stubbed), because a single seed would test one
 * of the two arms and call it proof.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** A tile adjacent to BOTH players that the engine says is walkable and empty right now. */
function contestedTarget(s: any) {
	const a = s.posOf('A'), b = s.posOf('B');
	const adj = (p: any, c: any) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) === 1;
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			const c = { x: a.x + dx, y: a.y + dy };
			if (!adj(a, c) || !adj(b, c)) continue;
			const ok = s.world.eval(`(function(){
				var t = KinkyDungeonMapGet(${c.x}, ${c.y});
				return !!(KinkyDungeonMovableTilesEnemy.includes(t) && !KinkyDungeonEntityAt(${c.x}, ${c.y}));
			})()`);
			if (ok) return c;
		}
	}
	return null;
}

const logOf = (s: any, id: string) => (s.logs.get(id) || []).map((m: any) => (m && m.text) || '').join('\n');

describe('KDM-208 — contested tile is a cancelled move, not friendly fire', () => {
	for (const order of [['A', 'B'], ['B', 'A']]) {
		it(`order ${order.join('→')}: the loser stalls — no damage, no attack line`, async () => {
			const s = new SwapSession({ requiredPlayers: 2, seed: `contested-${order.join('')}`, pvp: true });
			s.join('A');
			s.join('B');
			await s.ready();
			s._shuffle = () => order.slice();   // AC4: assert BOTH orderings, not one seed

			const target = contestedTarget(s);
			expect(target, 'no walkable tile adjacent to both players — setup invalid').toBeTruthy();

			const a0 = s.posOf('A'), b0 = s.posOf('B');
			const willA0 = s.vitalsFor('A').will, willB0 = s.vitalsFor('B').will;

			s.submit('A', { kdType: 'move', data: { dir: { x: target.x - a0.x, y: target.y - a0.y }, delta: 1, AllowInteract: true } });
			s.submit('B', { kdType: 'move', data: { dir: { x: target.x - b0.x, y: target.y - b0.y }, delta: 1, AllowInteract: true } });

			const a1 = s.posOf('A'), b1 = s.posOf('B');
			const on = (p: any) => p.x === target.x && p.y === target.y;
			// exactly one wins the tile; the other is still where it started (a cancelled move)
			expect([on(a1), on(b1)].filter(Boolean).length).toBe(1);
			const loser = on(a1) ? 'B' : 'A';
			const loserPos = loser === 'A' ? a1 : b1;
			const loserStart = loser === 'A' ? a0 : b0;
			expect(loserPos).toEqual(loserStart);

			// …and it was cancelled BY THE RULE, not by a wall that happened to be there. Without this
			// the whole assertion block would pass vacuously on an unreachable target tile.
			expect(s.cancelledMoveReport().map((c: any) => c.clientId)).toEqual([loser]);

			// AC1: no damage, no bondage, no defeat, and no attack text anywhere
			expect(s.vitalsFor('A').will).toBe(willA0);
			expect(s.vitalsFor('B').will).toBe(willB0);
			expect(s.isDefeated('A')).toBe(false);
			expect(s.isDefeated('B')).toBe(false);
			expect(logOf(s, 'A')).not.toMatch(/you attack/i);
			expect(logOf(s, 'B')).not.toMatch(/you attack/i);
			expect(logOf(s, 'A') + logOf(s, 'B')).not.toMatch(/apply the .* to the Player/i);
		}, BOOT_TIMEOUT);
	}

	// ANTI-DELETION (AC2): the peer standing there at TURN START is still a real bump-attack target.
	it('a deliberate bump into a peer who was already there still attacks', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'contested-deliberate', pvp: true });
		s.join('A');
		s.join('B');
		await s.ready();
		s._shuffle = () => ['A', 'B'];

		const a = s.posOf('A'), b = s.posOf('B');
		const willB0 = s.vitalsFor('B').will;
		s.submit('A', { kdType: 'move', data: { dir: { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) }, delta: 1, AllowInteract: true } });
		s.submit('B', { kind: 'wait' });   // B does NOT move: it was there at turn start

		expect(s.vitalsFor('B').will).toBeLessThan(willB0);
		expect(logOf(s, 'A')).toMatch(/attack/i);
		expect(s.cancelledMoveReport()).toEqual([]);   // the veto did NOT fire
	}, BOOT_TIMEOUT);
});
