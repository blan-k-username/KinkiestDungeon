/**
 * E2E (KDM-237) — both players name themselves in the lobby, and the world uses those names.
 *
 * The unit spec (`tests/unit/mp-player-name.spec.ts`) proves the gate rules in milliseconds and the
 * seating on a directly-driven session. This one proves the half neither can reach: that the name a
 * player TYPES is the name that arrives — lobby field → `join` frame → gate → session → avatar.
 *
 * ── THE HOST IS THE POINT ─────────────────────────────────────────────────────────────────────────
 * KDM-233 gave the Join view a "Your name" field and the Host view nothing at all, so the host was
 * never asked. Half of a two-player session being nameless is not a partial feature, it is the
 * feature missing — hence the first case asserts the field exists on the host's path before anything
 * else is checked.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. The two players are given DIFFERENT names and each is asserted against its own seat. An
 *     implementation that broadcasts one name to both seats — the obvious way to get this wrong when
 *     a single `pending` slot is involved — passes "a name arrived" and fails here.
 *  2. The oracle is the SERVER's session, not the lobby's opinion of itself. A client can display
 *     whatever it likes; what matters is the name the world seated.
 *  3. The names are read after the session has STARTED, so they are the seated values rather than
 *     the in-flight request.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

test.describe('KDM-237 — the name you type is the name you get', () => {

	test('the host is asked for a name at all (N1)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port);
			// The field is on the lobby ROOT, reachable before either Host or Join is chosen — which
			// is also what lets the host be named, since Host connects straight from here.
			await expect(page.locator('#KDMPName'), 'the host must have somewhere to say who they are')
				.toHaveCount(1);
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('host and guest each arrive under their OWN name (N2, S1)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			await host.locator('#KDMPName').fill('Ada');
			await press(host, 'KDMPHost');

			await openLobby(guest, port);
			await press(guest, 'KDMPJoin');
			await guest.locator('#KDMPAddress').fill(`127.0.0.1:${port}`);
			await guest.locator('#KDMPName').fill('Bob');
			await press(guest, 'KDMPConnect');

			// The host is prompted by the guest's chosen name — already true before this task, and
			// asserted here because it is the same string the seat must end up holding.
			await expect.poll(async () => (await lobbyState(host)).pending?.name,
				{ timeout: 30_000 }).toBe('Bob');

			await press(host, 'KDMPAccept');
			await expect.poll(() => bridge.session.players.length,
				{ timeout: 120_000, message: 'both players seated' }).toBe(2);

			// THE ORACLE: the server's own view. Different names, each on its own seat — an
			// implementation that seats one name twice fails right here.
			const [hostId, guestId] = bridge.session.players;
			expect(bridge.session.displayNameOf(hostId)).toBe('Ada');
			expect(bridge.session.displayNameOf(guestId)).toBe('Bob');
			expect(bridge.gate.nameOf(hostId)).toBe('Ada');
			expect(bridge.gate.nameOf(guestId)).toBe('Bob');
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('a player who types no name is seated on the legacy label (N3, NF2)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port);
			await page.locator('#KDMPName').fill('   ');   // whitespace is not a name
			await press(page, 'KDMPHost');

			await expect.poll(() => bridge.gate.host, { timeout: 30_000 }).toBeTruthy();
			// The `#coop=` path and the whole MP e2e suite depend on this staying exactly as it was.
			// KDM-280: the id is per-tab now, so the SHAPE of the fallback is what is pinned here —
			// `Player <id>`, still built by the one function that owns it (NF2). Whether that is the
			// right thing to show a player is [[KDM-282]], deliberately not this spec's business.
			expect(bridge.gate.nameOf(bridge.gate.host)).toBe('');
			expect(bridge.session.displayNameOf(bridge.gate.host)).toBe('Player ' + bridge.gate.host);
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
