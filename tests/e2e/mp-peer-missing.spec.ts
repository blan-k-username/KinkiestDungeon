/**
 * E2E (KDM-250) — a player who leaves is a player the survivor is TOLD about.
 *
 * The node specs (`mp-presence`, `mp-heartbeat`) prove the rules and the protocol. This proves the
 * only part they cannot: that the report survives the whole stack into a REAL browser running the
 * real bundle, and lands somewhere the player can actually see. A `peer_missing` frame the client
 * silently discards would pass every node test in this slice and change nothing for the person
 * staring at a frozen turn — which is the bug KDM-234 exists to kill.
 *
 * ONE BOOT, both claims. A co-op boot is two full game bundles plus a node host, and boots are the
 * scarce resource in this suite (see `helpers/coop.ts`), so the control and the assertion share a
 * session: `peerMissing` is read BEFORE the drop and after it, on the same page.
 *
 * SCOPE. Slice 1 detects and reports, and that is deliberately all it does. The session is not paused
 * here (KDM-251) and no wait/solo choice is offered (KDM-253) — asserting either of those here would
 * be asserting a behaviour this slice does not claim.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, killCoopSocket, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** What this page believes about who is still here, plus the string it is showing the player. */
async function presenceOn(P: any) {
	return P.evaluate(() => {
		const c = (window as any).__coop || {};
		const el = document.getElementById('coop-overlay');
		return { peerMissing: c.peerMissing || null, status: (el && el.textContent) || '' };
	});
}

test('a co-op partner who drops is reported to the player who is still here', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// ---- control — with both players present, nobody is reported missing ------------------
		//
		// This is what makes the assertion below non-vacuous. "peerMissing is set" would also pass on
		// a client that sets it at boot, or on N2 firing during the handshake — the exact false
		// positive `everPaired` exists to prevent.
		const before = await presenceOn(A);
		expect(before.peerMissing, 'nobody has left yet').toBeNull();
		expect(before.status, 'and the overlay is not talking about a disconnect')
			.not.toMatch(/disconnect/i);

		// ---- B leaves ---------------------------------------------------------------------------
		//
		// KDM-252: `retry: false` — B is gone for the whole test. A bare close now heals itself in
		// ~1 s, which would make the assertions below race the reconnect. See `killCoopSocket`.
		// The socket is closed from inside B's page rather than by closing the context: that is the
		// real shape of a lost connection, and it leaves B's page alive so a failure here is legible.
		await killCoopSocket(B, { retry: false });

		// ---- A is told, and told WHO and in WHICH ROLE (E2, E3) ----------------------------------
		await A.waitForFunction(
			() => !!((window as any).__coop && (window as any).__coop.peerMissing),
			undefined,
			{ timeout: 60_000 },
		);
		const after = await presenceOn(A);
		expect(after.peerMissing!.clientId, 'the survivor learns who left').toBe('B');
		expect(after.peerMissing!.role, 'B joined second, so B is the guest').toBe('guest');
		expect(after.status, 'and it reaches the player, not just an object nobody renders')
			.toMatch(/disconnect/i);
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
