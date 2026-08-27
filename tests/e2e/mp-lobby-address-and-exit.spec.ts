/**
 * E2E (KDM-236) — the three things a player does that KDM-233 left unfinished: come back to an
 * address they already used, be TOLD when a host never answers, and walk away without leaving a
 * socket behind.
 *
 * ── WHAT EACH GROUP IS ACTUALLY PROVING ───────────────────────────────────────────────────────────
 *
 * **Address memory (A).** The trap here is a green that means nothing: if the page's own origin and
 * the address being typed are the same string, "the field remembered it" and "the field defaulted to
 * `location.host`" are indistinguishable. So the page is served from `localhost:<port>` and joined at
 * `127.0.0.1:<port>` — one machine, two strings — and the assertion is that the field comes back
 * holding the one that was TYPED. The negative test is the mutation control: an implementation that
 * remembers on submit instead of on connect passes the positive test and fails that one.
 *
 * **The bounded connect (F).** A wrong address in a browser does not always fail. A TCP peer that
 * accepts the connection and then says nothing produces neither `open` nor `error` — the socket sits
 * in CONNECTING forever — and that is precisely the state the old code had no way to leave. The
 * `net` server below reproduces it exactly, which is why this test cannot pass without a timer.
 *
 * **Teardown (T).** Asserted at the SERVER's gate, not at the client's opinion of itself: a lobby can
 * set `view = 'menu'` while its socket is still seated, and that was the bug. The last test is the
 * accept flow from `mp-lobby-join-flow.spec.ts` with one press changed — the guest leaves before the
 * host answers — so the divergence is the feature, and without the stale-socket guard the late
 * `joined` would drag that guest into a game they had already left.
 */
import { test, expect } from '@playwright/test';
import * as net from 'net';
import { press, openLobby, lobbyState, guestAsks } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** The value sitting in the join field right now, before anybody types into it. */
const addressField = (page: any) => page.locator('#KDMPAddress').inputValue();

/** Open the Join view from the lobby root. */
async function openJoinView(page: any) {
	await press(page, 'KDMPJoin');
}

test.describe('KDM-236 — the address you used, and the way back out', () => {

	test('a first-ever join view offers this page\'s own address (A3)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port, 'localhost');
			await openJoinView(page);
			// Nothing has ever been remembered in this fresh context, so the offer is the origin.
			expect(await addressField(page), 'no memory yet ⇒ this page\'s own host').toBe(`localhost:${port}`);
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('an address that reached a host is offered back next time (A1, A2)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			// Served from `localhost`, joined at `127.0.0.1` — see the header: the two must differ or
			// this test proves nothing.
			await openLobby(page, port, 'localhost');
			await openJoinView(page);
			await page.locator('#KDMPAddress').fill(`127.0.0.1:${port}`);
			await page.locator('#KDMPName').fill('Ada');
			await press(page, 'KDMPConnect');

			// Reaching the server is the whole condition for remembering: no host is up, so this ends
			// in a refusal — and a refusal still proves the address was good.
			await expect.poll(async () => (await lobbyState(page)).error,
				{ timeout: 30_000, message: 'the attempt must actually reach the server' })
				.toContain('Nobody is hosting');

			await press(page, 'KDMPBack');
			await openJoinView(page);
			expect(await addressField(page), 'the address that connected comes back')
				.toBe(`127.0.0.1:${port}`);
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('an address that never connected is not remembered (A2 negative)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		// A port with nothing on it. Bound and released, so it is free and refuses immediately.
		const dead = await new Promise<number>((res) => {
			const s = net.createServer();
			s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
		});
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			// First establish something worth forgetting.
			await openLobby(page, port, 'localhost');
			await openJoinView(page);
			await page.locator('#KDMPAddress').fill(`127.0.0.1:${port}`);
			await page.locator('#KDMPName').fill('Ada');
			await press(page, 'KDMPConnect');
			await expect.poll(async () => (await lobbyState(page)).error, { timeout: 30_000 })
				.toContain('Nobody is hosting');
			await press(page, 'KDMPBack');

			// Now a typo.
			await openJoinView(page);
			await page.locator('#KDMPAddress').fill(`127.0.0.1:${dead}`);
			await press(page, 'KDMPConnect');
			await expect.poll(async () => (await lobbyState(page)).error,
				{ timeout: 30_000, message: 'a dead port must be reported' }).toContain('127.0.0.1:' + dead);
			await press(page, 'KDMPBack');

			await openJoinView(page);
			expect(await addressField(page), 'a typo that never connected is not remembered')
				.toBe(`127.0.0.1:${port}`);
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	/**
	 * THE SILENT PEER: accepts the TCP connection and then says nothing, so the WebSocket handshake
	 * never completes and the browser fires neither `open` nor `error`. That is the exact state the
	 * old code had no way to leave, and it is why these two tests cannot pass without a timer.
	 */
	async function silentHost(): Promise<{ port: number; close: () => Promise<void> }> {
		const held: net.Socket[] = [];
		const srv = net.createServer((sock) => { held.push(sock); });
		const port = await new Promise<number>((res) => {
			srv.listen(0, '127.0.0.1', () => res((srv.address() as any).port));
		});
		return {
			port,
			close: async () => {
				held.forEach((s) => { try { s.destroy(); } catch (e) { /* ignore */ } });
				await new Promise((r) => srv.close(r));
			},
		};
	}

	/**
	 * The deadline is split across two tests ON PURPOSE. Asserting "the progress line is showing" and
	 * "the deadline fired" against ONE short deadline is a race with itself — the first read can
	 * legitimately land after the timer, which is how the first version of this test flaked. Each arm
	 * gets a deadline that makes its own assertion unambiguous instead.
	 */
	test('while a join is outstanding the player is told so (F4)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const silent = await silentHost();
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port, 'localhost');
			// A deadline far beyond this test: whatever we read, it cannot be the post-timeout state.
			await page.evaluate(() => { window.__coopConnectTimeoutMs = 600_000; });
			await openJoinView(page);
			await page.locator('#KDMPAddress').fill(`127.0.0.1:${silent.port}`);
			await page.locator('#KDMPName').fill('Ada');
			await press(page, 'KDMPConnect');

			const s = await lobbyState(page);
			expect(s.status, 'F4 — a progress line while it is outstanding').toBeTruthy();
			expect(s.error, 'F4 — and no error while it is merely outstanding').toBe('');
		} finally {
			await silent.close();
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('a host that never answers is given up on, in words (F1, F4)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const silent = await silentHost();
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port, 'localhost');
			await page.evaluate(() => { window.__coopConnectTimeoutMs = 1500; });
			await openJoinView(page);
			await page.locator('#KDMPAddress').fill(`127.0.0.1:${silent.port}`);
			await page.locator('#KDMPName').fill('Ada');
			await press(page, 'KDMPConnect');

			// F1: the wait ENDS, naming what was tried.
			await expect.poll(async () => (await lobbyState(page)).error,
				{ timeout: 30_000, message: 'F1 — a silent host must not hang the join view forever' })
				.toContain(`127.0.0.1:${silent.port}`);
			// F4: and "Connecting…" is not left standing underneath the error.
			expect((await lobbyState(page)).status, 'F4 — the progress line is cleared by the error').toBe('');
		} finally {
			await silent.close();
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('Cancel on the host view frees the seat (T1)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port);
			await press(page, 'KDMPHost');
			// The SERVER's gate, not the lobby's opinion of itself — that distinction is the bug.
			// KDM-280: the id is generated per tab now, so this asks whether slot 0 is SEATED, which
			// is what the sentence above always meant.
			await expect.poll(() => bridge.gate.host,
				{ timeout: 30_000, message: 'hosting seats slot 0' }).toBeTruthy();

			await press(page, 'KDMPBack');   // the Host view's Cancel

			await expect.poll(() => bridge.gate.host,
				{ timeout: 30_000, message: 'T1 — cancelling gives the seat back' }).toBe(null);
			expect(await page.evaluate(() => !window.__coop.ws), 'no socket left on the client').toBe(true);
			expect((await lobbyState(page)).view, 'and we are back at the lobby root').toBe('menu');
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('a guest who walks away is not dragged in by a late Accept (T2, T3)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			await press(host, 'KDMPHost');
			await guestAsks(guest, port, 'Ada');
			await expect.poll(async () => (await lobbyState(host)).pending?.name, { timeout: 30_000 }).toBe('Ada');

			// The one press that differs from the accept path in mp-lobby-join-flow.spec.ts.
			await press(guest, 'KDMPBack');
			expect(await guest.evaluate(() => !window.__coop.ws), 'T2 — the outstanding attempt is dropped').toBe(true);

			// The host answers a question nobody is asking any more.
			await press(host, 'KDMPAccept').catch(() => { /* the prompt may already be gone */ });
			await guest.waitForTimeout(2000);

			const g = await lobbyState(guest);
			expect(await guest.evaluate(() => window.__coop.started),
				'T3 — a late answer must not start a session we left').toBe(false);
			expect(g.view, 'T3 — and must not paint over the lobby we returned to').toBe('menu');
			expect(g.error, 'T3 — nor report an error about a request we withdrew').toBe('');
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
