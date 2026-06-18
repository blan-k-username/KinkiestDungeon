/**
 * Second co-op character persistence + save compatibility.
 *
 * P2 is a KDMapData.Entities member, so it already round-trips through
 * save/load + state_sync. These single-page tests cover the two remaining gaps:
 *   1. P2's inert (stripped-tags) Enemy def survives the pack/unpack round-trip
 *      because it is flagged `modified` — it is NOT re-fattened to the full def.
 *   2. Continuing a co-op save single-player drops the orphan P2 (no zombie),
 *      while legacy single-player saves load unchanged.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('a modified P2 Enemy def survives pack/unpack; an unmodified one is re-fattened', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// P2-style: custom inert def, flagged modified.
		// @ts-ignore
		const p2: any = { id: 5, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDPackEnemy(p2);
		// @ts-ignore
		KDUnPackEnemy(p2);

		// Control: same sprite name, but NOT modified → reconstructed from the name.
		// @ts-ignore
		const npc: any = { id: 6, x: 2, y: 2, hp: 10, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDUnPackEnemy(npc);

		return {
			p2Name: p2.Enemy.name,
			p2TagKeys: Object.keys(p2.Enemy.tags || {}).length,   // inert: stays 0
			npcRefattened: !!(npc.Enemy && npc.Enemy.maxhp),       // control: full def restored
		};
	});
	expect(r.p2Name).toBe('Guard');
	expect(r.p2TagKeys).toBe(0);          // P2 stayed inert across pack/unpack
	expect(r.npcRefattened).toBe(true);   // a non-modified entity IS reconstructed
});

test('continuing a co-op save single-player drops the orphan P2', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — not in a session
		const wasActive = (typeof MPState !== 'undefined') && MPState.active;
		// Inject a P2 avatar into the current map, then snapshot it into a save.
		// @ts-ignore
		const before = KDMapData.Entities.length;
		// @ts-ignore
		KDMapData.Entities.push({ id: 9991, x: 3, y: 3, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } });
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		const savedHasP2 = !!KDMapData.Entities.find((e: any) => e && e.playerSlot === 1);

		// Load it back with no active session → solo continue should drop P2.
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore
		const loadedHasP2 = !!(KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		return { wasActive, savedHasP2, loadedHasP2, before };
	});
	expect(r.wasActive).toBeFalsy();
	expect(r.savedHasP2).toBe(true);    // the save carried the P2 entity
	expect(r.loadedHasP2).toBe(false);  // solo continue dropped it
});

test('a legacy single-player save (no P2) loads unchanged', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		return {
			// @ts-ignore
			hasP2: !!(KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1),
			// @ts-ignore — the single player is intact
			playerOk: !!KinkyDungeonPlayerEntity && KDPlayerById(0) === KinkyDungeonPlayerEntity,
			// @ts-ignore
			localId: KDLocalPlayerId,
		};
	});
	expect(r.hasP2).toBe(false);
	expect(r.playerOk).toBe(true);
	expect(r.localId).toBe(0);
});
