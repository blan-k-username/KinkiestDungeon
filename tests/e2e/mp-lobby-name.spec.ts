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

	test('KDM-282 — two players who type no name are seated by SEAT, not by raw id (N3, NF2)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			await host.locator('#KDMPName').fill('   ');   // whitespace is not a name
			await press(host, 'KDMPHost');

			await expect.poll(() => bridge.gate.host, { timeout: 30_000 }).toBeTruthy();
			// The `#coop=` path and the whole MP e2e suite depend on this: an empty name field is
			// not a name, and the seat records nothing. KDM-280 made the id per-tab; KDM-282 then
			// gave the label below a seat to use instead of that id.
			expect(bridge.gate.nameOf(bridge.gate.host)).toBe('');

			// ---- BOTH seats, because the fallback has two of them -----------------------------
			// This test used to host alone and pin `Player <id>`. Bringing a second unnamed player
			// in is the whole of KDM-282's acceptance criterion: one seat cannot show that the
			// label is a SEAT rather than a constant, and the two-unnamed-players case is the one
			// where a naive fallback ("Player", "Guest") makes both people the same person.
			await openLobby(guest, port);
			await press(guest, 'KDMPJoin');
			await guest.locator('#KDMPAddress').fill(`127.0.0.1:${port}`);
			await guest.locator('#KDMPName').fill('');
			await press(guest, 'KDMPConnect');
			await expect.poll(async () => (await lobbyState(host)).pending !== undefined,
				{ timeout: 30_000, message: 'the host is asked about the guest' }).toBe(true);
			await press(host, 'KDMPAccept');
			await expect.poll(() => bridge.session.players.length,
				{ timeout: 120_000, message: 'both players seated' }).toBe(2);

			const [hostId, guestId] = bridge.session.players;
			expect(bridge.gate.nameOf(guestId), 'the guest typed no name either').toBe('');

			// THE ORACLE. Literals, not `toMatch(/Player/)`: this string labels an avatar across the
			// whole MP suite, and "a label exists" is exactly the assertion that let a raw client id
			// ship onto the screen in the first place.
			//
			// It is also the only end-to-end proof that `_carrySeat` carries the role at all — the
			// session-level tiers are pinned in `tests/unit/mp-player-name.spec.ts`, but nothing
			// there boots a bridge, so nothing there can tell a carried role from a missing one.
			expect(bridge.session.displayNameOf(hostId)).toBe('Player 1');
			expect(bridge.session.displayNameOf(guestId)).toBe('Player 2');

			// CONTROL 1 — the raw id is GONE from the answer, not merely prefixed differently.
			expect(bridge.session.displayNameOf(hostId)).not.toBe('Player ' + hostId);
			expect(bridge.session.displayNameOf(guestId)).not.toBe('Player ' + guestId);
			// CONTROL 2 — and the two are still told apart. A fallback that answers one constant
			// for everybody passes both literals above only if it is wrong about one of them, but
			// it would sail through a `toMatch(/^Player /)` pair; this states the rule directly.
			expect(bridge.session.displayNameOf(hostId))
				.not.toBe(bridge.session.displayNameOf(guestId));
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
