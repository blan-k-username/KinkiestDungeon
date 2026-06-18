/**
 * Per-player ownership for inventory / restraints / perks.
 *
 * Introduces a *parallel* accessor (`KDGetInventoryFor(id)` etc.) without
 * modifying the existing global state. The local player's slot
 * (id === KDLocalPlayerId) is backed by the existing engine globals, so
 * single-player code paths see no change. The non-local slot is a separate
 * per-id container that the multiplayer engine populates when a partner connects.
 *
 * This locks in the *ownership boundary* — multiplayer wiring and PvP design
 * depend on these accessors existing.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test.describe('inventory ownership', () => {
	test('KDGetInventoryFor(KDLocalPlayerId) is the local engine inventory', async ({ kdPage }) => {
		const same = await kdPage.evaluate(() => {
			// @ts-ignore — bundle globals
			return KDGetInventoryFor(KDLocalPlayerId) === KinkyDungeonInventory;
		});
		expect(same).toBe(true);
	});

	test('KDGetInventoryFor(1) returns a Map distinct from the local inventory', async ({ kdPage }) => {
		const out = await kdPage.evaluate(() => {
			// @ts-ignore
			const remote = KDGetInventoryFor(1);
			return {
				isMap: remote instanceof Map,
				// @ts-ignore
				distinct: remote !== KinkyDungeonInventory,
			};
		});
		expect(out.isMap).toBe(true);
		expect(out.distinct).toBe(true);
	});

	test('mutating the remote inventory does not touch the local one', async ({ kdPage }) => {
		const out = await kdPage.evaluate(() => {
			// @ts-ignore
			const remote = KDGetInventoryFor(1);
			remote.set('TestGroup', new Map());
			// @ts-ignore
			return KinkyDungeonInventory.has('TestGroup');
		});
		expect(out).toBe(false);
	});

	test('KDUnregisterInventory(1) clears slot 1', async ({ kdPage }) => {
		const out = await kdPage.evaluate(() => {
			// @ts-ignore
			KDGetInventoryFor(1).set('Marker', new Map());
			// @ts-ignore
			KDUnregisterInventory(1);
			// @ts-ignore
			return KDGetInventoryFor(1).has('Marker');
		});
		expect(out).toBe(false);
	});
});

test.describe('restraint ownership', () => {
	test('KDIsPlayerOwnedByLocal returns true for the local player', async ({ kdPage }) => {
		const v = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDIsPlayerOwnedByLocal(KDLocalPlayerId);
		});
		expect(v).toBe(true);
	});

	test('KDIsPlayerOwnedByLocal returns false for other slots', async ({ kdPage }) => {
		const v = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDIsPlayerOwnedByLocal(1);
		});
		expect(v).toBe(false);
	});

	test('KDPlayerFactionRelation defaults to ally (co-op)', async ({ kdPage }) => {
		const rel = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDPlayerFactionRelation;
		});
		// co-op mode defaults to ally
		expect(rel).toBe('ally');
	});

	test('KDIsPlayerHostile is false in co-op (default), true once flipped to PvP', async ({ kdPage }) => {
		const out = await kdPage.evaluate(() => {
			// @ts-ignore
			const before = KDIsPlayerHostile(0, 1);
			// @ts-ignore
			KDPlayerFactionRelation = 'hostile';
			// @ts-ignore
			const after = KDIsPlayerHostile(0, 1);
			// reset for downstream tests
			// @ts-ignore
			KDPlayerFactionRelation = 'ally';
			return { before, after };
		});
		expect(out.before).toBe(false);
		expect(out.after).toBe(true);
	});
});
