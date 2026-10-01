/**
 * E2E — an accepted guest whose game is still loading is TOLD so, not shown a blank screen.
 *
 * The owner's UAT: the host accepted, the guest was already seated server-side, and the guest's page
 * sat on the Join screen with its status line CLEARED — `joined.started` wiped "Waiting for the host…"
 * and `enterGame()` then re-queued itself silently every 200 ms while assets (or the host's mods)
 * loaded. It looked exactly like nothing had happened, so the player pressed Join again.
 *
 * ⚠️ PAINT, NOT JUST STATE. `lobbyState().status` says what the lobby WOULD draw; `paintedText` records
 * what actually reached the canvas in a settled frame. Both are asserted, and the "Waiting for the host"
 * line is pinned BEFORE the accept so the new line is a change of value, not something always there.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState, guestAsks, paintedText } from '../helpers/mp-lobby';
import { MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('a seated guest still loading the game is told so on screen', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	try {
		await openLobby(host, port);
		await press(host, 'KDMPHost');
		// No preload: `enterGame()` will wait on assets, which is the owner's blank screen.
		await guestAsks(guest, port, 'Bee');
		await expect.poll(async () => (await lobbyState(guest)).status, { timeout: 30_000 })
			.toMatch(/Waiting for the host/);

		await expect.poll(async () => (await lobbyState(host)).pending?.name, { timeout: 30_000 }).toBe('Bee');
		await press(host, 'KDMPAccept');
		await expect.poll(() => bridge.session.players.length, { timeout: 120_000 }).toBe(2);
		await guest.waitForFunction(() => !!(window as any).__coop && (window as any).__coop.started,
			undefined, { timeout: 60_000 });

		const entering = await guest.evaluate(() => ({
			entered: !!(window as any).__coop._entered,
			// @ts-ignore bare let-global
			state: KinkyDungeonState,
		}));
		expect(entering, 'control: seated, but the page has NOT entered the game yet').toEqual(
			{ entered: false, state: 'Multiplayer' });

		const status = (await lobbyState(guest)).status;
		expect(status, 'the status line is not blank').toBeTruthy();
		expect(status, 'and it is no longer the pre-accept line').not.toMatch(/Waiting for the host/);
		expect(status, 'it says the game is loading').toMatch(/loading/i);
		expect(await paintedText(guest), 'and it actually reaches the screen').toContain(status);
	} finally {
		await hostCtx.close().catch(() => {});
		await guestCtx.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
