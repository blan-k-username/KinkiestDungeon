/**
 * E2E (KDM-287) — the Host screen shows an address a friend can actually type.
 *
 * The unit specs pin the two halves separately: `mp-lan-address` decides what a shareable address
 * is, and `mp-lobby-share-address` decides which string the screen paints. NEITHER can see the
 * thing that was actually broken end to end — a host who opened the game the way the launcher tells
 * them to (`http://localhost:8090/`) being handed `localhost:8090` to give to a friend. That needs
 * a real browser on a real loopback origin, a real gateway on a real socket, and the real `joined`
 * frame between them, which is exactly what this spec is.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THE SECOND CASE IS A CONTROL, and it is a real one: the same server, reached over the SAME
 *     interface the first case is being told to share. A host that browsed by its LAN address must
 *     see that address unchanged (AC5) — so "always paint the server's list" fails here, and
 *     "always paint location.host" fails the first case. Neither shortcut is green in both.
 *  2. THE ADDRESS IS THE ASSERTION — the exact strings `lan-address.js` reports for this machine,
 *     not a count, not "something was painted", and not merely "no localhost" (which a blank screen
 *     also satisfies).
 *  3. IT SAYS WHEN IT DID NOTHING. On a machine with no non-loopback interface there is no address
 *     to share and nothing to assert, and the run SKIPS with that reason rather than passing
 *     silently — a self-adjusting oracle is only honest if it reports adjusting itself to nothing.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, paintedText } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lanAddresses } = require('../../tools/mp-server/lan-address');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Everything painted this frame, as one searchable blob. */
const screenText = async (page: any) => (await paintedText(page)).join(' │ ');

/**
 * Open the lobby at `origin`, press Host, and answer with what the host screen paints.
 *
 * ⚠️ ONE GATEWAY PER HOST. The host seat is a seat: a second page pressing Host on the same server
 * is refused and never reaches the host view, which reads as a ten-minute hang rather than as a
 * failure. Each arm below therefore gets its own `start(0)`.
 */
async function hostScreenAt(page: any, port: number, origin: string) {
	await openLobby(page, port, origin);
	await press(page, 'KDMPHost');
	// Wait on the HOST VIEW: the `joined` frame is what opens it, so `share` has landed by the time
	// it is showing. Waiting on `share` itself would make a pre-fix run hang for the full timeout
	// instead of failing its assertion.
	await page.waitForFunction(
		() => (window as any).KDMPLobby.view === 'host', undefined, { polling: 'raf', timeout: 60_000 });
	return screenText(page);
}

test.describe('KDM-287 — the address the host is told to share', () => {
	test('a host on localhost is shown its LAN address, and a host on its LAN address keeps it', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const bug = await start(0);
		const control = await start(0);
		const ctx = await browser.newContext();
		try {
			test.skip(lanAddresses(bug.port).length === 0,
				'this machine has no non-loopback IPv4 interface, so there is no address to share and '
				+ 'nothing for this spec to assert. It has not passed — it did not run.');

			// ── THE BUG. `openLobby`'s own default origin is 127.0.0.1, which is precisely the
			//    situation the launcher puts a host in.
			const expected = lanAddresses(bug.port);
			const loopback = await hostScreenAt(await ctx.newPage(), bug.port, '127.0.0.1');
			expect(loopback, 'the host was handed the one address a friend cannot use')
				.not.toMatch(/localhost|127\.0\.0\.1/);
			for (const a of expected.slice(0, 3)) expect(loopback).toContain(a);

			// ── THE CONTROL (AC5). A host reached over the very interface the first arm was told to
			//    share: already shareable, so it must simply see where it is.
			const lanOrigin = expected[0].replace(/:\d+$/, '');
			const lan = await hostScreenAt(await ctx.newPage(), control.port, lanOrigin);
			expect(lan).toContain(`${lanOrigin}:${control.port}`);
			expect(lan, 'a host that is already shareable must not be offered a list instead')
				.not.toMatch(/this machine only/i);
		} finally {
			await ctx.close().catch(() => { /* the page may already be gone */ });
			await new Promise((r) => bug.server.close(r));
			await new Promise((r) => control.server.close(r));
		}
	});
});
