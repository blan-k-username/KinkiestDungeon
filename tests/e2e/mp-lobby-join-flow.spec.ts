/**
 * E2E (KDM-233) — the whole join, driven the way a player drives it.
 *
 * Two browser contexts against a real demo server: the host clicks Host Game, the guest types the
 * host's address and clicks Join, and **nothing happens to the session until the host clicks
 * Accept**. That last clause is the feature — approval-only is the entire gate (R2; there is no code
 * and no password, per the LAN-only posture in KDM-226), so a guest who gets in without the host
 * answering is the failure that matters most.
 *
 * `mp-join-approval.spec.ts` proves the protocol at the socket, in milliseconds. This proves the two
 * halves are wired to each other at all: lobby → `__coopConnect` → bridge → `join_pending` → the
 * host's prompt → `join_answer` → session.
 *
 * WHY IT IS NOT A VACUOUS GREEN: accept and decline are the same script up to the button pressed,
 * and they diverge — one ends with the guest connected, the other with the host still alone and the
 * guest told, in words, why.
 *
 * WHY IT USES THE DEMO SERVER: the client scripts are injected at serve time (`demo-server.js`
 * `INJECT`), so on the plain static server there is no Multiplayer entry to click. The first version
 * of this spec used `baseURL` and failed with exactly that — the stock menu, no `MultiplayerButton`.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState, guestAsks } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

test.describe('KDM-233 — hosting and joining, end to end', () => {
	test('the host is ASKED, and only their Accept starts the session (E1, E2)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			await press(host, 'KDMPHost');
			expect((await lobbyState(host)).view).toBe('host');

			await guestAsks(guest, port, 'Ada');

			// The host is asked — BY NAME, which is all approval-only gives them to judge by.
			await expect.poll(async () => (await lobbyState(host)).pending?.name,
				{ timeout: 30_000, message: 'the host should be prompted' }).toBe('Ada');

			// …and until they answer, the guest is in nobody's session.
			expect(bridge.session.players, 'asking is not joining').toEqual(['host']);

			await press(host, 'KDMPAccept');

			await expect.poll(() => bridge.session.players.length,
				{ timeout: 120_000, message: 'accepted guest is seated' }).toBe(2);
			expect((await lobbyState(host)).pending, 'the prompt is consumed by the answer').toBe(null);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('Decline refuses the guest in words and leaves the host alone (E3)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			await press(host, 'KDMPHost');
			await guestAsks(guest, port, 'Bob');
			await expect.poll(async () => (await lobbyState(host)).pending?.name, { timeout: 30_000 }).toBe('Bob');

			await press(host, 'KDMPDecline');

			await expect.poll(async () => (await lobbyState(guest)).error,
				{ timeout: 30_000, message: 'E3/E6 — refused in words, not silence' }).toContain('declined');
			expect(bridge.session.players, 'the host keeps playing, alone').toEqual(['host']);
			expect((await lobbyState(host)).pending).toBe(null);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('an address with nobody hosting is reported, not left hanging (E6)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const guest = await ctx.newPage();
		try {
			await guestAsks(guest, port, 'Cy');

			await expect.poll(async () => (await lobbyState(guest)).error, { timeout: 30_000 })
				.toContain('Nobody is hosting');
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
