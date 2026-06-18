/**
 * Host-side same-tile conflict resolution.
 *
 * The resolver is pure (injectable RNG), so these single-page tests pin the
 * tie-break deterministically: two moves onto the same tile cancel exactly one
 * player (chosen by the seeded coin-flip); distinct destinations never cancel;
 * and KDApplyTurnConflicts rewrites the loser's move to an inert `mpnoop` hold so
 * two players never end a turn on the same tile.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('two moves onto the same tile cancel exactly one (seeded tie-break)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const moves = [
			{ playerId: 0, dest: { x: 5, y: 6 } },
			{ playerId: 1, dest: { x: 5, y: 6 } },
		];
		// rng < 0.5 → keep the earlier player (0), cancel the later (1)
		// @ts-ignore
		const lowRoll = KDResolveDestinationConflicts(moves, () => 0.1);
		// rng >= 0.5 → cancel the earlier player (0)
		// @ts-ignore
		const highRoll = KDResolveDestinationConflicts(moves, () => 0.9);
		return { lowRoll, highRoll };
	});
	expect(r.lowRoll).toEqual([1]);
	expect(r.highRoll).toEqual([0]);
});

test('distinct destinations never cancel; a hold (null dest) never collides', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const distinct = KDResolveDestinationConflicts(
			[{ playerId: 0, dest: { x: 1, y: 1 } }, { playerId: 1, dest: { x: 2, y: 2 } }],
			() => 0.1,
		);
		// @ts-ignore — one player holds (null dest) onto a tile the other enters: no cancel
		const withHold = KDResolveDestinationConflicts(
			[{ playerId: 0, dest: null }, { playerId: 1, dest: { x: 2, y: 2 } }],
			() => 0.1,
		);
		return { distinct, withHold };
	});
	expect(r.distinct).toEqual([]);
	expect(r.withHold).toEqual([]);
});

test('KDApplyTurnConflicts rewrites the cancelled move to an inert mpnoop hold', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// Slot 0 = host avatar at (5,5); slot 1 entity at (5,7); both step toward (5,6).
		// @ts-ignore
		KinkyDungeonPlayerEntity.x = 5; KinkyDungeonPlayerEntity.y = 5;
		const p2: any = { id: 91, x: 5, y: 7, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDRegisterPlayer(1, p2);

		const actions = [
			{ playerId: 0, action: { type: 'move', data: { dir: { x: 0, y: 1 } } } },  // → (5,6)
			{ playerId: 1, action: { type: 'move', data: { dir: { x: 0, y: -1 } } } }, // → (5,6)
		];
		// @ts-ignore
		const out = KDApplyTurnConflicts(actions);
		// @ts-ignore
		KDUnregisterPlayer(1);

		const noops = out.filter((a: any) => a.action.type === 'mpnoop').map((a: any) => a.playerId);
		const moves = out.filter((a: any) => a.action.type === 'move').map((a: any) => a.playerId);
		return { noops, moves, total: out.length };
	});
	expect(r.total).toBe(2);
	expect(r.noops.length).toBe(1);   // exactly one player held
	expect(r.moves.length).toBe(1);   // exactly one player moved
});
