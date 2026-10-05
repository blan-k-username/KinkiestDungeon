/**
 * E2E — the quick-bind fix: with the demo bootstrap pre-selecting the player's owned
 * binding material (coop-bootstrap.js ensureQuickBind), the stock "Tie Up" cast opens the bind
 * submenu ALREADY in the generic view with the OWNED material's category selected — no manual
 * toggle, no category hunting. Clicking the rope restraint then binds the defeated peer.
 *
 * This is the user-facing acceptance for "Tie Up now just works": after defeat, B casts Bondage
 * (Tie Up) and the submenu is pre-defaulted to StrongMagicRope; a single rope-item click chain
 * applies the restraint to Player A.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar, coopDefeatPeer, coopAwaitTick, coopSendWait } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const RAW = 'StrongMagicRopeRaw';

test('Tie Up works out-of-the-box: quick-bind pre-selects owned material, bind reaches Player A', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();


	try {
		await bootCoopPair(A, B, port);
		const session = bridge.session;

		// the bootstrap should have pre-selected B's owned raw material as the quick-bind item
		const quickBind = await B.evaluate(() => {
			// @ts-ignore
			const it = (typeof KinkyDungeonTargetingSpellItem !== 'undefined') ? KinkyDungeonTargetingSpellItem : null;
			return it ? it.name : null;
		});
		expect(quickBind, 'bootstrap should pre-select an owned binding material as quick-bind').toBe(RAW);

		// wear A down to defeated
		await coopDefeatPeer(B, A, () => session.isDefeated('A'));
		expect(session.isDefeated('A')).toBe(true);

		const before = session.snapshotFor('A').restraints.length;
		const peer = await waitForPeerAvatar(B);

		// "Tie Up" → with the quick-bind pre-selected, the submenu opens straight into the generic
		// view with the OWNED rope category — no toggle, no category click needed.
		const opened = await B.evaluate((p) => {
			// @ts-ignore
			KDSendInput('tryCastSpell', { tx: p.x, ty: p.y, spell: KDBondageSpell, spellname: 'Bondage', enemy: undefined, player: KDPlayer(), bullet: undefined });
			return {
				// @ts-ignore
				drawState: KinkyDungeonDrawState,
				// @ts-ignore
				generic: KDNPCBindingGeneric,
				// @ts-ignore
				category: KDSelectedGenericRestraintType,
			};
		}, peer);
		expect(opened.drawState).toBe('Bondage');
		expect(opened.generic, 'submenu should open in generic view').toBe(true);
		expect(opened.category, 'submenu should default to the owned rope category').toBe(RAW);

		// click the rope restraint (no category selection step) → applies
		await B.evaluate((p) => {
			const draw = () => {
				// @ts-ignore
				KDButtonsCache = {};
				// @ts-ignore
				KDDrawCollectionRestrainMain(p.id, 1300, 250);
			};
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

		// routed → submitted as B's action; A waits → reconcile
		await coopAwaitTick(B, () => coopSendWait(A), { turns: 'one' });

		const after = session.snapshotFor('A').restraints;
		expect(after.length, `A should be bound via default Tie Up flow (was ${before})`).toBeGreaterThan(before);
		expect(after.some((x: any) => typeof x.name === 'string' && x.name.indexOf('StrongMagicRope') === 0)).toBe(true);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
