/**
 * Player-slot abstraction: proves `KDPlayers[KDLocalPlayerId]` (the local-player
 * slot) tracks the singular `KinkyDungeonPlayerEntity` global across init,
 * save/load, and movement — i.e. the accessor `KDLocalPlayer()` and
 * `KDPlayerById(KDLocalPlayerId)` resolve the SAME object as the global in
 * single-player. Object references can't cross the page.evaluate boundary, so
 * identity is proven via a probe field.
 *
 * Single-player must stay byte-identical; that broader guarantee is carried by
 * the rest of the suite staying green.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('local-player slot tracks the player global after init', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — bundle globals
		KinkyDungeonPlayerEntity.__kdprobe = 7;
		// @ts-ignore
		return { localId: KDLocalPlayerId, byId: KDPlayerById(KDLocalPlayerId)?.__kdprobe, local: KDLocalPlayer().__kdprobe };
	});
	expect(r.localId).toBe(0);          // single-player owns slot 0
	expect(r.byId).toBe(7);             // slot is the same object as the global
	expect(r.local).toBe(7);            // KDLocalPlayer() too
});

test('local-player slot re-syncs after save → load', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — real save path; load reassigns the player global to a NEW object
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore — probe the POST-load global; the slot must now point at it
		KinkyDungeonPlayerEntity.__kdprobe2 = 9;
		// @ts-ignore
		return { byId: KDPlayerById(KDLocalPlayerId)?.__kdprobe2, local: KDLocalPlayer().__kdprobe2 };
	});
	expect(r.byId).toBe(9);             // post-load re-sync fired
	expect(r.local).toBe(9);
});

test('a player move acts on the local-player slot entity', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — attempt a move; success depends on walls, but the routing
		// invariant (slot === global) must hold regardless.
		const tx = KinkyDungeonPlayerEntity.x + 1, ty = KinkyDungeonPlayerEntity.y;
		// @ts-ignore
		KDMovePlayer(tx, ty, true);
		// @ts-ignore
		return {
			// @ts-ignore
			globalX: KinkyDungeonPlayerEntity.x, globalY: KinkyDungeonPlayerEntity.y,
			// @ts-ignore
			slotX: KDPlayerById(KDLocalPlayerId)?.x, slotY: KDPlayerById(KDLocalPlayerId)?.y,
		};
	});
	expect(r.slotX).toBe(r.globalX);    // KDMovePlayer mutated the slot-tracked object
	expect(r.slotY).toBe(r.globalY);
});
