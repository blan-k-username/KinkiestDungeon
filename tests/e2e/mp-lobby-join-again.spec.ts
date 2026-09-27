/**
 * E2E (KDM-298) — pressing Join again from the SAME tab re-asks; it never locks the player out.
 *
 * The owner's UAT: a guest pressed Join, nothing seemed to happen, pressed it again — and got
 * `Refused: duplicate_id` on that and every later attempt. The tab was refusing ITSELF: each press
 * opened a new WebSocket without closing the last one, the server's KDM-280 guard saw the id's earlier
 * socket still live, and the superseded socket then ignored the server's pings (its handlers bail on
 * `ws !== myWs` before the ping reply), so the server marked the player missing but never let go of
 * the id.
 *
 * ⚠️ THE ORACLE IS THE SOCKET COUNT AS WELL AS THE ABSENCE OF A REFUSAL. "No `duplicate_id`" alone is
 * also what a page that silently stopped asking would show; one socket for the whole life of the
 * lobby, a question that is still pending, and a seat that is still held are what the fix claims.
 * The different-tab impostor refusal (KDM-280) is deliberately untouched and covered by its own specs.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState, guestAsks } from '../helpers/mp-lobby';
import { MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Count every WebSocket the page opens, and every refusal frame it receives. */
function watchSockets(P: any) {
	const seen = { opened: 0, rejects: [] as string[], backs: [] as string[] };
	P.on('websocket', (ws: any) => {
		seen.opened++;
		ws.on('framereceived', (f: any) => {
			const s = String(f.payload);
			if (s.indexOf('"type":"reject"') >= 0) seen.rejects.push(s);
			if (s.indexOf('"type":"peer_back"') >= 0) seen.backs.push(s);
		});
	});
	return seen;
}

test('KDM-298 — Join pressed again while waiting for the host re-asks on the same socket', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	const g = watchSockets(guest);
	try {
		await openLobby(host, port);
		await press(host, 'KDMPHost');
		await guestAsks(guest, port, 'Bee');
		await expect.poll(async () => (await lobbyState(host)).pending?.name, { timeout: 30_000 }).toBe('Bee');
		expect(g.opened, 'control: one socket so far').toBe(1);

		for (let i = 0; i < 2; i++) {
			await press(guest, 'KDMPConnect');
			await guest.waitForTimeout(1500);
		}

		expect(g.rejects, 'the tab must never refuse itself').toEqual([]);
		expect(g.opened, 'and it must not dial a second socket').toBe(1);
		expect((await lobbyState(guest)).status, 'still visibly waiting').toMatch(/Waiting for the host/);
		expect(bridge.gate.pending && bridge.gate.pending.name, 'still the one pending question').toBe('Bee');

		// …and the question it is still asking can be answered.
		await press(host, 'KDMPAccept');
		await expect.poll(() => bridge.session.players.length, { timeout: 120_000 }).toBe(2);
	} finally {
		await hostCtx.close().catch(() => {});
		await guestCtx.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});

test('KDM-298 — Join pressed again after being let in keeps the seat instead of losing it', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	const g = watchSockets(guest);
	const h = watchSockets(host);
	try {
		await openLobby(host, port);
		await press(host, 'KDMPHost');
		// No preload: the guest is seated but its page is still loading — the owner's "nothing
		// happened" screen, which is exactly when a player presses Join again.
		await guestAsks(guest, port, 'Bee');
		await expect.poll(async () => (await lobbyState(host)).pending?.name, { timeout: 30_000 }).toBe('Bee');
		await press(host, 'KDMPAccept');
		await expect.poll(() => bridge.session.players.length, { timeout: 120_000 }).toBe(2);
		const guestId = bridge.session.players[1];

		await press(guest, 'KDMPConnect');
		await guest.waitForTimeout(3000);

		expect(g.rejects, 'the tab must never refuse itself').toEqual([]);
		expect(g.opened, 'and it must not dial a second socket').toBe(1);
		expect(bridge.session.players, 'the seat is still theirs').toEqual([bridge.gate.host, guestId]);
		expect(bridge.presence.state(guestId), 'and they are not marked missing').toBe('connected');
		// A re-ask on the socket that never dropped is not a return: the host must not be told "your
		// partner is back — the game has resumed" about someone who never left.
		expect(h.backs, 'no false "partner is back" to the host').toEqual([]);
	} finally {
		await hostCtx.close().catch(() => {});
		await guestCtx.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
