/**
 * E2E — co-op click-to-move PASSES a peaceful NPC on its route, the way single player does; it does
 * not open their dialogue.
 *
 * Owner's UAT (2026-10-01, KDM-315): "the finding goes through the NPC and interact with him/her" —
 * on the shop floor, a clicked route crossed the row of quest merchants and stopped in a merchant's
 * dialogue. The ROUTE is stock KD (`KDAutoPathEnemyWeight` only weights a non-immobile NPC, so the
 * straight line wins — reproduced with no co-op code by `tests/unit/mp-fastmove-shop-merchants.spec.ts`).
 * The OUTCOME was not: in single player (owner check, 2026-10-04) the same walk just swaps past them.
 *
 * Why: KD's `move` input sets `KinkyDungeonToggleAutoPass = data.AutoPass`
 * (`Game/src/base/KinkyDungeonInput.ts`) and `KDCanPassEnemy` reads it — a bump is a swap only while
 * it is on. KD's own fast-move step sends the player's toggle (`Game/src/base/KinkyDungeon.ts`, the
 * `KDSendInput("move", …)` inside the fast-move block); co-op's route step (`coop-bootstrap.js`
 * `stepRoute`) sent no `AutoPass`, so the server set it to `undefined` and every bump became an
 * interaction.
 *
 * #1 is the bug. #2 is the control that the PLAYER's toggle still decides, so #1 cannot pass by
 * hard-coding `AutoPass: true` (or by the server ignoring the field and defaulting it).
 */
import { test, expect, Page } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, coopWaitTurn } from './helpers/coop';
import { freeNeighbour } from '../helpers/session-tiles';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Stand KD's own peaceful quest merchant (`BlacksmithQuest`, as `KinkyDungeonCreateShopStart` does —
 * `KinkyDungeonAlt.ts`) on a free tile beside A. Server-side SETUP: the world is the server's.
 */
function standMerchantBesideA(bridge: any) {
	const n = freeNeighbour(bridge.session, 'A');
	expect(n, 'setup: a free tile beside A').not.toBeNull();
	const id = bridge.session.world.eval(`(function(){
		var e = DialogueCreateEnemy(${n!.x}, ${n!.y}, "BlacksmithQuest");
		e.AI = "guard";
		return e.id;
	})()`);
	expect(id, 'setup: the merchant exists').toBeTruthy();
	return { ...n!, id };
}

/** A walks a one-tile ROUTE onto (x,y) through the real route driver — what a click becomes. */
const routeStep = (A: Page, x: number, y: number) => A.evaluate((t) => {
	const coop = (window as any).__coop;
	coop.route = [{ x: t.x, y: t.y }];
	coop.routeFresh = true;
	coop._stepRoute(true);
}, { x, y });

test.describe('co-op click-to-move passes a peaceful NPC', () => {
	test.setTimeout(MP_TEST_TIMEOUT);

	for (const autoPass of [true, false]) {
		test(autoPass
			? '#1 pass toggle ON (KD default): the route swaps past the merchant, no dialogue'
			: '#2 control, pass toggle OFF: the same step is an interaction, as in single player', async ({ browser }) => {
			const { server, bridge, port } = await start(0);
			const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
			const A = await ctxA.newPage(); const B = await ctxB.newPage();
			try {
				await bootCoopPair(A, B, port);
				const m = standMerchantBesideA(bridge);
				// A turn so A's client has the merchant in its world before it plans a route.
				await coopWaitTurn(A, B);
				await expect.poll(() => A.evaluate((t) => {
					// @ts-ignore bare let-global
					const e = KinkyDungeonEnemyAt(t.x, t.y);
					return e ? e.Enemy.name : null;
				}, m), { timeout: 15_000, message: "A's client sees the merchant" }).toBe('BlacksmithQuest');

				const from = bridge.session.posOf('A');
				// The player's OWN toggle, set the way KD's HUD button sets it.
				// @ts-ignore bare let-global
				await A.evaluate((v) => { KinkyDungeonToggleAutoPass = v; }, autoPass);
				await coopWaitTurn(A, B, () => routeStep(A, m.x, m.y));

				const to = bridge.session.posOf('A');
				// @ts-ignore bare let-global
				const dialog = await A.evaluate(() => KDGameData.CurrentDialog || '');
				if (autoPass) {
					expect(to, 'A stepped onto the merchant tile (swapped past them)').toEqual({ x: m.x, y: m.y });
					expect(dialog, 'no merchant dialogue opened').toBe('');
				} else {
					expect(to, 'A did not pass the merchant').toEqual(from);
					expect(dialog, 'the bump opened the merchant dialogue, as in single player').not.toBe('');
				}
			} finally {
				await ctxA.close().catch(() => {});
				await ctxB.close().catch(() => {});
				try { bridge.close(); } catch (e) { /* ignore */ }
				await new Promise((r) => server.close(r));
			}
		});
	}
});
