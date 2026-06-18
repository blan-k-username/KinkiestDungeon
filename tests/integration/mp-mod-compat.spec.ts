/**
 * Mod-list compatibility warning (join + load).
 *
 * The comparator is pure; these single-page tests drive it directly against the
 * bundle. They cover: identical sets match; each mismatch kind (missing / extra /
 * version / order) is detected and bucketed; the guest-side receive stashes a
 * non-blocking warning; and a save's recorded mod list is compared on load.
 */
import { test, expect } from '../helpers/playwright-fixtures';

const A = [{ name: 'alpha', version: '1' }, { name: 'beta', version: '2' }];

test('identical mod sets match (no warning)', async ({ kdPage }) => {
	const r = await kdPage.evaluate((a) => {
		// @ts-ignore
		return KDCompareModLists(a, a.slice());
	}, A);
	expect(r.match).toBe(true);
	expect(r.missing).toEqual([]);
	expect(r.extra).toEqual([]);
	expect(r.versionMismatch).toEqual([]);
	expect(r.orderMismatch).toBe(false);
});

test('each mismatch kind is detected and bucketed', async ({ kdPage }) => {
	const r = await kdPage.evaluate((a) => {
		// @ts-ignore
		const missing = KDCompareModLists(a, [{ name: 'alpha', version: '1' }]);          // beta absent on other
		// @ts-ignore
		const extra = KDCompareModLists(a, a.concat([{ name: 'gamma', version: '9' }]));   // gamma extra on other
		// @ts-ignore
		const ver = KDCompareModLists(a, [{ name: 'alpha', version: '1' }, { name: 'beta', version: 'X' }]);
		// @ts-ignore
		const order = KDCompareModLists(a, [{ name: 'beta', version: '2' }, { name: 'alpha', version: '1' }]);
		return { missing, extra, ver, order };
	}, A);
	expect(r.missing.match).toBe(false);
	expect(r.missing.missing).toEqual(['beta']);
	expect(r.extra.match).toBe(false);
	expect(r.extra.extra).toEqual(['gamma']);
	expect(r.ver.match).toBe(false);
	expect(r.ver.versionMismatch).toEqual(['beta']);
	expect(r.order.match).toBe(false);
	expect(r.order.orderMismatch).toBe(true);
});

test('guest-side receive stashes a non-blocking warning string', async ({ kdPage }) => {
	const r = await kdPage.evaluate((a) => {
		// vanilla local set (no mods) vs a host advertising two mods → mismatch
		// @ts-ignore
		const before = MPState.modWarning;
		// @ts-ignore
		KDReceiveHostModList(a);
		// @ts-ignore
		const warn = MPState.modWarning;
		// matching set → cleared back to null
		// @ts-ignore
		KDReceiveHostModList(KDGetLocalModList());
		// @ts-ignore
		const cleared = MPState.modWarning;
		// @ts-ignore
		MPState.modWarning = before;
		return { warn, cleared };
	}, A);
	expect(typeof r.warn).toBe('string');
	expect(r.warn.length).toBeGreaterThan(0);
	expect(r.cleared).toBeNull();
});

test('a save records its mod list and load-time compare warns on mismatch', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — the live save records the (vanilla) local mod set
		const save = KinkyDungeonGenerateSaveData();
		const recorded = save.modList;
		// A save authored under a different mod set → warning vs our (vanilla) local set
		const foreign = { modList: [{ name: 'alpha', version: '1' }] };
		// @ts-ignore
		const diffForeign = KDSaveModWarning(foreign);
		// Our own freshly-generated save matches our local set → no warning
		// @ts-ignore
		const diffSelf = KDSaveModWarning(save);
		// A legacy save with no recorded list → no warning (matched)
		// @ts-ignore
		const diffLegacy = KDSaveModWarning({});
		return {
			recordedIsArray: Array.isArray(recorded),
			foreignMatch: diffForeign.match,
			selfMatch: diffSelf.match,
			legacyMatch: diffLegacy.match,
		};
	});
	expect(r.recordedIsArray).toBe(true);
	expect(r.foreignMatch).toBe(false);  // foreign mod set warns
	expect(r.selfMatch).toBe(true);      // own save matches
	expect(r.legacyMatch).toBe(true);    // legacy save (no list) does not warn
});
