/**
 * Bind a real BC Character to P2 (slice 1 of "P2 renders as a regular player").
 * Single-page tests. Prove the side-map accessor builds a distinct Character for a
 * co-op slot, idempotently, without disturbing the singular player, and — critically —
 * that keeping the Character OUT of the entity lets the P2 entity still round-trip
 * through the save (a Character on the entity would break JSON).
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('the local slot resolves to the singular player Character', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		return { same: KDGetPlayerCharacter(0) === KinkyDungeonPlayer };
	});
	expect(r.same).toBe(true);
});

test('a co-op slot builds its own distinct Character, idempotently', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — before ensure, the slot has no Character
		const before = KDGetPlayerCharacter(1);
		// @ts-ignore
		const c1 = KDEnsurePlayerCharacter(1, 'P2');
		// @ts-ignore — second call returns the SAME cached object (idempotent)
		const c2 = KDEnsurePlayerCharacter(1, 'P2');
		const out = {
			beforeUndefined: before === undefined,
			created: !!c1,
			idempotent: c1 === c2,
			hasAppearance: Array.isArray(c1 && (c1 as any).Appearance),
			// @ts-ignore — distinct from the singular player, which is untouched
			distinct: c1 !== KinkyDungeonPlayer,
			// @ts-ignore
			playerIntact: !!KinkyDungeonPlayer && Array.isArray(KinkyDungeonPlayer.Appearance),
		};
		// @ts-ignore — cleanup
		KDReleasePlayerCharacter(1);
		// @ts-ignore — released
		out['afterRelease'] = KDGetPlayerCharacter(1) === undefined;
		return out;
	});
	expect(r.beforeUndefined).toBe(true);
	expect(r.created).toBe(true);
	expect(r.idempotent).toBe(true);
	expect(r.hasAppearance).toBe(true);
	expect(r.distinct).toBe(true);
	expect(r.playerIntact).toBe(true);
	expect(r.afterRelease).toBe(true);
});

test('co-op: dressing a co-op slot composes a real appearance on its own Character, leaving P1 untouched', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 87, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — snapshot P1's appearance to prove it is not disturbed
		const p1Len0 = KinkyDungeonPlayer.Appearance.length;
		// @ts-ignore — dress P2's own Character (base body/dress + its own, empty, worn list)
		const c = KDDressPlayerSlot(1);
		const out = {
			dressed: !!c,
			p2AppearanceLen: !!c && Array.isArray((c as any).Appearance) ? (c as any).Appearance.length : -1,
			// @ts-ignore — distinct Character, and P1 unchanged
			distinctFromP1: c !== KinkyDungeonPlayer,
			// @ts-ignore
			p1Unchanged: KinkyDungeonPlayer.Appearance.length === p1Len0,
		};
		// @ts-ignore
		KDReleasePlayerCharacter(1);
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.dressed).toBe(true);
	expect(r.p2AppearanceLen).toBeGreaterThan(0);  // a real body/dress composed onto P2's Character
	expect(r.distinctFromP1).toBe(true);
	expect(r.p1Unchanged).toBe(true);              // dressing P2 did not touch P1's appearance
});

test('co-op: KDDrawCoopPlayers draws a dressed slot-1 avatar without throwing, and is a no-op with no co-op player', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const out: any = {};
		// No co-op player present → must be a safe no-op (no throw).
		try { /* @ts-ignore */ KDDrawCoopPlayers(0, 0, 0, 0, 0, 0); out.noopOk = true; }
		catch (e) { out.noopOk = false; out.noopErr = String((e && (e as Error).message) || e); }

		// Now a dressed P2 in the map.
		const p2: any = { id: 88, x: 3, y: 3, visual_x: 3, visual_y: 3, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — dress it (gives its Character a model in KDCurrentModels)
		KDDressPlayerSlot(1);
		// @ts-ignore
		KDMapData.Entities.push(p2);
		try { /* @ts-ignore */ KDDrawCoopPlayers(100, 100, 0, 0, 0, 0); out.drawOk = true; }
		catch (e) { out.drawOk = false; out.drawErr = String((e && (e as Error).message) || e); }
		// @ts-ignore — the slot resolved to a real Character distinct from P1
		out.resolvedCharacter = KDGetPlayerCharacter(1) !== undefined && KDGetPlayerCharacter(1) !== KinkyDungeonPlayer;

		// @ts-ignore cleanup
		KDMapData.Entities = KDMapData.Entities.filter((e: any) => e !== p2);
		// @ts-ignore
		KDReleasePlayerCharacter(1);
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.noopOk).toBe(true);            // safe no-op when no co-op player
	expect(r.drawOk).toBe(true);            // drew a dressed P2 without throwing (real WebGL)
	expect(r.resolvedCharacter).toBe(true); // resolved P2's own Character
});

test('co-op: P2 appearance is stamped on save and rebuilt on load (a fresh client reconstructs the look)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — keep solo-drop from removing P2 during the load
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;

		const p2: any = { id: 89, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — dress P2 so its Character has a real appearance
		const cBefore = KDDressPlayerSlot(1);
		const lenBefore = (cBefore && Array.isArray((cBefore as any).Appearance)) ? (cBefore as any).Appearance.length : -1;
		// @ts-ignore
		KDMapData.Entities.push(p2);

		// Save — KDStampCoopAppearance runs inside generateSaveData and copies the
		// Character's appearance onto the entity.
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		const stamped = !!p2.charAppearance;

		// Simulate a FRESH client: drop the in-memory side-map Character entirely, so
		// the look can only come back from the saved bytes.
		// @ts-ignore
		KDReleasePlayerCharacter(1);
		// @ts-ignore — load triggers KDRestoreCoopCharacters
		KinkyDungeonLoadGame(save, true);

		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		// @ts-ignore
		const cAfter = KDGetPlayerCharacter(1);
		const out = {
			lenBefore,
			stamped,
			restoredHasStamp: !!(restored && restored.charAppearance),
			rebuilt: !!cAfter,
			lenAfter: (cAfter && Array.isArray((cAfter as any).Appearance)) ? (cAfter as any).Appearance.length : -1,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDReleasePlayerCharacter(1);
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.lenBefore).toBeGreaterThan(0);       // P2 was dressed before save
	expect(r.stamped).toBe(true);                 // appearance stamped onto the entity
	expect(r.restoredHasStamp).toBe(true);        // it survived save→load on the entity
	expect(r.rebuilt).toBe(true);                 // a fresh Character was rebuilt on load
	expect(r.lenAfter).toBe(r.lenBefore);         // with the same appearance, reconstructed from bytes
});

test('the P2 entity still round-trips through save with a Character bound (side map keeps it out of JSON)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;
		const p2: any = { id: 86, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — bind a real Character to slot 1 (lives in the side map, NOT on p2)
		const c = KDEnsurePlayerCharacter(1, 'P2');
		// @ts-ignore
		KDMapData.Entities.push(p2);
		let saveOk = true; let err = '';
		try {
			// @ts-ignore — this would THROW if a circular Character were on the entity
			const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
			// @ts-ignore
			KinkyDungeonLoadGame(save, true);
		} catch (e) { saveOk = false; err = String((e && (e as Error).message) || e); }
		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const out = {
			characterBuilt: !!c,
			entityNotCarryingCharacter: !!p2 && (p2 as any).Character === undefined,
			saveOk, err,
			restored: !!restored,
		};
		// @ts-ignore
		KDReleasePlayerCharacter(1);
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.characterBuilt).toBe(true);
	expect(r.entityNotCarryingCharacter).toBe(true);  // Character is in the side map, not on the entity
	expect(r.saveOk).toBe(true);                      // save did not choke on a circular Character
	expect(r.restored).toBe(true);
});
