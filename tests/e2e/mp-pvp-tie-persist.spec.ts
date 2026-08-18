/**
 * E2E (KD-101) — a tie must PERSIST on the VICTIM. After B ties A, A stays bound on A's own client
 * across many turns (the reconcile adds to A's bundle and never removes; A's client renders it from
 * the snapshot). The peer-avatar's per-turn bondage gauge is cleared each turn on the server (so its
 * binding slots never overfill — that overfill crashed the stock submenu apply), so this asserts the
 * AUTHORITATIVE/victim view, not the attacker's transient avatar display.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('a tie persists on the victim across many turns', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const aBoundNames = () => A.evaluate(() => /* @ts-ignore */ (typeof KinkyDungeonAllRestraint === 'function' ? KinkyDungeonAllRestraint().map((r: any) => r.name) : []));

	const bothWaitAdvance = async () => {
		const tB = await B.evaluate(() => (window as any).__coop.lastTick);
		const tA = await A.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tA, { timeout: 30_000 });
	};

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

		// B ties A (bootstrap quick-bind pre-selected the owned rope)
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
		// resolve the TIE turn with ONLY A waiting — B's action this turn IS the tie; a B wait here
		// would (correctly) replace the pending tie via the manual re-submit behavior.
		{
			const tB = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
		}
		await A.waitForTimeout(300);

		const boundAfterTie = (await aBoundNames()).length;
		expect(boundAfterTie, 'A should be bound right after the tie').toBeGreaterThan(0);

		// advance several turns — the victim's bind must hold (reconcile never removes it)
		for (let t = 0; t < 5; t++) await bothWaitAdvance();
		await A.waitForTimeout(300);

		// A is STILL bound on A's own client (count unchanged — persisted, not duplicated, not dropped)
		const boundLater = await aBoundNames();
		expect(boundLater.length, `A should stay bound across turns (was ${boundAfterTie}, now ${boundLater.length})`).toBe(boundAfterTie);
		expect(boundLater.some((n: string) => n.indexOf('StrongMagicRope') === 0)).toBe(true);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
