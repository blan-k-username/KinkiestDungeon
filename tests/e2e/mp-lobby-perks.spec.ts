/**
 * E2E — KD's OWN perk screen is left exactly as KD's.
 *
 * ⚠️ MOST OF THIS FILE WAS DELETED WITH THE LOBBY MENU, and what it asserted did not go with it.
 *
 * An earlier design sent the player from a lobby menu of ours TO `'Stats'`, which meant BORROWING
 * `KDPerksStart` / `KDPerksBack` to get them back again — and three tests here covered that borrow.
 * The lobby menu is gone: the player now reaches the perk grid by KD's own road and leaves it
 * by KD's own buttons, so there is nothing to borrow and nothing to come back from. The entry-point
 * behaviour those tests guarded is now `mp-entry-diff.spec.ts`.
 *
 * What survives is the assertion that mattered most and is now the ONLY one making it: that we have
 * not disturbed KD's screen. It was a control while the override existed; with the override gone it
 * is the whole point — a mod that quietly breaks the stock perk screen is the failure this file is
 * still here to catch.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { injectLobby } from '../helpers/mp-lobby';

/** Run real frames — KD's own loop is live on this page, so we wait for it rather than calling in. */
async function frames(page: any, n = 2) {
	await page.evaluate((count: number) => new Promise<void>((res) => {
		let i = 0;
		const tick = () => (++i >= count ? res() : requestAnimationFrame(tick));
		requestAnimationFrame(tick);
	}), n);
}

const buttonNames = (page: any) => page.evaluate(() => Object.keys(KDButtonsCache));

/** Put the page on KD's perk screen with a co-op pick in progress (or not). */
async function onPerkScreen(page: any, coopPick: boolean) {
	await page.evaluate((pick: boolean) => {
		// @ts-ignore — bundle `let` globals are in the global lexical scope, readable by bare name.
		window.KDMPLobby.perkPick = pick;
		KinkyDungeonState = 'Stats';
	}, coopPick);
	await frames(page);
}

test.describe('perks are chosen on KD\'s own screen, from the co-op lobby', () => {

	test('R2 — the screen is KD\'s: the perk grid and its stock controls are all still there', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onPerkScreen(page, true);

		const names = await buttonNames(page);
		// KD's own controls on that screen (`KinkyDungeon.ts:2896-2914`). If the co-op layer had
		// re-implemented the screen, these would be absent — which is what makes the override
		// assertions below mean "we took two buttons", not "we took the screen".
		expect(names).toContain('KDPerksClear');
		expect(names).toContain('KDPerkConfig1');

		// The grid registers each perk under its OWN key (`DrawButtonKDExTo(kdUItext, stat[0], …)`,
		// `KinkyDungeonPerks.ts:1096`), so a cache key that is a real perk name IS the stock grid.
		const gridSize = await page.evaluate(() =>
			// @ts-ignore
			Object.keys(KDButtonsCache).filter((n) => KinkyDungeonStatsPresets[n]).length);
		expect(gridSize, 'the perk grid itself is stock').toBeGreaterThan(0);
	});


});
