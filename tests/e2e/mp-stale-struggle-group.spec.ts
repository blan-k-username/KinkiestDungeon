/**
 * E2E: a struggle group with no worn item must not reach KD's HUD — in the real browser.
 *
 * Owner's UAT crash (2026-09-30), every frame once it started:
 *
 *     TypeError: Cannot read properties of null (reading 'type')
 *         at KDGetItemPreview ← KDDrawStruggleGroups
 *
 * `KinkyDungeonStruggleGroups` is KD's cache of the worn set, and the co-op client adopts the cache
 * (in the bundle) and the worn set (`restraints`) from the server separately. A snapshot where they
 * disagree left a group whose `KinkyDungeonGetRestraintItem` is null, and KD's HUD dereferences it
 * unguarded. How they fell out of step in that session is not yet known — so the client now drops
 * such entries (exactly what KD's own rebuild drops) and REPORTS them.
 *
 * CONTROL: a group that IS worn survives the same pass — the prune is not "empty the list".
 *
 * `isolatedPage`: this spec injects render-client.js, whose wrappers resetKDState() cannot undo.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_ABSENT_RESET_BROWSER } = require('../../tools/mp-server/kd-absent-reset');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_CODEC } = require('../../tools/mp-server/kd-codec');

const CODEC_BROWSER = `${KD_CODEC}\n;(typeof window !== 'undefined' ? window : globalThis).KDCodec = `
	+ `{ kdEnc: kdEnc, kdDec: kdDec, kdSer: kdSer };\n`;

test('a struggle group whose restraint is not worn is dropped and reported, a worn one is kept', async ({ isolatedPage }) => {
	const warnings: string[] = [];
	isolatedPage.on('console', (m: any) => { if (m.type() === 'warning') warnings.push(m.text()); });
	await bootKD(isolatedPage);
	await isolatedPage.addScriptTag({ content: CODEC_BROWSER });
	await isolatedPage.addScriptTag({ content: KD_ABSENT_RESET_BROWSER });
	await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });

	const result = await isolatedPage.evaluate(() => {
		/* eslint-disable */
		const w = window as any;
		// @ts-ignore
		KinkyDungeonStartNewGame(false);
		// @ts-ignore
		KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
		const group = (g: string, name: string) => ({ group: g, left: true, y: 0, icon: g, name });
		// @ts-ignore
		const read = () => (KinkyDungeonStruggleGroups || []).map((g: any) => g.group);
		// @ts-ignore
		const tape = { name: 'DuctTapeHands', type: Restraint, id: 1, events: [] };

		// The owner's state: the cache names a group, the worn set does not have it.
		w.KDRenderClient.apply({
			messages: { log: [] }, restraints: [],
			bundle: { v: 1, gameData: {}, globals: { KinkyDungeonStruggleGroups: [group('ItemBreast', 'Breastplate')] } },
		});
		const stale = read();
		// @ts-ignore
		const hazard = KinkyDungeonGetRestraintItem('ItemBreast');   // what KD's HUD would dereference

		// CONTROL: a group that is actually worn is left alone.
		w.KDRenderClient.apply({
			messages: { log: [] }, restraints: [tape],
			bundle: { v: 1, gameData: {}, globals: { KinkyDungeonStruggleGroups: [group('ItemHands', 'DuctTapeHands')] } },
		});
		// @ts-ignore
		const wornItem = !!KinkyDungeonGetRestraintItem('ItemHands');
		const kept = read();
		return { stale, hazard, wornItem, kept, count: w.KDRenderClient.staleStruggleGroups || 0 };
	});

	expect(result.hazard, 'precondition: the stale group really has no item (the crash input)').toBeNull();
	expect(result.stale, 'the stale group never reaches the HUD').toEqual([]);
	expect(result.count, 'counted').toBe(1);
	expect(warnings.some((t) => t.includes('dropped stale struggle group') && t.includes('ItemBreast')),
		'reported with the group, so the next occurrence names its cause').toBe(true);

	expect(result.wornItem, 'precondition: the control group is worn').toBe(true);
	expect(result.kept, 'a worn group is kept').toEqual(['ItemHands']);
});
