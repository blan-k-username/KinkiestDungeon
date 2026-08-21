/**
 * E2E: a bundle key that VANISHES must put its global back to the default — in the real browser.
 *
 * The UAT crash this closes:
 *
 *     Uncaught TypeError: Cannot read properties of null (reading 'struggleProgress')
 *         at KDDrawStruggleGroups (out/main.js) — KinkyDungeonHUD.ts:3511
 *
 * `_captureGlobals` records a watched global only while it DIFFERS from the post-init baseline
 * (headless-host.js:1862), so struggling free put `KinkyDungeonStruggleGroups` back to `[]` and it
 * left the bundle. The host resets absent-but-dirty globals to their default (:2039-2048); the
 * browser's `adoptBundle` only assigned keys that were PRESENT, so the client kept the stale group,
 * `KinkyDungeonGetRestraintItem` returned null for it, and the unguarded draw path crashed on hover.
 *
 * The CONTROL half is what stops this being a vacuous oracle: with `window.KDAbsentReset` removed,
 * the same two snapshots must still go stale — i.e. it reproduces the old behaviour on demand. If
 * the rule ever stops being wired up, the fixed half fails while the control still passes.
 *
 * KDM-216 — `isolatedPage`, not `kdPage`: this spec injects render-client.js, whose wrappers a
 * resetKDState() cannot undo.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_ABSENT_RESET_BROWSER } = require('../../tools/mp-server/kd-absent-reset');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_CODEC } = require('../../tools/mp-server/kd-codec');

const CODEC_BROWSER = `${KD_CODEC}\n;(typeof window !== 'undefined' ? window : globalThis).KDCodec = `
	+ `{ kdEnc: kdEnc, kdDec: kdDec, kdSer: kdSer };\n`;

test('a global dropped from the bundle goes back to its default (and the stale group cannot crash the HUD)', async ({ isolatedPage }) => {
	await bootKD(isolatedPage);
	await isolatedPage.addScriptTag({ content: CODEC_BROWSER });
	await isolatedPage.addScriptTag({ content: KD_ABSENT_RESET_BROWSER });
	await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });

	const result = await isolatedPage.evaluate(() => {
		/* eslint-disable */
		// @ts-nocheck
		const w = window as any;
		// @ts-ignore
		KinkyDungeonStartNewGame(false);
		// @ts-ignore
		KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';

		// A minimally-shaped snapshot: only the bundle matters here.
		const snapWith = () => ({
			messages: { log: [] },
			bundle: { v: 1, gameData: {}, globals: {
				KinkyDungeonStruggleGroups: [{ group: 'ItemHands', left: true, y: 0, icon: 'ItemHands', name: 'DuctTapeHands' }],
			} },
		});
		// The SAME player, now free: the global is back at its default, so the capture omits it.
		const snapWithout = () => ({ messages: { log: [] }, bundle: { v: 1, gameData: {}, globals: {} } });

		// @ts-ignore
		const read = () => (KinkyDungeonStruggleGroups || []).map((g: any) => g.group);

		const pristine = read();

		// ---- CONTROL: no rule wired up == the old behaviour, which must still go stale ----
		const savedRule = w.KDAbsentReset;
		delete w.KDAbsentReset;
		w.KDRenderClient.apply(snapWith());
		const controlBound = read();
		w.KDRenderClient.apply(snapWithout());
		const controlFreed = read();
		w.KDAbsentReset = savedRule;

		// Put the client back to the default by hand so the two halves start level.
		// @ts-ignore
		KinkyDungeonStruggleGroups = [];

		// ---- FIXED: the rule is present ----
		w.KDRenderClient.apply(snapWith());
		const fixedBound = read();
		w.KDRenderClient.apply(snapWithout());
		const fixedFreed = read();

		// And the consequence that actually crashed: a cached group whose restraint is gone.
		// @ts-ignore
		const itemForStaleGroup = (typeof KinkyDungeonGetRestraintItem === 'function')
			// @ts-ignore
			? KinkyDungeonGetRestraintItem('ItemHands') : 'no-fn';

		return { pristine, controlBound, controlFreed, fixedBound, fixedFreed, itemForStaleGroup };
	});

	// The control reproduces the bug: adopted, then STILL adopted after the key vanished.
	expect(result.controlBound).toEqual(['ItemHands']);
	expect(result.controlFreed).toEqual(['ItemHands']);

	// The fix: adopted, then back to the default the moment the bundle stops carrying it.
	expect(result.fixedBound).toEqual(['ItemHands']);
	expect(result.fixedFreed).toEqual([]);
	expect(result.fixedFreed).toEqual(result.pristine);

	// …which is what makes the stale-group dereference unreachable: no group, nothing to hover.
	expect(result.itemForStaleGroup == null).toBe(true);
});
