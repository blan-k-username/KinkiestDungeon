/**
 * E2E (KD-101) — repeated ties must not crash the attacker's client.
 *
 * Live crash: after several "Tie Up" applies the attacker hit
 *   "Cannot read properties of null (reading 'sgroup')"  (KDGetNPCBindingSlotForItem(...).sgroup)
 * because the tie submenu runs LOCALLY and writes KDGameData.NPCRestraints, which the snapshot never
 * reset — so the avatar's local binding slots filled up and the stock apply crashed. render-client.apply
 * now resets each peer avatar's local NPC bondage per snapshot. This ties several DIFFERENT rope
 * restraints across turns and asserts: no 'sgroup' page error on the attacker, and the victim
 * accumulates the restraints (real bind, server-authoritative + rendered on the victim's client).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const ITEMS = ['StrongMagicRopeArmsBoxtie', 'StrongMagicRopeFeet', 'StrongMagicRopeLegs', 'StrongMagicRopeCrotch'];

test('repeated ties do not crash the attacker and the victim accumulates restraints', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const bErrors: string[] = [];
	B.on('pageerror', (e) => bErrors.push(String(e && e.message || e)));

	const aBoundNames = () => A.evaluate(() => /* @ts-ignore */ (typeof KinkyDungeonAllRestraint === 'function' ? KinkyDungeonAllRestraint().map((r: any) => r.name) : []));

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

		// tie a DIFFERENT rope restraint each turn (fills different slots — the live crash scenario)
		for (const item of ITEMS) {
			const peer = await waitForPeerAvatar(B);
			if (!peer) break;
			await B.evaluate(({ p, it }) => {
				// @ts-ignore — open the tie submenu (bootstrap quick-bind pre-selected the rope material)
				KDSendInput('tryCastSpell', { tx: p.x, ty: p.y, spell: KDBondageSpell, spellname: 'Bondage', enemy: undefined, player: KDPlayer(), bullet: undefined });
				const draw = () => { /* @ts-ignore */ KDButtonsCache = {}; /* @ts-ignore */ KDDrawCollectionRestrainMain(p.id, 1300, 250); };
				draw();
				// @ts-ignore — select this specific rope item, then click to apply
				KDSelectedGenericBindItem = it;
				draw();
				for (let n = 0; n < 2; n++) {
					// @ts-ignore
					const btn = KDButtonsCache['gen_bind_list' + it];
					if (btn && btn.func) btn.func(btn);
					draw();
				}
			}, { p: peer, it: item });
			const tB = await B.evaluate(() => (window as any).__coop.lastTick);
			const tA = await A.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
			await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tA, { timeout: 30_000 });
			await A.waitForTimeout(150);
		}

		// no crash on the attacker (the live `.sgroup` on null)
		const sgroupErr = bErrors.filter((e) => /sgroup|Cannot read properties of null/i.test(e));
		expect(sgroupErr, `attacker crashed: ${JSON.stringify(sgroupErr)}`).toEqual([]);

		// the victim really accumulated restraints (server-authoritative + rendered on A's client)
		const aNames = await aBoundNames();
		expect(aNames.length, `A should accumulate multiple restraints (got ${JSON.stringify(aNames)})`).toBeGreaterThan(1);
		expect(aNames.every((n: string) => n.indexOf('StrongMagicRope') === 0)).toBe(true);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
