/**
 * E2E DEMO (KD-101) — records a watchable VIDEO of the full PvP flow from BOTH players' browsers:
 * wear a peer down → defeat → tie → the restraint shows on the victim. Produces two .webm files
 * (Player A view, Player B view) under tests/_artifacts/videos/. Not an assertion-heavy test — it's a
 * visual capture. Run it, then open the printed .webm paths.
 */
import { test } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';
import * as path from 'path';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const VID_DIR = path.resolve(__dirname, '../_artifacts/videos');
const SIZE = { width: 1280, height: 720 };

test('DEMO VIDEO: PvP wear-down → defeat → tie → bound (both views)', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	process.env.KD_START_RESTRAINT = 'HingedCuffs';
	fs.mkdirSync(VID_DIR, { recursive: true });
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext({ viewport: SIZE, recordVideo: { dir: VID_DIR, size: SIZE } });
	const ctxB = await browser.newContext({ viewport: SIZE, recordVideo: { dir: VID_DIR, size: SIZE } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();


	try {
		await bootCoopPair(A, B, port);
		await A.waitForTimeout(2500); // settle + show the starting field
		const session = bridge.session;

		// --- wear A down (B attacks A's avatar), slow enough to watch ---
		for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await waitForPeerAvatar(B);
			if (!peer) break;
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
			await A.waitForTimeout(450); // pacing for the video
		}
		await A.waitForTimeout(1500); // lingers on "Player A defeated"

		// --- B ties A (bootstrap quick-bind pre-selected the rope) ---
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
		// resolve the tie turn (only A waits — B's action this turn is the tie)
		const tB = await B.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
		await A.waitForTimeout(3000); // lingers on A wearing the restraint

		const aBound = await A.evaluate(() => /* @ts-ignore */ KinkyDungeonAllRestraint().map((r: any) => r.name));
		console.log('=== DEMO RESULT: Player A now wears:', JSON.stringify(aBound), '===');
	} finally {
		await ctxA.close();   // finalizes the videos
		await ctxB.close();
		const vidA = await A.video()?.path().catch(() => null);
		const vidB = await B.video()?.path().catch(() => null);
		console.log('=== VIDEO (Player A view):', vidA, '===');
		console.log('=== VIDEO (Player B view):', vidB, '===');
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
		delete process.env.KD_START_RESTRAINT;
	}
});
