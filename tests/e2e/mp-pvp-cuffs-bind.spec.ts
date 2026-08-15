/**
 * E2E (KD-101) — applying the cuffs ITEM to a peer binds them in DATA (server bundle + victim client),
 * isolating the remaining gap to the visual paper-doll (which doesn't re-dress on the thin client).
 * Drives the exact input the cuffs submenu emits (addNPCRestraint slot=Wrists restraint=HingedCuffs).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const CUFFS = 'HingedCuffs';

test('applying the cuffs item to a defeated peer binds them in data', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	process.env.KD_START_RESTRAINT = CUFFS;
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
	const aBound = () => A.evaluate(() => /* @ts-ignore */ (typeof KinkyDungeonAllRestraint === 'function' ? KinkyDungeonAllRestraint().map((r: any) => r.name) : []));

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

		const before = session.snapshotFor('A').restraints.length;
		const peer = await peerOfB();

		// emit the exact input the cuffs submenu sends (per-slot path; concrete restraint, no quantityItem)
		const sent = await B.evaluate(({ p, cuffs }) => {
			// @ts-ignore
			const r = KinkyDungeonGetRestraintByName(cuffs);
			// @ts-ignore
			const slotInfo = (typeof KDGetNPCBindingSlotForItem === 'function' && r) ? KDGetNPCBindingSlotForItem(r, p.id) : null;
			const slot = slotInfo && slotInfo.sgroup ? slotInfo.sgroup.id : 'Wrists';
			// @ts-ignore
			const itemId = (typeof KinkyDungeonGetItemID === 'function') ? KinkyDungeonGetItemID() : -1;
			// @ts-ignore
			KDSendInput('addNPCRestraint', { slot, id: itemId, restraint: cuffs, restraintid: itemId, lock: '', npc: p.id, time: 1, player: (KinkyDungeonPlayerEntity as any).id });
			return { slot };
		}, { p: peer, cuffs: CUFFS });

		const t1 = await B.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t1, { timeout: 30_000 });
		await A.waitForTimeout(300);

		// server bundle bound
		const serverNames = session.snapshotFor('A').restraints.map((r: any) => r.name);
		expect(serverNames.length, `A's server bundle should gain a restraint (slot ${sent.slot}, was ${before})`).toBeGreaterThan(before);
		expect(serverNames).toContain(CUFFS);
		// victim client data bound
		expect(await aBound()).toContain(CUFFS);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
		delete process.env.KD_START_RESTRAINT;
	}
});
