/**
 * DIAGNOSTIC — after a tie, dump the VICTIM's render-model state to find why the worn restraint
 * doesn't appear on the drawn sprite. Checks: worn data, Appearance + whether items carry a .Model,
 * the drawn ModelContainer (KDCurrentModels.get(KinkyDungeonPlayer)) Models/Poses, and whether
 * KinkyDungeonDressPlayer / UpdateModels / ForceRefreshModels throw.
 */
import { test } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('DIAG: victim render-model state after a tie', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const peerOfB = () => B.evaluate(() => {
		// @ts-ignore
		const e = ((KDMapData as any).Entities || []).find((x: any) => x.Enemy && x.Enemy.name && x.Enemy.name.indexOf('RemotePlayer') === 0);
		return e ? { id: e.id, x: e.x, y: e.y } : null;
	});

	try {
		await bootCoopPair(A, B, port);
		const session = bridge.session;

		for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await peerOfB();
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
		}

		const peer = await peerOfB();
		await B.evaluate((p) => {
			// @ts-ignore
			KDSendInput('tryCastSpell', { tx: p.x, ty: p.y, spell: KDBondageSpell, spellname: 'Bondage', enemy: undefined, player: KDPlayer(), bullet: undefined });
			const draw = () => { /* @ts-ignore */ KDButtonsCache = {}; /* @ts-ignore */ KDDrawCollectionRestrainMain(p.id, 1300, 250); };
			draw();
			// @ts-ignore
			const itemName = KDSelectedGenericBindItem;
			for (let n = 0; n < 2; n++) {
				// @ts-ignore
				const btn = KDButtonsCache['gen_bind_list' + itemName];
				if (btn && btn.func) btn.func(btn);
				draw();
			}
		}, peer);
		const tB = await B.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
		await A.waitForTimeout(500);

		const diag = await A.evaluate(() => {
			const out: any = {};
			const w = window as any;
			// @ts-ignore
			out.worn = (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().map((r: any) => r.name) : 'no-fn';
			// @ts-ignore
			const P = (typeof KinkyDungeonPlayer !== 'undefined') ? KinkyDungeonPlayer : null;
			out.hasPlayerChar = !!P;
			out.appearanceLen = P && P.Appearance ? P.Appearance.length : -1;
			out.appearanceWithModel = P && P.Appearance ? P.Appearance.filter((a: any) => a && a.Model).length : -1;
			out.appearanceAssets = P && P.Appearance ? P.Appearance.map((a: any) => (a.Asset && a.Asset.Name) || (a.Model && a.Model.Name) || '?').slice(0, 40) : [];
			// drawn model container
			// @ts-ignore
			const KDCM = (typeof KDCurrentModels !== 'undefined') ? KDCurrentModels : null;
			out.hasKDCurrentModels = !!KDCM;
			const MC = KDCM && P ? KDCM.get(P) : null;
			out.hasModelContainer = !!MC;
			if (MC) {
				out.modelsSize = MC.Models ? MC.Models.size : -1;
				out.modelKeys = MC.Models ? Array.from(MC.Models.keys()).slice(0, 60) : [];
				out.posesSize = MC.Poses ? (MC.Poses.size != null ? MC.Poses.size : Object.keys(MC.Poses).length) : -1;
				out.updateSize = MC.Update ? MC.Update.size : -1;
				out.refreshSize = MC.Refresh ? MC.Refresh.size : -1;
			}
			// try the rebuild calls explicitly, capturing errors
			out.calls = {};
			try { /* @ts-ignore */ KDRefreshCharacter.set(P, true); out.calls.refreshSet = 'ok'; } catch (e: any) { out.calls.refreshSet = 'ERR:' + e.message; }
			try { /* @ts-ignore */ KinkyDungeonDressPlayer(P); out.calls.dress = 'ok'; } catch (e: any) { out.calls.dress = 'ERR:' + e.message; }
			out.fnUpdateModels = (typeof w.UpdateModels === 'function') || (typeof (window as any).UpdateModels) !== 'undefined' ? 'fn?' : 'missing';
			try { /* @ts-ignore */ out.calls.updateModels = (typeof UpdateModels === 'function') ? (UpdateModels(P), 'ok') : 'no-UpdateModels'; } catch (e: any) { out.calls.updateModels = 'ERR:' + e.message; }
			try { /* @ts-ignore */ out.calls.forceRefresh = (typeof ForceRefreshModels === 'function') ? (ForceRefreshModels(P), 'ok') : 'no-ForceRefreshModels'; } catch (e: any) { out.calls.forceRefresh = 'ERR:' + e.message; }
			// after the explicit rebuild, re-read the model
			const MC2 = KDCM && P ? KDCM.get(P) : null;
			out.afterModelsSize = MC2 && MC2.Models ? MC2.Models.size : -1;
			out.afterModelKeys = MC2 && MC2.Models ? Array.from(MC2.Models.keys()).slice(0, 60) : [];
			return out;
		});

		console.log('=== RENDER DIAG ===');
		console.log(JSON.stringify(diag, null, 2));
		console.log('=== END RENDER DIAG ===');
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
