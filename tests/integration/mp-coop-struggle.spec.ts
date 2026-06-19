/**
 * P2 struggle: the per-slot escape primitive KDStrugglePlayerSlot lets a bound
 * co-op player work itself free against its OWN restraints + stats, leaving P1's
 * struggle/stats/worn set untouched. The local slot defers to the unchanged engine
 * KinkyDungeonStruggle (single-player byte-identical). Struggle progress lives on the
 * worn item, so it rides the per-slot restraintList (save/load + state_sync).
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('P2 struggles free of its own restraint; P1 stats + worn set untouched', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 90, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2); KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — bind P2 with a struggleable restraint (ScarfArms: escapeChance.Struggle = 0.5)
		KDAddRestraintToSlot(1, [{ r: { name: 'ScarfArms', Group: 'ItemArms', power: 0 } }], {});
		// @ts-ignore
		const globalStamBefore = KinkyDungeonStatStamina;
		// @ts-ignore
		const globalWornBefore = KinkyDungeonAllRestraint().length;
		// @ts-ignore
		const stamBefore = KDGetPlayerStat(1, 'stamina');

		const results: string[] = [];
		let guard = 0;
		// struggle until free (ScarfArms 0.5/attempt → ~2 attempts), bounded
		// @ts-ignore
		while (KDSlotHasRestraintGroup(1, 'ItemArms') && guard < 8) {
			// @ts-ignore
			results.push(KDStrugglePlayerSlot(1, 'ItemArms', 'Struggle'));
			guard++;
		}
		const out = {
			results,
			// @ts-ignore — P2 is free
			p2StillBound: KDSlotHasRestraintGroup(1, 'ItemArms'),
			// @ts-ignore
			p2Worn: KDGetWornRestraintsFor(1).length,
			// @ts-ignore — P2 spent stamina
			stamBefore, stamAfter: KDGetPlayerStat(1, 'stamina'),
			// @ts-ignore — P1 untouched
			globalStamBefore, globalStamAfter: KinkyDungeonStatStamina,
			globalWornBefore, globalWornAfter: KinkyDungeonAllRestraint().length,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.results).toContain('Success');          // P2 eventually escaped
	expect(r.p2StillBound).toBe(false);              // the restraint is gone from P2's set
	expect(r.p2Worn).toBe(0);
	expect(r.stamAfter).toBeLessThan(r.stamBefore);  // P2 spent its own stamina
	expect(r.globalStamAfter).toBe(r.globalStamBefore); // P1 stamina untouched
	expect(r.globalWornAfter).toBe(r.globalWornBefore); // P1 worn set untouched
});

test('struggle is stamina-gated: an exhausted P2 makes no progress', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 91, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2); KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDAddRestraintToSlot(1, [{ r: { name: 'ScarfArms', Group: 'ItemArms', power: 0 } }], {});
		// @ts-ignore — drain P2's stamina below the per-attempt cost
		KDSetPlayerStat(1, 'stamina', 0);
		// @ts-ignore
		const res = KDStrugglePlayerSlot(1, 'ItemArms', 'Struggle');
		const item: any = KDGetWornRestraintsFor(1)[0];
		const out = {
			res,
			stillBound: KDSlotHasRestraintGroup(1, 'ItemArms'),
			progress: item ? (item.struggleProgress || 0) : -1,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.res).toBe('Fail');
	expect(r.stillBound).toBe(true);   // still bound
	expect(r.progress).toBe(0);        // no progress made while exhausted
});

test('struggling a tools-only restraint makes no progress (needs Cut/Remove)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 92, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2); KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — LeatherHood: escapeChance.Struggle = -0.35 (can't wriggle out)
		KDAddRestraintToSlot(1, [{ r: { name: 'LeatherHood', Group: 'ItemHead', power: 5 } }], {});
		// @ts-ignore
		const res = KDStrugglePlayerSlot(1, 'ItemHead', 'Struggle');
		const item: any = KDGetWornRestraintsFor(1)[0];
		const out = {
			res,
			stillBound: KDSlotHasRestraintGroup(1, 'ItemHead'),
			progress: item ? (item.struggleProgress || 0) : -1,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.res).toBe('Fail');
	expect(r.stillBound).toBe(true);   // negative escapeChance → still stuck
	expect(r.progress).toBe(0);
});

test('the struggle input handler routes a _playerSlot action to P2, not P1', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 93, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2); KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDAddRestraintToSlot(1, [{ r: { name: 'ScarfArms', Group: 'ItemArms', power: 0 } }], {});
		// @ts-ignore — drive via the input handler with the guest's slot tag
		const res = KDInputTypes['struggle']({ group: 'ItemArms', type: 'Struggle', index: 0, _playerSlot: 1 });
		const item: any = KDGetWornRestraintsFor(1)[0];
		const out = {
			res,
			p2Progress: item ? (item.struggleProgress || 0) : (KDSlotHasRestraintGroup(1, 'ItemArms') ? 0 : 1),
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	// either progressed (still bound) or freed in one shot — both prove it acted on P2
	expect(r.res === 'Fail' || r.res === 'Success').toBe(true);
	expect(r.p2Progress).toBeGreaterThan(0);
});

test('partial struggle progress on P2 round-trips through save → load', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — keep solo-drop from removing P2 during the load
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;
		const p2: any = { id: 94, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2); KDInitPlayerRestraints(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDMapData.Entities.push(p2);
		// @ts-ignore — ScarfFeet so one struggle leaves partial progress (0.5 < 1.0)
		KDAddRestraintToSlot(1, [{ r: { name: 'ScarfFeet', Group: 'ItemFeet', power: 0 } }], {});
		// @ts-ignore
		KDStrugglePlayerSlot(1, 'ItemFeet', 'Struggle');   // one attempt: partial
		const before: any = KDGetWornRestraintsFor(1)[0];
		const progBefore = before ? before.struggleProgress : null;
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const item: any = restored && restored.restraintList ? restored.restraintList[0] : null;
		const out = { progBefore, present: !!item, progAfter: item ? item.struggleProgress : null };
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.progBefore).toBeGreaterThan(0);   // one struggle made partial progress
	expect(r.present).toBe(true);
	expect(r.progAfter).toBe(r.progBefore);    // progress survived the round-trip
});

test('slot 0 defers to the engine struggle (SP path), touching no per-slot list', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — no restraint on P1 in fresh state → engine returns a non-success string
		const res = KDStrugglePlayerSlot(0, 'ItemArms', 'Struggle');
		return { res, type: typeof res };
	});
	expect(r.type).toBe('string');     // returned the engine's result vocabulary
	expect(r.res).not.toBe('Success'); // nothing to escape on P1 → not a success
});
