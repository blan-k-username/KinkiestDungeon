/**
 * P2 restraints: per-slot worn-restraint storage.
 *
 * Single-page tests. Prove the per-slot read accessor WITHOUT touching the global
 * restraint reads/adds: the local slot reflects the global worn set (single-player
 * byte-identical), a co-op slot has its own worn-list (a plain ARRAY on its entity)
 * that is independent of P1's and round-trips via Entities serialization. The array
 * shape is deliberate — a Map field would be dropped by JSON save serialization.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('the local slot accessor reflects the global worn-restraint set', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — KinkyDungeonAllRestraint is the singular worn set
		const direct = KinkyDungeonAllRestraint().length;
		// @ts-ignore
		const viaAccessor = KDGetWornRestraintsFor(0).length;
		return { direct, viaAccessor };
	});
	expect(r.viaAccessor).toBe(r.direct);
});

test('a co-op slot has its own worn-restraint list, independent of the local player', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 83, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// add a fake worn item to P2's list only
		// @ts-ignore
		KDGetWornRestraintsFor(1).push({ name: 'FakeCuffs', type: Restraint, id: 999 } as any);
		const out = {
			// @ts-ignore
			p2Count: KDGetWornRestraintsFor(1).length,
			// @ts-ignore — the global/local worn set never saw it
			localCount: KDGetWornRestraintsFor(0).length,
			// @ts-ignore
			localDirect: KinkyDungeonAllRestraint().length,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.p2Count).toBe(1);              // P2's own list got the item
	expect(r.localCount).toBe(r.localDirect); // P1's worn set untouched (no FakeCuffs)
});

test("P2's worn restraint list round-trips through save → load", async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — keep solo-drop from removing P2 during the load
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;
		const p2: any = { id: 84, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDGetWornRestraintsFor(1) /* lazily inits */;
		p2.restraintList.push({ name: 'FakeCuffs', type: 'restraint', id: 999 });
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDMapData.Entities.push(p2);
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const out = {
			present: !!restored,
			listLen: restored && Array.isArray(restored.restraintList) ? restored.restraintList.length : 0,
			itemName: restored && restored.restraintList && restored.restraintList[0] ? restored.restraintList[0].name : null,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.present).toBe(true);
	expect(r.listLen).toBe(1);
	expect(r.itemName).toBe('FakeCuffs');
});

/* ---------------------------------------------------------------------------
 * Add-routing ("enemies can bind P2"): the per-slot binding primitive
 * KDAddRestraintToSlot lands a faithful worn restraint on a co-op slot's OWN
 * restraintList (rides character render + Entities save/load), while slot 0 defers
 * to the unchanged global add path (SP byte-identical). Here the restraint just
 * lands, persists, and renders.
 * ------------------------------------------------------------------------- */

test('add-routing: an enemy attack binds P2 on its own worn set, not P1', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 86, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		const globalBefore = KinkyDungeonAllRestraint().length;
		const enemy = { id: 5, x: 2, y: 1, Enemy: { name: 'Guard', power: 1, tags: {} } };
		// @ts-ignore — LeatherHood is a real restraint (Group ItemHead)
		const res = KDAddRestraintToSlot(1, [{ r: { name: 'LeatherHood', Group: 'ItemHead', power: 5 } }], { enemy });
		const out = {
			added: res.added,
			// @ts-ignore
			p2List: KDGetWornRestraintsFor(1).length,
			// @ts-ignore
			p2Name: KDGetWornRestraintsFor(1)[0] ? KDGetWornRestraintsFor(1)[0].name : null,
			// @ts-ignore — P1's global worn set never saw it
			globalAfter: KinkyDungeonAllRestraint().length,
			globalBefore,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.added).toBe(1);
	expect(r.p2List).toBe(1);
	expect(r.p2Name).toBe('LeatherHood');
	expect(r.globalAfter).toBe(r.globalBefore);   // P1's worn set untouched
});

test('add-routing: binding is one-per-group (no stacking on the same slot)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 87, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		const first = KDAddRestraintToSlot(1, [{ r: { name: 'LeatherHood', Group: 'ItemHead', power: 5 } }], {});
		// @ts-ignore — a second ItemHead restraint must be refused (group occupied)
		const second = KDAddRestraintToSlot(1, [{ r: { name: 'LeatherMask', Group: 'ItemHead', power: 5 } }], {});
		const out = {
			firstAdded: first.added, secondAdded: second.added,
			// @ts-ignore
			listLen: KDGetWornRestraintsFor(1).length,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.firstAdded).toBe(1);
	expect(r.secondAdded).toBe(0);   // same Group → refused
	expect(r.listLen).toBe(1);
});

test('add-routing: a bound P2 round-trips through save → load', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — keep solo-drop from removing P2 during the load
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;
		const p2: any = { id: 88, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDMapData.Entities.push(p2);
		// @ts-ignore
		KDAddRestraintToSlot(1, [{ r: { name: 'LeatherHood', Group: 'ItemHead', power: 5 } }], {});
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const out = {
			present: !!restored,
			name: restored && restored.restraintList && restored.restraintList[0] ? restored.restraintList[0].name : null,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.present).toBe(true);
	expect(r.name).toBe('LeatherHood');   // survived the round-trip on P2's own list
});

test('add-routing: slot 0 routes to the global inventory (SP path)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const before = KinkyDungeonAllRestraint().length;
		// @ts-ignore — pass the real restraint def so the global add path is satisfied
		const res = KDAddRestraintToSlot(0, [{ r: KDRest('LeatherHood') }], {});
		return {
			added: res.added,
			// @ts-ignore
			after: KinkyDungeonAllRestraint().length,
			before,
		};
	});
	expect(r.added).toBe(1);
	expect(r.after).toBe(r.before + 1);   // landed on the global worn set, not an entity list
});
