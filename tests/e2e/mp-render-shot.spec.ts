/**
 * Capture a real screenshot of the VICTIM after a tie (normal path — relies on render-client's
 * re-dress, no manual model calls) so we can LOOK at whether the restraint shows on the sprite.
 */
import { test } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
import * as path from 'path';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const OUT = path.resolve(__dirname, '../_artifacts/shots');

test('SHOT: victim character after a tie', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	fs.mkdirSync(OUT, { recursive: true });
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
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

		await A.screenshot({ path: path.join(OUT, 'A-before.png') });

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
		await A.waitForTimeout(2500); // let the draw loop rebuild the sprite texture

		await A.screenshot({ path: path.join(OUT, 'A-after.png') });
		const worn = await A.evaluate(() => /* @ts-ignore */ KinkyDungeonAllRestraint().map((r: any) => r.name));
		console.log('=== SHOT worn:', JSON.stringify(worn), '-> ', path.join(OUT, 'A-after.png'), '===');
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
