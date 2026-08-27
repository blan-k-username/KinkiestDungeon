/**
 * E2E (KDM-233) — the Multiplayer entry lives in KD's OWN main menu, installed from the injection
 * layer, with no edit to the game tree.
 *
 * ── WHY THIS CAN WORK AT ALL ──────────────────────────────────────────────────────────────────────
 * KD's buttons are data-driven off a per-frame cache: `KDButtonsCache` is wiped at the top of every
 * frame (`KinkyDungeon.ts:1670-1671`, inside `KinkyDungeonRun`), `DrawButtonKDEx` both paints a
 * button and registers `{bounds, func}` under `KDButtonsCache[name]` (`:3720`), and clicks are
 * dispatched by iterating that cache (`:4297`, `:4324`). So a button drawn from a WRAPPER that runs
 * after the stock frame is fully live — hover, priority and click included.
 *
 * The prior art (`origin/feature/multiplayer`) got its menu entry by editing `KinkyDungeon.ts:1980`
 * directly. That is exactly what the plugin rule forbids, so this proves the wrapper does the same
 * job from outside.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. The BEFORE half is measured on this very page, before the script is injected: the button must
 *     be ABSENT first, so "present" cannot be something the stock bundle was doing anyway.
 *  2. The lobby state is asserted by VALUE after invoking the registered `func` — not by asking the
 *     lobby whether it thinks it is open.
 *  3. The `Multiplayer` state asserts the button set is EXACTLY the lobby's own, which is what would
 *     catch the stock frame falling through and painting the game underneath the panel.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';

const LOBBY_SCRIPT = 'tools/mp-server/client/coop-lobby.js';

/** Run real frames — KD's own loop is live on this page, so we wait for it rather than calling in. */
async function frames(page: any, n = 2) {
	await page.evaluate((count: number) => new Promise<void>((res) => {
		let i = 0;
		const tick = () => (++i >= count ? res() : requestAnimationFrame(tick));
		requestAnimationFrame(tick);
	}), n);
}

const buttonNames = (page: any) => page.evaluate(() => {
	// @ts-ignore — bundle `let` globals are in the global lexical scope, readable by bare name.
	return Object.keys(KDButtonsCache);
});

test.describe('KDM-233 — Multiplayer entry in the main menu', () => {
	test('the entry is absent until injected, then live — and opens the lobby (E1 entry point)', async ({ isolatedPage: page }) => {
		await bootKD(page);

		await page.evaluate(() => { KinkyDungeonState = 'Menu'; });
		await frames(page);
		expect(await buttonNames(page), 'BEFORE: the stock menu has no Multiplayer entry')
			.not.toContain('MultiplayerButton');

		await page.addScriptTag({ path: LOBBY_SCRIPT });
		await frames(page);

		expect(await buttonNames(page), 'AFTER: the wrapper registered it')
			.toContain('MultiplayerButton');

		// Clicking it is invoking the registered handler — the same thing KD's own click dispatch does.
		const state = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['MultiplayerButton'].func({});
			// @ts-ignore
			return { screen: KinkyDungeonState, view: window.KDMPLobby && window.KDMPLobby.view };
		});
		expect(state.screen).toBe('Multiplayer');
		// KDM-272 — a player who has never been told how co-op differs lands on the BRIEFING, and the
		// root is one Back away. This page injects the lobby script alone, with no `coop-bootstrap.js`
		// to remember anything, so it is a first-ever open every time — which is the degraded reading
		// the lobby is specified to take (`briefingSeen()` answers false when it cannot know).
		expect(state.view, 'the entry opens the lobby ON the briefing, not past it').toBe('about');
	});

	test('the lobby paints its own screen, and the stock frame paints nothing underneath', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });
		await page.evaluate(() => { KinkyDungeonState = 'Multiplayer'; window.KDMPLobby.view = 'menu'; });
		await frames(page);

		const names = await buttonNames(page);
		expect(names.sort(), 'exactly the lobby\'s own buttons — a stock fallthrough would add more')
			// KDM-238 added KDMPPerks to the root view — KD's own perk screen, reached from the lobby.
			// KDM-256 added KDMPChar beside it — KD's own class screen, and the Wardrobe beyond it.
			// KDM-272 added KDMPAbout — the way back into the briefing after the first showing.
			.toEqual(['KDMPAbout', 'KDMPBack', 'KDMPChar', 'KDMPHost', 'KDMPJoin', 'KDMPPerks']);
	});

	test('Back returns to the menu; Host and Join each open their own view', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });

		const seen = await page.evaluate(async () => {
			const step = async (btn: string) => {
				// @ts-ignore
				KDButtonsCache[btn].func({});
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				// @ts-ignore
				return window.KDMPLobby.view;
			};
			KinkyDungeonState = 'Multiplayer';
			// @ts-ignore
			window.KDMPLobby.view = 'menu';
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

			const host = await step('KDMPHost');
			// @ts-ignore
			window.KDMPLobby.view = 'menu';
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const join = await step('KDMPJoin');
			// @ts-ignore
			window.KDMPLobby.view = 'menu';
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const back = await step('KDMPBack');
			// @ts-ignore
			return { host, join, back, screen: KinkyDungeonState };
		});

		expect(seen.host).toBe('host');
		expect(seen.join).toBe('join');
		expect(seen.back).toBe('menu');
		expect(seen.screen, 'Back from the lobby root leaves the Multiplayer screen').toBe('Menu');
	});

	test('the join view offers a real address field, prefilled and editable', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });
		await page.evaluate(() => { KinkyDungeonState = 'Multiplayer'; window.KDMPLobby.view = 'join'; });
		await frames(page);

		const field = page.locator('#KDMPAddress');
		await expect(field, 'a DOM input over the canvas, as the prior art did').toHaveCount(1);
		expect(await field.inputValue(), 'prefilled with somewhere plausible to try').not.toBe('');

		await field.fill('192.168.1.42:8090');
		expect(await page.evaluate(() => window.KDMPLobby.address())).toBe('192.168.1.42:8090');
	});

	test('injecting twice does not double-wrap (WRAP_CONVENTION sentinel)', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await page.addScriptTag({ path: LOBBY_SCRIPT });
		await page.addScriptTag({ path: LOBBY_SCRIPT });
		await page.evaluate(() => { KinkyDungeonState = 'Multiplayer'; window.KDMPLobby.view = 'menu'; });
		await frames(page);

		const drawsPerFrame = await page.evaluate(async () => {
			// @ts-ignore
			window.KDMPLobby._drawCount = 0;
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
			// @ts-ignore
			return window.KDMPLobby._drawCount;
		});
		// 2 settled frames of counting; a double wrap would paint the panel twice per frame.
		expect(drawsPerFrame).toBeLessThanOrEqual(3);
		expect(drawsPerFrame).toBeGreaterThan(0);
	});
});
