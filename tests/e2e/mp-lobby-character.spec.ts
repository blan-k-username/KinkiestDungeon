/**
 * E2E (KDM-256 R1) — a co-op player builds a character on KD's OWN screens, not on ones we built.
 *
 * ── THE SAME MECHANIC AS THE PERK PICK, AIMED AT A HARDER SCREEN ──────────────────────────────────
 * `DrawButtonKDEx` paints a button AND registers it as `KDButtonsCache[name]` (`KinkyDungeon.ts:3720`);
 * the cache is wiped per frame (`:1670`) and clicks are dispatched by iterating it (`:4321`).
 * Registration is keyed by NAME, so last write wins, and the lobby wrapper already runs after the
 * stock frame. `mp-lobby-perks.spec.ts` establishes all of that for `'Stats'`; this file is about
 * `'Diff'`, KD's class/start screen (`KinkyDungeon.ts:2546`), which differs in one dangerous way:
 *
 *   **THREE buttons start a solo game, not one.** `startQuick`, `startGameKinky` and `startGame`.
 *   Miss any of them and a co-op player who presses it is dropped into single-player with their
 *   lobby still open — which is why `borrowButtons` is all-or-nothing and why R3 below names each.
 *
 * The Wardrobe (the outfit and appearance surface) is reached by KD's own button from `'Diff'` and
 * returns there by its own back button, so it needs no override at all and gets none.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. Every borrowed button is exercised in BOTH modes on the same page (R3 / R4). With a co-op pick
 *     in progress it must reach the lobby; WITHOUT one it must still do KD's own thing. One
 *     assertion says the override works, the other says it did not eat the stock button — an
 *     unconditional override passes the first and fails the second. This is the pair that matters:
 *     the stock behaviour here is "start the game", so eating it breaks single-player.
 *  2. The class grid is asserted PRESENT while the override is active, so "we took the screen over
 *     and painted our own" cannot be how R3 passes.
 *  3. What is committed is read back from KD's own `KinkyDungeonClassMode` / `KinkyDungeonCurrentDress`
 *     after being changed through KD's own class button — never injected into a field of ours.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';

const LOBBY_SCRIPT = 'tools/mp-server/client/coop-lobby.js';

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
	test('R1 — the lobby offers a Character entry that opens KD\'s class screen', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });
		await page.evaluate(() => {
			KinkyDungeonState = 'Multiplayer';
			// @ts-ignore
			window.KDMPLobby.view = 'menu';
		});
		await frames(page);

		expect(await buttonNames(page), 'the lobby root offers it').toContain('KDMPChar');

		const after = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['KDMPChar'].func({});
			// @ts-ignore
			return { screen: KinkyDungeonState, picking: !!window.KDMPLobby.charPick };
		});
		expect(after.screen, 'KD\'s own screen, by its own state name').toBe('Diff');
		expect(after.picking).toBe(true);
	});

	test('R2 — the screen is KD\'s: the class grid and its stock controls are still there', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });
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

	test('R3 — with a pick in progress, EVERY start button commits to the lobby', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });

		for (const button of BORROWED) {
			await onClassScreen(page, true);
			const after = await page.evaluate((name: string) => {
				// @ts-ignore
				KDButtonsCache[name].func({});
				return {
					screen: KinkyDungeonState,
					// @ts-ignore
					picking: !!window.KDMPLobby.charPick,
					// @ts-ignore
					view: window.KDMPLobby.view,
					running: !!KinkyDungeonGameRunning,
				};
			}, button);
			// The failure this pins: a solo game started under an open lobby. `running` is the loud
			// half — the screen alone would not say whether a run had begun behind it.
			expect(after.screen, `${button} must return to the lobby, not start a game`).toBe('Multiplayer');
			expect(after.view, `${button} must land on the lobby ROOT`).toBe('menu');
			expect(after.picking, `${button} must end the pick`).toBe(false);
			expect(after.running, `${button} must NOT have started a solo run`).toBe(false);
		}
	});

	test('R4 — WITHOUT a pick, the same buttons still do KD\'s own thing', async ({ isolatedPage: page }) => {
		// THE CONTROL, and the reason `borrowButtons` is conditional. An unconditional override would
		// pass R3 and silently break single-player for every player of this build.
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });
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
		await page.addScriptTag({ path: LOBBY_SCRIPT });
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
