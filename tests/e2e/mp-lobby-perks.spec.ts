/**
 * E2E (KDM-238 R1, R2) — a co-op player picks perks on KD's OWN perk screen, not on one we built.
 *
 * ── WHY THIS CAN WORK AT ALL ──────────────────────────────────────────────────────────────────────
 * `DrawButtonKDEx` both paints a button and registers it as `KDButtonsCache[name] = params`
 * (`KinkyDungeon.ts:3720`; `DrawButtonKDExTo` does the same at `:4059`); the cache is wiped at the
 * top of every frame (`:1670-1671`) and clicks are dispatched by iterating it (`:4321`).
 * Registration is keyed by NAME, so **last write wins** — and the lobby wrapper already runs after
 * the stock frame (it must, or its own buttons would be wiped). That lets it take back the two
 * buttons whose stock behaviour is wrong for co-op:
 *
 *   KDPerksStart  stock: KinkyDungeonStartNewGame() — would start a SOLO game
 *   KDPerksBack   stock: KinkyDungeonState = "Diff"
 *
 * Everything else on that screen — the perk grid, the point budget, Clear All, the three configs,
 * the filter, copy/paste — is stock and untouched, which is R2 satisfied by not writing code.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. `KDPerksBack` is exercised in BOTH modes on the same page: with a co-op pick in progress it
 *     must reach the lobby, and without one it must still reach KD's own "Diff" screen. One
 *     assertion says the override works; the other says it did not eat the stock button. An
 *     unconditional override passes the first and fails the second.
 *  2. The perk grid is asserted PRESENT while the override is active, so "we took the screen over"
 *     cannot be how the first assertion passes.
 *  3. What is committed is read back from KD's own `KinkyDungeonStatsChoice`, and the perk is
 *     toggled through KD's own grid button — not injected into our own field.
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

test.describe('KDM-238 — perks are chosen on KD\'s own screen, from the co-op lobby', () => {
	test('R1 — the lobby offers a Perks entry that opens KD\'s perk screen', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await page.evaluate(() => {
			KinkyDungeonState = 'Multiplayer';
			// @ts-ignore
			window.KDMPLobby.view = 'menu';
		});
		await frames(page);

		expect(await buttonNames(page), 'the lobby root offers it').toContain('KDMPPerks');

		const after = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['KDMPPerks'].func({});
			// @ts-ignore
			return { screen: KinkyDungeonState, picking: !!window.KDMPLobby.perkPick };
		});
		expect(after.screen, 'KD\'s own screen, by its own state name').toBe('Stats');
		expect(after.picking).toBe(true);
	});

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

	test('the two overridden buttons behave one way for co-op and the stock way otherwise', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);

		// WITH a co-op pick in progress: Back returns to the lobby.
		await onPerkScreen(page, true);
		const coop = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['KDPerksBack'].func({});
			return KinkyDungeonState;
		});
		expect(coop).toBe('Multiplayer');

		// WITHOUT one: the SAME button must still do KD's own thing. This is the control that makes
		// the assertion above a conditional override rather than a hijack.
		await onPerkScreen(page, false);
		const stock = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['KDPerksBack'].func({});
			return KinkyDungeonState;
		});
		expect(stock, 'a solo player\'s perk screen is untouched').toBe('Diff');
	});

	test('R1 — committing returns to the lobby with the chosen perks, and starts NO solo game', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onPerkScreen(page, true);

		// Toggle a perk through KD's OWN grid button, so what is committed is what a player's click
		// would produce. Chosen by asking the cache which grid buttons exist rather than by naming
		// one: the grid is filtered and paginated, so a hardcoded perk may not be on screen.
		const toggled = await page.evaluate(() => {
			// @ts-ignore
			const grid = Object.keys(KDButtonsCache).filter((n) => KinkyDungeonStatsPresets[n]);
			// @ts-ignore
			const pick = grid.find((n) => !KinkyDungeonStatsChoice.get(n));
			// @ts-ignore
			if (pick) KDButtonsCache[pick].func({});
			// @ts-ignore
			return Array.from(KinkyDungeonStatsChoice.keys()).filter((k) => KinkyDungeonStatsChoice.get(k));
		});
		expect(toggled.length, 'the toggle has to land, or the commit assertion proves nothing')
			.toBeGreaterThan(0);

		const after = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['KDPerksStart'].func({});
			return {
				// @ts-ignore
				screen: KinkyDungeonState, perks: (window.KDMPLobby.perks || []).slice(),
				// @ts-ignore
				picking: !!window.KDMPLobby.perkPick,
				// KDM-279 — and what this lobby would actually DECLARE, which is the only thing the
				// server ever sees. Sampled in the same evaluate as the commit above.
				// @ts-ignore
				declared: window.KDMPLobby.playerCharacter(),
			};
		});

		expect(after.screen, 'stock would have called KinkyDungeonStartNewGame and left Stats for the game')
			.toBe('Multiplayer');
		expect(after.picking, 'the pick is finished, so the override stands down').toBe(false);
		// Read back from KD, not asserted as a literal: whatever the game says is chosen is what the
		// lobby must be carrying.
		expect(after.perks.slice().sort()).toEqual(toggled.slice().sort());

		/*
		 * KDM-279 — AND IT REACHES THE DECLARATION. The lobby holding the right perks internally is
		 * only half the job: they used to leave on a `join.perks` field of their own and now travel
		 * inside the character package, so this asserts the thing that is actually sent.
		 *
		 * ⚠️ Note what would still pass without the fold: `after.perks` above. That field never
		 * changed and never will — which is precisely why an assertion on it cannot see whether the
		 * merge in `playerCharacter()` happened. This one can.
		 *
		 * The class/outfit half of the package is deliberately untouched here (this player never
		 * opened the character screen), so a package existing AT ALL is itself the evidence that
		 * perks alone are enough to make one.
		 */
		expect(after.declared, 'perks alone must make a package — a player may keep KD\'s default class')
			.toBeTruthy();
		expect((after.declared.perks || []).slice().sort(),
			'the declaration carries what KD says was chosen').toEqual(toggled.slice().sort());
	});
});
