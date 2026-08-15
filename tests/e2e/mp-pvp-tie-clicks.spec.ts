/**
 * E2E (KD-101) — "Tie Up" via the REAL submenu BUTTONS, reproducing and pinning the live root cause.
 *
 * Server + reconcile bind A whenever addNPCRestraint fires (see mp-pvp-tie.spec.ts). The live "Tie Up
 * does nothing" is a UI-path issue: the generic-bind submenu defaults its selected material to the
 * FIRST category in the global list (ChainRaw), but the demo players carry only StrongMagicRopeRaw.
 * Clicking a restraint while a material you don't own is selected is gated out (quantity >= count, with
 * quantity === undefined), so addNPCRestraint never fires. Selecting the rope category you DO own makes
 * the bind apply. This test drives the genuine button funcs (what a canvas click does) and pins both:
 *   - default category (unowned)  → A is NOT bound  ("does nothing")
 *   - owned rope category selected → A IS bound
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const RAW = 'StrongMagicRopeRaw';

test('PvP tie via real submenu buttons: wrong material does nothing, owned material binds', async ({ browser }) => {
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
		expect(session.isDefeated('A')).toBe(true);

		const peer = await peerOfB();

		// open the tie submenu (what clicking "Tie Up" does) and toggle to the generic raw-material view.
		// Clear any quick-bind selection first so the submenu falls back to the global default category
		// (the pre-fix situation) — this test pins the base-game gate, independent of the bootstrap fix.
		const setup = await B.evaluate((p) => {
			// @ts-ignore
			KinkyDungeonTargetingSpellItem = null;
			// @ts-ignore — clear any prior generic selection so the menu re-defaults to the global first category
			KDSelectedGenericRestraintType = '';
			// @ts-ignore
			KDNPCBindingGeneric = false;
			// @ts-ignore
			KDSelectedGenericBindItem = '';
			// @ts-ignore
			KDSendInput('tryCastSpell', { tx: p.x, ty: p.y, spell: KDBondageSpell, spellname: 'Bondage', enemy: undefined, player: KDPlayer(), bullet: undefined });
			const draw = () => {
				// @ts-ignore
				KDButtonsCache = {};
				// @ts-ignore
				KDDrawCollectionRestrainMain(p.id, 1300, 250);
			};
			draw();
			// @ts-ignore
			const toggle = KDButtonsCache['genericrestraint'];
			if (toggle && toggle.func) toggle.func(toggle);
			draw();
			return {
				// @ts-ignore
				drawState: KinkyDungeonDrawState,
				// @ts-ignore
				defaultCategory: KDSelectedGenericRestraintType,
				// @ts-ignore
				defaultItem: KDSelectedGenericBindItem,
			};
		}, peer);
		expect(setup.drawState, 'tie submenu should be open').toBe('Bondage');
		// the menu defaults to a material the demo player does NOT own (ChainRaw, not the rope they carry)
		expect(setup.defaultCategory).not.toBe(RAW);

		// --- Phase 1: click the rope item under the WRONG (default) category → must do nothing ---
		const beforeWrong = session.snapshotFor('A').restraints.length;
		await B.evaluate((p) => {
			const draw = () => {
				// @ts-ignore
				KDButtonsCache = {};
				// @ts-ignore
				KDDrawCollectionRestrainMain(p.id, 1300, 250);
			};
			draw();
			// @ts-ignore — click whatever item the (unowned) default category selected, twice
			const itemName = KDSelectedGenericBindItem;
			for (let n = 0; n < 2; n++) {
				// @ts-ignore
				const btn = KDButtonsCache['gen_bind_list' + itemName];
				if (btn && btn.func) btn.func(btn);
				draw();
			}
		}, peer);
		// nothing should have been submitted; give the loop a beat and confirm A is still unbound
		await B.waitForTimeout(500);
		expect(session.snapshotFor('A').restraints.length, 'wrong-material click must not bind A').toBe(beforeWrong);

		// --- Phase 2: select the OWNED rope category, then click the rope item → binds A ---
		const sentItem = await B.evaluate(({ p, raw }) => {
			const draw = () => {
				// @ts-ignore
				KDButtonsCache = {};
				// @ts-ignore
				KDDrawCollectionRestrainMain(p.id, 1300, 250);
			};
			draw();
			// @ts-ignore
			const cat = KDButtonsCache['res_gen_list' + raw];
			if (cat && cat.func) cat.func(cat);
			draw();
			// @ts-ignore
			const itemName = KDSelectedGenericBindItem;
			for (let n = 0; n < 2; n++) {
				// @ts-ignore
				const btn = KDButtonsCache['gen_bind_list' + itemName];
				if (btn && btn.func) btn.func(btn);
				draw();
			}
			return itemName;
		}, { p: peer, raw: RAW });

		// the apply is routed → submitted as B's action; A waits → turn resolves → reconcile
		const t1 = await B.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t1, { timeout: 30_000 });

		const after = session.snapshotFor('A').restraints;
		expect(after.length, `A should be bound after selecting the owned material (item ${sentItem})`).toBeGreaterThan(beforeWrong);
		expect(after.some((x: any) => typeof x.name === 'string' && x.name.indexOf('StrongMagicRope') === 0)).toBe(true);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
