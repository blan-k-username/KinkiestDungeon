/**
 * E2E (Playwright/Chromium) — KD-101: reproduce the live "Tie Up does nothing".
 *
 * Two browsers, PvP. B wears Player A down to defeated, then drives the REAL tie the submenu emits
 * (KDSendInput "addNPCRestraint" against A's avatar — NPCRestrain.ts:311), routed to the server. The
 * server replays it on the avatar; _reconcilePeers should mirror it onto A's real bundle. Asserts A
 * ends up wearing the restraint. If it doesn't, this reproduces the live bug deterministically.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

// The demo players' only binding item is the generic raw rope (StrongMagicRopeRaw), applied via the
// generic submenu, which emits a concrete rope restraint + the raw material as quantityItem.
const BIND = 'StrongMagicRopeArmsBoxtie';
const RAW = 'StrongMagicRopeRaw';

test('PvP tie: binding a defeated peer applies a real restraint to them', async ({ browser }) => {
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
	const advance = async (t0: number) => {
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
	};

	try {
		await bootCoopPair(A, B, port);
		const session = bridge.session;

		// --- B wears Player A down to defeated (real doattack on A's avatar) ---
		for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await peerOfB();
			expect(peer, 'B sees no peer avatar').not.toBeNull();
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await advance(t0);
		}
		expect(session.isDefeated('A'), 'A should be defeated before tying').toBe(true);

		// --- B ties Player A: drive the REAL addNPCRestraint the tie submenu emits ---
		const restraintsBefore = session.snapshotFor('A').restraints.length;
		const peer = await peerOfB();
		const sent = await B.evaluate(({ p, bind, raw }) => {
			// open the tie submenu the way "Tie Up" does (runs locally on the thin client)
			// @ts-ignore
			KDSendInput('tryCastSpell', { tx: p.x, ty: p.y, spell: KDBondageSpell, spellname: 'Bondage', enemy: undefined, player: KDPlayer(), bullet: undefined });
			// @ts-ignore — compute the slot the submenu would, then emit the generic-rope apply (NPCRestrain.ts:311)
			const r = (typeof KinkyDungeonGetRestraintByName === 'function') ? KinkyDungeonGetRestraintByName(bind) : null;
			// @ts-ignore
			const slotInfo = (typeof KDGetNPCBindingSlotForItem === 'function' && r) ? KDGetNPCBindingSlotForItem(r, p.id) : null;
			const slot = slotInfo && slotInfo.sgroup ? slotInfo.sgroup.id : (slotInfo && slotInfo.id) || 'ItemHands';
			// @ts-ignore
			const itemId = (typeof KinkyDungeonGetItemID === 'function') ? KinkyDungeonGetItemID() : -1;
			// @ts-ignore — the raw material the generic UI consumes
			const rawItem = (typeof KinkyDungeonInventoryGet === 'function') ? KinkyDungeonInventoryGet(raw) : null;
			// @ts-ignore
			KDSendInput('addNPCRestraint', {
				slot, id: itemId, restraint: bind, restraintid: -1, lock: '',
				// @ts-ignore
				faction: (typeof KDDefaultNPCBindPalette !== 'undefined') ? KDDefaultNPCBindPalette : undefined,
				npc: p.id, time: 0, player: (KinkyDungeonPlayerEntity as any).id,
				quantityItem: rawItem, quantityCount: 1,
			});
			// @ts-ignore
			return { slot, gotRestraint: !!r, drawState: KinkyDungeonDrawState, hasRaw: !!rawItem };
		}, { p: peer, bind: BIND, raw: RAW });
		expect(sent.gotRestraint, `restraint def ${BIND} not found`).toBe(true);
		expect(sent.drawState, 'tie submenu should be open').toBe('Bondage');

		// the addNPCRestraint is routed → submitted as B's action; A waits → turn resolves → reconcile
		const t1 = await B.evaluate(() => (window as any).__coop.lastTick);
		await advance(t1);

		const after = session.snapshotFor('A').restraints;
		expect(after.length, `A should gain a restraint (was ${restraintsBefore}, slot=${sent.slot})`).toBeGreaterThan(restraintsBefore);
		expect(after.some((x: any) => x.name === BIND)).toBe(true);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
