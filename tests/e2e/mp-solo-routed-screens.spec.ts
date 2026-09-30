/**
 * E2E (KDM-307) — a SOLO game on the co-op server keeps KD's own perk orb and journey map.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────────────────────────────
 * Owner's UAT: playing alone on the co-op server, finished a floor, "the Accept button does nothing".
 * `kd-perk-choice.js` (KDM-242) and `kd-journey-choice.js` (KDM-263) wrap two KD draw functions and
 * swap what their clicks MEAN — a private cursor, an Accept that routes `KDCoopPerk`, a journey pick
 * that is reverted and routed. Right for a co-op client. But the co-op server injects them into EVERY
 * page it serves, and on a solo page there is nobody to route to: the perk was never granted and the
 * journey target never set. KDM-294 made "start solo on the co-op server, host later" a first-class
 * road, which is what turned a latent bug into a blocker.
 *
 * ── WHY THESE ASSERTIONS ──────────────────────────────────────────────────────────────────────────
 *  1. #1 uses REAL clicks through `KinkyDungeonHandleClick` — the player's road, and the one that
 *     found the bug: a direct call of the button's handler would have tested our substitute instead.
 *  2. #3 is the CONTROL, and without it #1/#2 would pass on a build that simply deleted both wraps:
 *     the same page, made a co-op client, must still route and must NOT commit locally.
 *
 * ⚠️ FAILS UNTIL KDM-307 IS IMPLEMENTED. Written first, per the project's Rule 1.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { openGameMenu, settle, clickAt } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** A solo run on the co-op server, on the dungeon view (not the in-game menu). */
async function withSoloDungeon(page: any, body: () => Promise<void>) {
	const { server, bridge, port } = await start(0);
	try {
		await openGameMenu(page, port);
		await page.evaluate(() => { KinkyDungeonDrawState = 'Game'; });
		await settle(page);
		await body();
	} finally {
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
}

/** Plant a perk orb beside the player and target it — the state walking into one leaves. */
const plantPerkOrb = (page: any) => page.evaluate(() => {
	// eslint-disable-next-line no-eval
	(0, eval)(`
		var px = KinkyDungeonPlayerEntity.x + 1, py = KinkyDungeonPlayerEntity.y;
		var perk = Object.keys(KinkyDungeonStatsPresets).filter(function (k) { return KinkyDungeonStatsPresets[k].cost > 0; })[0];
		window.__kdmpPerk = perk; window.__kdmpOrb = px + ',' + py;
		KinkyDungeonMapSet(px, py, 'P');
		KinkyDungeonTilesSet(px + ',' + py, { Perks: [perk], Bondage: [], Method: '', Type: 'PerkOrb' });
		KDMapData.PerkShrines = [px + ',' + py, px + ',' + py, px + ',' + py];
		KDMapData.SelectedPerk = -1;
		KinkyDungeonTargetTile = KinkyDungeonTilesGet(px + ',' + py);
		KinkyDungeonTargetTileLocation = px + ',' + py;
	`);
});

const centreOf = async (page: any, name: string) => {
	await page.waitForFunction((n: string) => !!(KDButtonsCache as any)[n], name, { timeout: 30_000, polling: 'raf' });
	return page.evaluate((n: string) => {
		// @ts-ignore
		const b = KDButtonsCache[n];
		return { x: b.Left + b.Width / 2, y: b.Top + b.Height / 2 };
	}, name);
};

const orbState = (page: any) => page.evaluate(() => ({
	// @ts-ignore
	selected: KDMapData.SelectedPerk,
	// @ts-ignore
	granted: !!KinkyDungeonStatsChoice.get((window as any).__kdmpPerk),
	// @ts-ignore
	orb: (KinkyDungeonTilesGet((window as any).__kdmpOrb) || {}).Type || null,
	routed: (globalThis as any).__KDCoopPerkStats ? (globalThis as any).__KDCoopPerkStats.routed : 0,
}));

/** The journey map's keyboard pick — the same branch `mp-journey-agreement` drives. */
const pickFirstRoute = (page: any) => page.evaluate(() => {
	const s = (globalThis as any).__KDCoopJourneyStats;
	const before = s ? s.routed : 0;
	// @ts-ignore
	KDGameData.JourneyTarget = null;
	// @ts-ignore
	KinkyDungeonKeybindingCurrentKey = KinkyDungeonKeyWait[0];
	// @ts-ignore
	KDRenderJourneyMap(0, 99, 5, 7);
	// @ts-ignore
	KinkyDungeonKeybindingCurrentKey = '';
	// @ts-ignore
	const t = KDGameData.JourneyTarget;
	return { target: t ? { x: t.x, y: t.y } : null, routed: (s ? s.routed : 0) - before };
});

test.describe('KDM-307 — solo on the co-op server keeps KD\'s own choices', () => {
	test.describe.configure({ timeout: 180_000 });

	test('#1 a solo player picks a perk card and Accept grants it', async ({ isolatedPage: page }) => {
		await withSoloDungeon(page, async () => {
			await plantPerkOrb(page);
			const card = await centreOf(page, 'perkshrinechoicebg0');
			await clickAt(page, card.x, card.y);
			expect((await orbState(page)).selected, 'the card click must select the card').toBe(0);

			const accept = await centreOf(page, 'AcceptContractButton0');
			await clickAt(page, accept.x, accept.y);
			const after = await orbState(page);
			expect(after.granted, 'Accept must grant the perk').toBe(true);
			expect(after.orb, 'and clear the orb, as KD does').toBeNull();
			expect(after.routed, 'nothing is routed when there is nobody to route to').toBe(0);
		});
	});

	test('#2 a solo player picks the next journey slot', async ({ isolatedPage: page }) => {
		await withSoloDungeon(page, async () => {
			const r = await pickFirstRoute(page);
			expect(r.target, 'the pick must set KD\'s own JourneyTarget').not.toBeNull();
			expect(r.routed, 'and route nothing').toBe(0);
		});
	});

	test('#3 CONTROL — the same page as a co-op client still routes both, and commits neither', async ({ isolatedPage: page }) => {
		await withSoloDungeon(page, async () => {
			// What entering a session does to a page (coop-bootstrap `enterGame`).
			await page.evaluate(() => { (window as any).KDRenderClient.disableLocalSim(); });

			await plantPerkOrb(page);
			const card = await centreOf(page, 'perkshrinechoicebg0');
			await clickAt(page, card.x, card.y);
			expect((await orbState(page)).selected, 'a co-op cursor is private, never KD\'s shared field').toBe(-1);
			await page.waitForFunction(() => (globalThis as any).__KDCoopPerkCursor === 0, undefined, { timeout: 10_000 });

			const accept = await centreOf(page, 'AcceptContractButton0');
			await clickAt(page, accept.x, accept.y);
			const after = await orbState(page);
			expect(after.routed, 'Accept is routed to the party').toBe(1);
			expect(after.granted, 'and no browser grants a perk alone').toBe(false);

			const r = await pickFirstRoute(page);
			expect(r.routed, 'the journey pick is routed').toBe(1);
			expect(r.target, 'and not committed locally').toBeNull();
		});
	});
});
