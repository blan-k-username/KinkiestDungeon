/**
 * Node-layer (Vitest) tests for co-op action sync — KD-085 (server side).
 *
 * Covers true lockstep + random conflict resolution (R8/R9) and routed attack:
 * two players contest the same tile → a random winner moves, the loser skips; a
 * player's attack applies to the WORLD's authoritative enemy (both would see it).
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CoopSession } = require('../../tools/mp-server/coop-session');

const BOOT_TIMEOUT = 240_000;

describe('action sync — random conflict resolution (KD-085 R9)', () => {
	let s: any;
	let recon: any;

	beforeAll(() => {
		s = new CoopSession({ requiredPlayers: 2, seed: 'action-conflict-seed' });
		s.join('A');
		s.join('B');
		recon = s.reconciler;
	}, BOOT_TIMEOUT);

	it('two players moving into the same tile → exactly one wins (random), the other skips', () => {
		const a0 = s.instanceOf('A').getPlayerPos();
		const b0 = s.instanceOf('B').getPlayerPos();
		// craft moves so both target the SAME tile. A and B start adjacent
		// (B = A + (1,0)); both aim for (a0.x+1, a0.y+1).
		const target = { x: a0.x + 1, y: a0.y + 1 };
		s.submit('A', { kind: 'move', dx: target.x - a0.x, dy: target.y - a0.y });
		s.submit('B', { kind: 'move', dx: target.x - b0.x, dy: target.y - b0.y });

		// a conflict was detected + resolved with a single winner
		expect(recon.lastConflicts.length).toBeGreaterThanOrEqual(1);
		const c = recon.lastConflicts.find((x: any) => x.dest === `${target.x},${target.y}`);
		expect(c).toBeTruthy();
		expect(c.contenders.sort()).toEqual(['A', 'B']);
		expect(['A', 'B']).toContain(c.winner);

		// exactly ONE player is on the contested tile; the loser did not move there
		const a1 = s.instanceOf('A').getPlayerPos();
		const b1 = s.instanceOf('B').getPlayerPos();
		const aOnTarget = a1.x === target.x && a1.y === target.y;
		const bOnTarget = b1.x === target.x && b1.y === target.y;
		expect(aOnTarget || bOnTarget).toBe(true);
		expect(aOnTarget && bOnTarget).toBe(false);
		// the winner matches who's on the tile; the loser stayed put
		const loser = c.winner === 'A' ? 'B' : 'A';
		const loserBefore = loser === 'A' ? a0 : b0;
		const loserAfter = loser === 'A' ? a1 : b1;
		expect(loserAfter).toEqual(loserBefore); // skipped → no move
	}, BOOT_TIMEOUT);
});

describe('action sync — routed attack hits the world enemy (KD-085)', () => {
	it('a player attack damages the WORLD authoritative enemy', () => {
		const s = new CoopSession({ requiredPlayers: 2, seed: 'action-attack-seed' });
		s.join('A');
		s.join('B');
		const recon = s.reconciler;
		const world = s.orch.world;

		// place the world enemy adjacent to A's avatar so the attack is in range
		const avId = recon.worldAvatar.get('A');
		const av = world.listEntities().find((e: any) => e.id === avId);
		world.moveAvatar(recon.worldEnemyId, av.x, av.y + 1);
		const before = recon.enemyView(s.orch); // {id,x,y,hp,name}
		expect(before).toBeTruthy();

		s.submit('A', { kind: 'attack' });
		s.submit('B', { kind: 'wait' });

		// the attack was routed to the world enemy and landed
		expect(recon.lastPvE.length).toBeGreaterThanOrEqual(1);
		const hit = recon.lastPvE.find((h: any) => h.id === 'A');
		expect(hit).toBeTruthy();
		expect(hit.applied).not.toBe('no-target');
		expect(hit.result).toBeTruthy();
		expect(hit.result.dealt).toBeGreaterThan(0);

		// the world enemy is damaged or killed (HP dropped, or removed)
		const after = recon.enemyView(s.orch);
		const damaged = after == null || after.hp < before.hp;
		expect(damaged).toBe(true);
	}, BOOT_TIMEOUT);
});
