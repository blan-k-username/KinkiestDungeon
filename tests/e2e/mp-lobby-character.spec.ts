/**
 * E2E (KDM-256) — KD's OWN class screen is left exactly as KD's, and the declaration is read from it.
 *
 * ⚠️ TRIMMED BY KDM-293. Two tests here covered the BORROW of `startQuick` / `startGameKinky` /
 * `startGame` — the mechanic that got a player back to a lobby menu of ours after KDM-256 had sent
 * them to `'Diff'`. KDM-293 reversed the direction of travel: the player arrives at `'Diff'` by KD's
 * own road and presses a co-op entry there, so those three buttons keep starting solo games, which is
 * the right answer for someone who changed their mind. Nothing is borrowed, so there is nothing to
 * test about borrowing. `mp-entry-diff.spec.ts` covers the entry.
 *
 * What survives is the pair that matters more now than it did then: the screen is still KD's, its
 * start buttons still do KD's own thing, and what we declare is read out of KD's own globals rather
 * than out of fields of ours.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { injectLobby } from '../helpers/mp-lobby';

/** The three buttons on `'Diff'` that every one of them would start a SOLO game. */
const BORROWED = ['startQuick', 'startGameKinky', 'startGame'];

/** Run real frames — KD's own loop is live on this page, so we wait for it rather than calling in. */
async function frames(page: any, n = 2) {
	await page.evaluate((count: number) => new Promise<void>((res) => {
		let i = 0;
		const tick = () => (++i >= count ? res() : requestAnimationFrame(tick));
		requestAnimationFrame(tick);
	}), n);
}

const buttonNames = (page: any) => page.evaluate(() => Object.keys(KDButtonsCache));

/** Put the page on KD's class screen, with a co-op character pick in progress (or not). */
async function onClassScreen(page: any, coopPick: boolean) {
	await page.evaluate((pick: boolean) => {
		// @ts-ignore — bundle `let` globals are in the global lexical scope, readable by bare name.
		window.KDMPLobby.charPick = pick;
		KinkyDungeonState = 'Diff';
	}, coopPick);
	await frames(page);
}

test.describe('KDM-256 — a character is built on KD\'s own screens, from the co-op lobby', () => {

	test('R2 — the screen is KD\'s: the class grid and its stock controls are still there', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page, true);

		const names = await buttonNames(page);
		// KD builds this grid from `KDClassStart` (`KDClasses.ts:165-175`) as `Class<i>`. Its presence
		// is what makes R3 meaningful: the buttons we borrow are on a screen that is otherwise stock.
		expect(names.filter((n: string) => /^Class\d+$/.test(n)).length,
			'KD\'s own class grid must still be painted — we borrow buttons, we do not replace screens')
			.toBeGreaterThan(1);
		for (const b of BORROWED) {
			expect(names, `${b} must still exist — it is KD's button, with our handler`).toContain(b);
		}
	});


	test('R4 — WITHOUT a pick, the same buttons still do KD\'s own thing', async ({ isolatedPage: page }) => {
		// THE CONTROL, and the reason `borrowButtons` is conditional. An unconditional override would
		// pass R3 and silently break single-player for every player of this build.
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page, false);

		const stock = await page.evaluate((names: string[]) => {
			// @ts-ignore
			return names.map((n) => ({ name: n, fn: String(KDButtonsCache[n].func) }));
		}, BORROWED);
		for (const { name, fn } of stock) {
			// Compared by SOURCE rather than by clicking: the stock handlers start a real game, which
			// would tear down the page mid-test. The claim is "this is not our handler", and the
			// commit function is the only thing that could have replaced it.
			expect(fn, `${name} must still be KD's own handler, not commitCharacter`)
				.not.toContain('charPick');
		}
	});

	test('R1 — committing reads the character out of KD\'s own globals', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page, true);

		// Change the class through KD's OWN grid button, then commit through a borrowed one — so the
		// value under test travelled the route a player's would.
		const picked = await page.evaluate(() => {
			const before = KinkyDungeonClassMode;
			const grid = Object.keys(KDButtonsCache).filter((n) => /^Class\d+$/.test(n));
			for (const g of grid) {
				// @ts-ignore
				KDButtonsCache[g].func({});
				if (KinkyDungeonClassMode !== before) break;
			}
			return { before, after: KinkyDungeonClassMode };
		});
		// PRECONDITION: if no grid button changed the class, the assertion below would be comparing
		// the default to itself and would pass without the feature working at all.
		expect(picked.after, 'a class other than the default must really have been chosen')
			.not.toBe(picked.before);

		const committed = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['startGame'].func({});
			// @ts-ignore
			return window.KDMPLobby.playerCharacter();
		});
		expect(committed, 'a committed pick is a package, not null').toBeTruthy();
		expect(committed.class, 'read from KinkyDungeonClassMode, which KD\'s own grid wrote')
			.toBe(picked.after);
		// `outfit` rides the same commit, from KD's own `KinkyDungeonCurrentDress`.
		expect(typeof committed.outfit, 'the Wardrobe\'s value travels too').toBe('string');
		// And `style` does NOT: KD has no player-facing style picker on these screens, so there is
		// nothing honest to read (the server supports the field for the avatar; see the task).
		expect(committed).not.toHaveProperty('style');
	});
});
