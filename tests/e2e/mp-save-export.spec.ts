/**
 * E2E (KDM-244) — the co-op run comes back out as a save a STOCK game can open.
 *
 * ── WHY THIS SPEC EXISTS, GIVEN THE UNIT LAYER ────────────────────────────────────────────────────
 * `mp-save-export.spec.ts` (unit) proves the export loads — into OUR headless host, on OUR build,
 * driven by our own `loadSave`. That is our producer against our consumer, and it cannot prove the
 * claim the feature actually makes: that the string lands in the player's own browser slot and that
 * *the game* opens it. Architecture risk **R-f** named that gap; this is the test that closes it.
 *
 * "Stock" here means the page is served WITHOUT any of the co-op client scripts — they are stripped
 * at the network layer (`route`) rather than by adding a test-only flag to `demo-server.js`, because
 * a production affordance that exists only for a test is a thing to keep working forever. What
 * remains is KD itself, loading a save with `KinkyDungeonLoadGame`, exactly as a player pressing
 * "Continue" does. (The serve-time bundle patch still applies — it is a rendering workaround and has
 * nothing to do with the save format. Stated so the claim is not read as wider than it is.)
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THREE-POINT MEASUREMENT. A real single-player save with marker PRE_GOLD is written first; the
 *     stock page is shown to load THAT before the export; only then is the co-op run exported and
 *     the stock page shown to load the co-op marker instead. Without the "before" arm, "the stock
 *     page shows 4242" would pass for a save that was already there.
 *  2. THE RESIDUE IS REAL AT EXPORT TIME. The export happens while BOTH players are seated, so the
 *     world genuinely holds two `RemotePlayer_*` avatars. An export that stripped nothing would be
 *     unopenable (see the unit spec) — so "the stock game loaded it" is also the strip's proof.
 *  3. A CONTROL TEST runs the identical script and never asks for the export, asserting the slot
 *     still holds the pre-co-op save. That separates "the export wrote the run" from "the slot
 *     happened to contain a run".
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, guestAsks, lobbyState, settle } from '../helpers/mp-lobby';
import { contextMenuAt } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** The host's context-menu entry, as `coop-menu.js` names it. */
const SAVE_RUN = 'CoopSaveRun';

/**
 * KD's real context menu on this page's own tile.
 *
 * Uses the shared `contextMenuAt`, which does the TILE → PIXEL conversion: `KDGetContextActions.Game`
 * takes mouse pixels, and the wrap's `targetingSelf()` gate compares `KinkyDungeonTargetX/Y` — which
 * the builder derives from those pixels and the camera. A first draft of this spec passed tile
 * coordinates straight in, so the gate was false and the entry was reported missing while being
 * perfectly present. That is the fourth spec to need these eight lines, and precisely why the helper
 * exists; `aimed` vs `at` is asserted below so a future miscalculation fails as a precondition
 * instead of as a missing feature.
 */
async function ownMenu(P: any) {
	const me = await P.evaluate(() => {
		// @ts-ignore bare let-global
		const p = KDPlayer();
		return { x: p.x, y: p.y };
	});
	return contextMenuAt(P, me);
}

/** The pre-co-op single-player run's marker — what the slot holds BEFORE any export. */
const PRE_GOLD = 111;
/** The co-op run's marker — what the slot must hold AFTER the export. */
const COOP_GOLD = 4242;

/** Play a real single-player game and let KD's own async save loop write localStorage. */
async function playSinglePlayerAndSave(page: any, port: number): Promise<string> {
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction(() => typeof (window as any).KinkyDungeonStartNewGame === 'function',
		undefined, { timeout: 120_000, polling: 'raf' });
	await page.evaluate((gold: number) => {
		// Bare assignments through `eval`: these are bundle-scope `let`s and are NOT properties of
		// `window` (repo CLAUDE.md — "No module system at runtime").
		// eslint-disable-next-line no-eval
		(0, eval)('KDReloadMainData(true); KinkyDungeonStartNewGame(false);');
		// eslint-disable-next-line no-eval
		(0, eval)('for (var i = 0; i < 5; i++) KinkyDungeonAdvanceTime(1);');
		// eslint-disable-next-line no-eval
		(0, eval)('KinkyDungeonGold = ' + gold + '; KinkyDungeonSaveGame();');
	}, PRE_GOLD);
	await page.waitForFunction(() => {
		try { return (localStorage.getItem('KinkyDungeonSave') || '').length > 100; }
		catch (e) { return false; }
	}, undefined, { timeout: 120_000, polling: 'raf' });
	return page.evaluate(() => String(localStorage.getItem('KinkyDungeonSave') || ''));
}

/**
 * A page with NO co-op scripts — the "unmodified game" arm.
 *
 * Same browser context as the host, so it shares the origin's localStorage: this is the same slot
 * the player's real "Continue" would read.
 */
async function stockPage(ctx: any, port: number) {
	const page = await ctx.newPage();
	await page.route('**/*', async (route: any) => {
		const url = route.request().url();
		if (!url.endsWith('/') && !url.endsWith('/index.html')) return route.continue();
		const res = await route.fetch();
		const html = (await res.text()).replace(
			/<script src="[^"]*\/tools\/mp-server\/[^"]*"><\/script>\s*/g, '');
		return route.fulfill({ response: res, body: html });
	});
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction(() => typeof (window as any).KinkyDungeonStartNewGame === 'function',
		undefined, { timeout: 120_000, polling: 'raf' });
	// The precondition for the claim: if a co-op script slipped through, this is not a stock page and
	// every assertion made on it is about something else.
	const cooped = await page.evaluate(() => !!(window as any).__coop || !!(window as any).KDMPLobby);
	expect(cooped, 'the stock arm must have NO co-op client scripts').toBe(false);
	return page;
}

/** Open whatever is in the Continue slot, with KD's own loader, and report the run. */
async function stockLoad(page: any): Promise<{ ok: boolean; gold: number; remote: number }> {
	return page.evaluate(() => {
		// eslint-disable-next-line no-eval
		(0, eval)('KDReloadMainData(true);');
		// No argument = read `localStorage.KinkyDungeonSave` — literally the Continue path
		// (`KinkyDungeon.ts:7075`).
		// eslint-disable-next-line no-eval
		const ok = (0, eval)('!!KinkyDungeonLoadGame()');
		// eslint-disable-next-line no-eval
		const gold = Number((0, eval)('KinkyDungeonGold'));
		// eslint-disable-next-line no-eval
		const remote = Number((0, eval)(`KDMapData.Entities.filter(function(e){
			return e.Enemy && String(e.Enemy.name || '').indexOf('RemotePlayer') === 0; }).length`));
		return { ok, gold, remote };
	});
}

async function guestJoinsAndIsAccepted(host: any, guest: any, port: number, bridge: any) {
	await guestAsks(guest, port, 'Ada');
	// 120s rather than 60s: the two-browser join handshake is the first thing to slow down on a
	// loaded host. The assertion is unchanged; only the patience is.
	await expect.poll(async () => (await lobbyState(host)).pending?.name,
		{ timeout: 120_000, message: 'the host should be prompted' }).toBe('Ada');
	await press(host, 'KDMPAccept');
	await expect.poll(() => bridge.session.players.length,
		{ timeout: 180_000, message: 'accepted guest is seated' }).toBe(2);
}

/**
 * Plant the co-op run's marker on the HOST's character, server-side.
 *
 * The session's world is authoritative, so the marker has to be set there — setting it on the host's
 * screen would be overwritten by the next state frame. A test instrument, and the same shape the
 * import e2e uses in the other direction.
 */
function markHost(bridge: any, gold: number): string {
	const hostId = bridge.session._joined[0];
	bridge.session._restorePlayer(hostId);
	bridge.session.world.eval(`KinkyDungeonGold = ${gold}`);
	bridge.session.bundles.set(hostId, bridge.session.world.capturePlayer());
	bridge.session.world.parkGlobalPlayer(1, 1);
	return hostId;
}

test.describe('KDM-244 — leave co-op and continue the run alone', () => {
	test('the exported run opens in a STOCK game, and replaces the pre-co-op save', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			// 1. A real single-player run in the slot, so there is something to displace.
			const before = await playSinglePlayerAndSave(host, port);
			expect(before.length, 'KD must have written a real save').toBeGreaterThan(100);

			// 2. THE "BEFORE" ARM — the stock game opens THAT run. Without this, step 6 could pass
			//    against a slot that already happened to hold the co-op marker.
			const stock = await stockPage(hostCtx, port);
			const pre = await stockLoad(stock);
			expect(pre.ok, 'the pre-co-op save must itself be loadable').toBe(true);
			expect(pre.gold, 'the CONTROL: the slot holds the single-player run').toBe(PRE_GOLD);

			// 3. Host a co-op session and bring a guest in, so the world really holds two avatars.
			await openLobby(host, port, '127.0.0.1', { preload: true });
			await settle(host);
			await press(host, 'KDMPHost');
			await guestJoinsAndIsAccepted(host, guest, port, bridge);

			const hostId = markHost(bridge, COOP_GOLD);
			// The residue this feature has to remove is genuinely present at export time.
			const avatars = bridge.session.world.eval(`KDMapData.Entities.filter(function(e){
				return e.Enemy && String(e.Enemy.name || '').indexOf('RemotePlayer') === 0; }).length`);
			expect(avatars, 'both seats must have an avatar, or the strip is untested here').toBe(2);

			/*
			 * 4. The host asks for their run — THROUGH THE MENU ENTRY A PLAYER WOULD CLICK, not by
			 *    calling the transport. A feature nobody can reach is not built, and no server-side
			 *    assertion notices a missing menu option. The entry is built by
			 *    `KDGetContextActions.Game` on the player's own tile, so this drives that builder and
			 *    invokes the action it produced — the same object a click dispatches through.
			 */
			const hostMenu = await ownMenu(host);
			expect(hostMenu.aimed, 'precondition: the menu is aimed at the host\'s own tile')
				.toEqual(hostMenu.at);
			expect(hostMenu.options,
				`the host must have a reachable "save this run" entry (menu had: ${hostMenu.options})`)
				.toContain(SAVE_RUN);
			// Invoke the action the builder produced — the same object a click dispatches through.
			await host.evaluate((key: string) => (window as any).__coopMenu.optionActions[key](), SAVE_RUN);

			// …and the GUEST is not offered it (R1/R11, at the UI layer as well as on the wire).
			const guestMenu = await ownMenu(guest);
			expect(guestMenu.aimed, 'precondition: the guest\'s menu is aimed at their own tile')
				.toEqual(guestMenu.at);
			expect(guestMenu.options, 'a guest has no world to take').not.toContain(SAVE_RUN);

			// 5. The save lands in the host's own slot. Waited for, not assumed: it crosses a socket.
			await expect.poll(async () => host.evaluate(
				() => String(localStorage.getItem('KinkyDungeonSave') || '')).then((s: string) => s.length),
			{ timeout: 180_000, message: 'the exported run should reach the browser slot' })
				.toBeGreaterThan(100);
			const after = await host.evaluate(() => String(localStorage.getItem('KinkyDungeonSave') || ''));
			expect(after, 'D2 — the Continue slot now holds a DIFFERENT run').not.toBe(before);

			// 6. THE ASSERTION — a stock game, no co-op scripts, opens the co-op run.
			const post = await stockLoad(stock);
			expect(post.ok, 'R7 — the exported save must load in an unmodified game').toBe(true);
			expect(post.gold, 'R4/R6 — and it is the host\'s co-op run').toBe(COOP_GOLD);
			expect(post.remote, 'R5 — with no trace of the co-op partner').toBe(0);
			expect(hostId).toBeTruthy();

			// 7. R10/D3 — and the session the host exported from is still running.
			expect(bridge.session.started).toBe(true);
			expect(bridge.session.players.length).toBe(2);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('CONTROL — without an export, the slot still holds the pre-co-op run', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			// The identical script, differing ONLY in that nobody asks for the export. Without this,
			// the first test's green could mean "hosting co-op rewrites your save", which would be a
			// serious bug wearing the same colour as success.
			const before = await playSinglePlayerAndSave(host, port);
			await openLobby(host, port, '127.0.0.1', { preload: true });
			await settle(host);
			await press(host, 'KDMPHost');
			await guestJoinsAndIsAccepted(host, guest, port, bridge);
			markHost(bridge, COOP_GOLD);

			// Give the session real time to misbehave before concluding that it did not.
			await host.waitForTimeout(3_000);
			const after = await host.evaluate(
				() => String(localStorage.getItem('KinkyDungeonSave') || ''));
			expect(after, 'R12 — a co-op session must never write the host\'s save by itself').toBe(before);

			const stock = await stockPage(hostCtx, port);
			const run = await stockLoad(stock);
			expect(run.gold, 'the untouched slot still opens the single-player run').toBe(PRE_GOLD);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
