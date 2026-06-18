/**
 * Foundations for plural player support without breaking single-player.
 *
 * The existing `KDPlayer()` (in `Game/src/base/KDModUtils.ts`) is called from
 * 500+ call sites and must keep returning the local player's entity exactly as
 * today. This adds the *parallel* API that multiplayer code will use to address
 * either player:
 *
 *   - `KDPlayers: entity[]`        — registered player entities, indexed by id
 *   - `KDLocalPlayerId: number`    — which slot is the local user (0 by default)
 *   - `KDPlayerById(id)`           — returns the entity for a given slot
 *   - `KDRegisterPlayer(id, ent)`  — multiplayer wiring registers slot 1
 *   - `KDUnregisterPlayer(id)`     — clean teardown when a session ends
 *
 * Single-player invariant: with no multiplayer wiring, the local player is
 * implicitly slot 0; `KDPlayer()` continues to return `KinkyDungeonPlayerEntity`.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test.describe('plural-player foundations', () => {
	test('KDPlayer() still returns the singular local player entity (regression guard)', async ({ kdPage }) => {
		const same = await kdPage.evaluate(() => {
			// @ts-ignore — bundle globals
			return KDPlayer() === KinkyDungeonPlayerEntity;
		});
		expect(same).toBe(true);
	});

	test('KDLocalPlayerId defaults to 0 in single-player', async ({ kdPage }) => {
		const id = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDLocalPlayerId;
		});
		expect(id).toBe(0);
	});

	test('KDPlayers[KDLocalPlayerId] is the local player entity', async ({ kdPage }) => {
		const same = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDPlayers[KDLocalPlayerId] === KinkyDungeonPlayerEntity;
		});
		expect(same).toBe(true);
	});

	test('KDPlayerById(0) returns the local player entity', async ({ kdPage }) => {
		const same = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDPlayerById(0) === KinkyDungeonPlayerEntity;
		});
		expect(same).toBe(true);
	});

	test('KDPlayerById(99) returns undefined for unregistered slots', async ({ kdPage }) => {
		const result = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDPlayerById(99);
		});
		expect(result).toBeUndefined();
	});

	test('KDRegisterPlayer adds a second player into the array without breaking KDPlayer()', async ({ kdPage }) => {
		const out = await kdPage.evaluate(() => {
			// @ts-ignore
			const partner = { id: -999, x: 5, y: 5, hp: 10, hostile: 0, Enemy: { name: 'KDTestPartner' } };
			// @ts-ignore
			KDRegisterPlayer(1, partner);
			// @ts-ignore
			const ok = KDPlayer() === KinkyDungeonPlayerEntity
				&& KDPlayerById(1) === partner
				&& KDPlayers.length >= 2;
			// @ts-ignore
			KDUnregisterPlayer(1);
			// @ts-ignore
			const cleaned = KDPlayerById(1) === undefined;
			return { ok, cleaned };
		});
		expect(out.ok).toBe(true);
		expect(out.cleaned).toBe(true);
	});

	test('KDRegisterPlayer is idempotent — re-registering the same slot replaces, never duplicates', async ({ kdPage }) => {
		const counts = await kdPage.evaluate(() => {
			// @ts-ignore
			const partnerA = { id: -111, x: 1, y: 1 };
			// @ts-ignore
			const partnerB = { id: -222, x: 2, y: 2 };
			// @ts-ignore
			KDRegisterPlayer(1, partnerA);
			// @ts-ignore
			KDRegisterPlayer(1, partnerB);
			// @ts-ignore
			const after = KDPlayers.filter((p: any) => p === partnerA || p === partnerB);
			// @ts-ignore
			const winner = KDPlayerById(1);
			// @ts-ignore
			KDUnregisterPlayer(1);
			return { count: after.length, winner: winner === partnerB };
		});
		expect(counts.count).toBe(1);
		expect(counts.winner).toBe(true);
	});

	test('local player entity stays mounted at slot 0 after any registration churn', async ({ kdPage }) => {
		const ok = await kdPage.evaluate(() => {
			// @ts-ignore
			const partner = { id: -3, x: 9, y: 9 };
			// @ts-ignore
			KDRegisterPlayer(1, partner);
			// @ts-ignore
			const stillLocal = KDPlayerById(0) === KinkyDungeonPlayerEntity;
			// @ts-ignore
			KDUnregisterPlayer(1);
			// @ts-ignore
			const stillLocal2 = KDPlayerById(0) === KinkyDungeonPlayerEntity;
			return stillLocal && stillLocal2;
		});
		expect(ok).toBe(true);
	});
});
