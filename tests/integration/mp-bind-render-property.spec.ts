/**
 * KD-103 diagnostic (PROPERTY-level, NOT pixels).
 *
 * Question: which object/property drives the worn-restraint render on the player, and does the
 * thin-client "hand-rebuild" path (render-client.js:233-263) drive it the same way the REAL game
 * path (KinkyDungeonAddRestraint, used by enemies) does?
 *
 * We apply the SAME arms restraint (ScarfArms — Group ItemArms, Model TapeArms) two ways and
 * compare the player's model container computed state:
 *   MC = KDCurrentModels.get(KinkyDungeonPlayer)
 *     - MC.Poses    — recomputed by UpdateModels() from Appearance (drives the bound POSE)
 *     - MC.Models   — the drawn layers (drives the restraint sprite)
 *   KinkyDungeonPlayer.Appearance.length
 *
 *   PATH A — real:         KinkyDungeonAddRestraint(rdef, ...)
 *   PATH B — hand-rebuild:  set KinkyDungeonInventory.get(Restraint) Map + DressPlayer (render-client clone)
 *   PATH C — hand-rebuild + explicit UpdateModels(KinkyDungeonPlayer)
 *
 * NOTE: bundle `const`/`let` globals are NOT on globalThis — read them as BARE identifiers.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('worn-restraint render is driven by UpdateModels (poses), which the hand-rebuild path may skip', async ({ kdPage }) => {
	const result = await kdPage.evaluate(() => {
		/* eslint-disable */
		// @ts-nocheck
		const snap = () => {
			// @ts-ignore
			const MC = KDCurrentModels.get(KinkyDungeonPlayer);
			return {
				// @ts-ignore
				poses: MC ? Object.keys(MC.Poses || {}).filter((k) => MC.Poses[k]).sort() : ['<no MC>'],
				// @ts-ignore
				models: MC && MC.Models ? Array.from(MC.Models.keys()).sort() : ['<no MC>'],
				// @ts-ignore
				appearance: (typeof KinkyDungeonPlayer !== 'undefined' && KinkyDungeonPlayer.Appearance) ? KinkyDungeonPlayer.Appearance.length : -1,
				// @ts-ignore
				worn: typeof KinkyDungeonAllRestraint === 'function' ? KinkyDungeonAllRestraint().map((r) => r.name) : [],
			};
		};

		// @ts-ignore — use the EXACT restraint the MP tie applies, so the pose/model sets are comparable
		const rdef = (typeof KinkyDungeonGetRestraintByName === 'function' && KinkyDungeonGetRestraintByName('StrongMagicRopeArmsBoxtie'))
			// @ts-ignore
			|| (KinkyDungeonRestraints || []).find((r) => r.name === 'ScarfArms')
			// @ts-ignore
			|| (KinkyDungeonRestraints || []).find((r) => r.Group === 'ItemArms' && r.Model);
		if (!rdef) return { error: 'no arms restraint found' };

		// @ts-ignore
		KinkyDungeonDressPlayer(KinkyDungeonPlayer);
		const baseline = snap();

		// ---------- PATH A: the REAL game call (what enemies use) ----------
		// @ts-ignore
		KinkyDungeonAddRestraint(rdef, 2, true);
		// @ts-ignore
		KinkyDungeonDressPlayer(KinkyDungeonPlayer);
		const pathA = snap();

		// capture a "snapshot item" clone the way the server would ship it
		// @ts-ignore
		const wornItem = KinkyDungeonAllRestraint().find((r) => (r.name || '').indexOf(rdef.name) === 0) || KinkyDungeonAllRestraint()[0];
		const shipped = JSON.parse(JSON.stringify(wornItem));

		// ---------- strip back to baseline ----------
		// @ts-ignore
		KinkyDungeonInventory.set(Restraint, new Map());
		// @ts-ignore
		if (typeof KinkyDungeonRefreshRestraintsCache === 'function') KinkyDungeonRefreshRestraintsCache();
		// @ts-ignore
		KDRefreshCharacter.set(KinkyDungeonPlayer, true);
		// @ts-ignore
		KinkyDungeonDressPlayer(KinkyDungeonPlayer);
		const stripped = snap();

		// ---------- PATH B: render-client hand-rebuild (render-client.js:233-263) ----------
		const rmap = new Map();
		rmap.set(shipped.name, shipped);
		// @ts-ignore
		KinkyDungeonInventory.set(Restraint, rmap);
		// @ts-ignore
		if (typeof KinkyDungeonRefreshRestraintsCache === 'function') KinkyDungeonRefreshRestraintsCache();
		// @ts-ignore
		if (typeof KinkyDungeonCheckClothesLoss !== 'undefined') KinkyDungeonCheckClothesLoss = true;
		// @ts-ignore
		KDRefreshCharacter.set(KinkyDungeonPlayer, true);
		// @ts-ignore
		KinkyDungeonDressPlayer(KinkyDungeonPlayer);
		const pathB = snap();

		// ---------- PATH C: hand-rebuild + explicit UpdateModels ----------
		// @ts-ignore
		if (typeof UpdateModels === 'function') UpdateModels(KinkyDungeonPlayer);
		const pathC = snap();

		return { rdefName: rdef.name, baseline, pathA, stripped, pathB, pathC };
		/* eslint-enable */
	});

	// eslint-disable-next-line no-console
	console.log('=== BIND RENDER PROPERTY DIAG ===\n' + JSON.stringify(result, null, 2));

	expect((result as any).error).toBeUndefined();
	const r: any = result;
	expect(r.pathA.worn.length).toBeGreaterThan(0);
	expect(r.pathA.appearance).toBeGreaterThan(r.baseline.appearance);
	// does the hand-rebuild reach the SAME pose/model state as the real call?
	expect({ poses: r.pathB.poses, models: r.pathB.models }).toEqual({ poses: r.pathA.poses, models: r.pathA.models });
});
