/**
 * E2E (KDM-259) — the host CHOOSES the run's seed, in the lobby, with the keyboard.
 *
 * KDM-239 R5 made the seed a session property that rides the host's handshake and is reproducible
 * from (`tests/unit/mp-start-ritual.spec.ts` R6). What it did not give anyone was a way to NAME one:
 * `worldSeed()` read a URL parameter and otherwise answered `''`. This spec is the missing half —
 * lobby field -> `join.world.seed` -> gate -> the value `_start` prefers over the server's own
 * (`swap-session.js:495`, `hostWorld.seed || this.seed`).
 *
 * ── WHY THE ORACLE IS THE GATE, NOT THE LOBBY ─────────────────────────────────────────────────────
 * `KDMPLobby.seed` holding what was typed would prove a DOM read works. The claim worth making is
 * that the string crossed the wire and became the session's declaration, so the oracle is
 * `bridge.gate.worldOf(host).seed` — the server's own record, the same one `mp-lobby-name.spec.ts`
 * uses for names and for the same reason.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THE CONTROL IS THE WHOLE POINT OF R2. A host who types nothing must still declare `''` —
 *     "use whatever the server was configured with". An implementation that made the field's mere
 *     existence mean "the seed is now literally empty" passes case 1 and fails the control, and that
 *     failure is the one that would silently change every default session.
 *  2. The asserted value is the TYPED STRING, not a count or a truthy check, so a field wired to the
 *     wrong state key (the name, say) fails here rather than passing.
 *  3. R3 reads the GUEST'S PAINTED SCREEN (`paintedText`), not lobby state — data arriving and
 *     nothing rendering it is the exact state KDM-249 sat in before KDM-257.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, guestAsks, lobbyState, paintedText } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Every string painted this frame, joined — the screen as one searchable blob. */
const screenText = async (page: any) => (await paintedText(page)).join(' │ ');

/** The seat the gate gave the host, once it has one. */
async function hostSeed(bridge: any) {
	await expect.poll(() => bridge.gate.host, { timeout: 30_000 }).toBeTruthy();
	return bridge.gate.worldOf(bridge.gate.host).seed;
}

test.describe('KDM-259 — a host can name the seed', () => {

	test('the host is asked for a seed at all, and what they type is what the session declares (R1, R3)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			// On the lobby ROOT, beside the name field — because `KDMPHost` connects straight from
			// here and the world declaration is read at ask time (KDM-270). A field on the waiting
			// screen would be typed into after the declaration had already gone.
			await expect(host.locator('#KDMPSeed'), 'the host must have somewhere to name the seed')
				.toHaveCount(1);
			await host.locator('#KDMPSeed').fill('run-42');
			await press(host, 'KDMPHost');

			// R1 — the server's own record of what this session is.
			expect(await hostSeed(bridge), 'the typed seed is the declared seed').toBe('run-42');

			// R3 — and a guest can read it while it can still walk away.
			await guestAsks(guest, port, 'Nyx');
			await guest.waitForFunction(
				() => /waiting/i.test(String((window as any).KDMPLobby.status || '')),
				undefined, { polling: 'raf' });
			const shown = await screenText(guest);
			expect(shown, 'the guest sees the seed before committing').toContain('run-42');
			/*
			 * ── A BUG THIS SPEC FOUND, PINNED HERE ────────────────────────────────────────────────
			 * `text()` guarded a missing key with `t !== key`, but KD answers a missing key with the
			 * literal `"[NotFound] <key>"` — so every label in this lobby was painting that marker at
			 * the player. It hid the seed too: the fallback `'• seed: SEED'` is what carries the
			 * `.replace('SEED', seed)` interpolation, and it was never the string being used.
			 *
			 * Asserted on the guest's screen because that is where it was caught, and because this
			 * screen paints six of those keys at once — a regression at any one of them fails here.
			 */
			expect(shown, 'no key marker is ever painted at a player (kd-peace-dialogue.js:46)')
				.not.toContain('[NotFound]');
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('CONTROL — a host who names no seed still means "the server\'s default" (R2)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			// THE CONTROL: the identical flow, minus the one fill.
			await openLobby(page, port);
			await press(page, 'KDMPHost');
			expect(await hostSeed(bridge), 'empty declares nothing, exactly as before this task').toBe('');
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('the seed survives moving between the lobby views (N1)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port);
			await page.locator('#KDMPSeed').fill('run-42');
			// `KDCullTempElements` destroys any field not drawn this frame, so a DOM-backed value that
			// is not cached back into lobby state is lost by the round trip — the bug the name field
			// already documents. Join draws no seed field, so this is that round trip.
			await press(page, 'KDMPJoin');
			await press(page, 'KDMPBack');
			expect((await lobbyState(page)).seed, 'what was typed is still there').toBe('run-42');
			await press(page, 'KDMPHost');
			expect(await hostSeed(bridge)).toBe('run-42');
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
