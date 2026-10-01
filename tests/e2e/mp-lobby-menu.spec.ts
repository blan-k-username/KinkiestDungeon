/**
 * E2E — the Multiplayer entry lives in KD's OWN main menu, installed from the injection
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
import { injectLobby } from '../helpers/mp-lobby';

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

test.describe('the co-op entries, installed from outside the game tree', () => {
	test('the entries are absent until injected, then live (E1 entry point)', async ({ isolatedPage: page }) => {
		await bootKD(page);

		// The entries moved from KD's main menu to its class/start screen, and the claim
		// this test makes moved with them: they are installed from OUTSIDE the game tree, so a stock
		// page must not have them. `mp-entry-diff` asserts they are present and behave; only this one
		// asserts they are ABSENT beforehand, which is what proves the wrapper put them there.
		await page.evaluate(() => { KinkyDungeonState = 'Diff'; });
		await frames(page);
		const before = await buttonNames(page);
		expect(before, 'BEFORE: the stock class screen has no co-op entry').not.toContain('KDMPHost');
		expect(before, 'and none of ours at all').not.toContain('KDMPJoin');

		await injectLobby(page);
		await frames(page);

		const after = await buttonNames(page);
		expect(after, 'AFTER: the wrapper registered Host').toContain('KDMPHost');
		expect(after, 'AFTER: and Join').toContain('KDMPJoin');

		// Clicking is invoking the registered handler — the same thing KD's own click dispatch does.
		const state = await page.evaluate(() => {
			// @ts-ignore
			KDButtonsCache['KDMPJoin'].func({});
			// @ts-ignore
			return { screen: KinkyDungeonState, phase: window.KDMPLobby && window.KDMPLobby.phase };
		});
		expect(state.screen).toBe('Multiplayer');
		// A player who has never been told how co-op differs lands on the BRIEFING. This
		// page injects the lobby script alone, with no `coop-bootstrap.js` to remember anything, so it
		// is a first-ever entry every time — the degraded reading the lobby is specified to take
		// (`briefingSeen()` answers false when it cannot know).
		expect(state.phase, 'the entry opens ON the briefing, not past it').toBe('about');
	});

	test('the handshake screen paints its own buttons, and the stock frame paints nothing underneath', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await page.evaluate(() => { KinkyDungeonState = 'Multiplayer'; window.KDMPLobby.phase = 'connect'; });
		await frames(page);

		const names = await buttonNames(page);
		expect(names.sort(), 'exactly our own buttons — a stock fallthrough would add more')
			// The root menu is gone; what is left is the connect form. `KDMPAbout` is the
			// way back into the briefing, which used to hang off the root and now hangs off this.
			.toEqual(['KDMPAbout', 'KDMPBack', 'KDMPConnect']);
	});


	test('the join view offers a real address field, prefilled and editable', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
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
		await injectLobby(page);
		await injectLobby(page);
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
