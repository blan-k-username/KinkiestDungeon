/**
 * E2E (KD-101) — the bound peer must SEE the restraint on their own client.
 *
 * Live symptom: B ties A (B's log shows "You apply the Spellbound Thighs to Player A"), but A's screen
 * shows nothing. Root cause: the reconcile binds A's bundle server-side (and the render snapshot even
 * carries a `restraints` list), but `render-client.apply` never rebuilds the victim's worn-restraint
 * Map — so A's client renders no restraint. This test pins both halves: the SERVER reconciles A's
 * restraints, AND A's CLIENT reflects them (KinkyDungeonAllRestraint on A's page).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('a tied peer sees the restraint on their own client', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const aRestraints = () => A.evaluate(() => /* @ts-ignore */ (typeof KinkyDungeonAllRestraint === 'function' ? KinkyDungeonAllRestraint().map((r: any) => r.name) : []));

	try {
		await bootCoopPair(A, B, port);
		const session = bridge.session;

		for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await waitForPeerAvatar(B);
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
		}
		expect(session.isDefeated('A')).toBe(true);
		expect((await aRestraints()).length, 'A starts unbound').toBe(0);

		// baseline of A's paper-doll (BC Character appearance) BEFORE the tie
		const apBefore = await A.evaluate(() => /* @ts-ignore */ (typeof KinkyDungeonPlayer !== 'undefined' && KinkyDungeonPlayer && KinkyDungeonPlayer.Appearance ? KinkyDungeonPlayer.Appearance.length : -1));

		// B ties A via the real submenu (bootstrap quick-bind has pre-selected the owned rope material)
		const peer = await waitForPeerAvatar(B);
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
		const tA = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tA, { timeout: 30_000 });
		await A.waitForTimeout(300); // let A apply the snapshot

		// SERVER side: A's bundle is bound
		const serverR = session.snapshotFor('A').restraints.map((r: any) => r.name);
		expect(serverR.length, 'server should have reconciled a restraint onto A').toBeGreaterThan(0);

		// CLIENT side: A must SEE the restraint (the live gap)
		const clientR = await aRestraints();
		expect(clientR.length, `A's client should render the restraint (server has ${JSON.stringify(serverR)})`).toBeGreaterThan(0);
		expect(clientR.some((n: string) => n.indexOf('StrongMagicRope') === 0)).toBe(true);

		// DATA ONLY: the worn restraint reaches the Character.Appearance DATA structure. NOTE: this does
		// NOT prove the restraint is RENDERED on the drawn sprite — the model registry updates but the
		// composited PIXI texture + pose do not, so the character stays visually unchanged. The real
		// visual render is tracked in KD-103 (see tests/e2e/mp-render-shot.spec.ts for the proof). Do
		// NOT treat this assertion as a visual success.
		const apAfter = await A.evaluate(() => /* @ts-ignore */ (typeof KinkyDungeonPlayer !== 'undefined' && KinkyDungeonPlayer && KinkyDungeonPlayer.Appearance ? KinkyDungeonPlayer.Appearance.length : -1));
		expect(apAfter, `A's appearance DATA should include the restraint (was ${apBefore}, now ${apAfter}) — NOT a visual check (KD-103)`).toBeGreaterThan(apBefore);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
