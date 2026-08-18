/**
 * E2E (Playwright/Chromium) — light coverage for KD-094 (KD-073c).
 *
 * Starts the demo server in PvP mode (KD_PVP=1) and joins two browsers. Asserts the heart of
 * the "peers-as-Enemy" design: in a PvP session each player sees the OTHER player's avatar as a
 * regular Enemy faction (so stock attack mechanics originate the attack). The authoritative
 * damage/bind routing itself is covered deterministically at the node layer (mp-pvp*.spec.ts);
 * here we only verify the browser-visible faction so the flaky two-browser attack chain is avoided.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';

test('PvP session: each browser sees the peer avatar as Enemy faction', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	// Enable PvP for this demo-server instance BEFORE it builds the SwapSession.
	process.env.KD_PVP = '1';
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { start } = require('../../tools/mp-server/demo-server');
	const { server, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// In A's view, the single RemotePlayer avatar is B; the game must see it as Enemy.
		// KDM-210: wait for the avatar, then look it up BY ID — the 'RemotePlayer' name pattern
		// lives only in `waitForPeerAvatar`, and the wait removes the null-deref race.
		const peerA = await waitForPeerAvatar(A, { label: "A's view of the peer" });
		const factionForA = await A.evaluate((id) => {
			const peer = ((KDMapData as any).Entities || []).find((e: any) => e.id === id);
			return peer ? (KDGetFaction as any)(peer) : null;
		}, peerA.id);
		expect(factionForA).toBe('Enemy');

		// Symmetric in B's view.
		const peerB = await waitForPeerAvatar(B, { label: "B's view of the peer" });
		const factionForB = await B.evaluate((id) => {
			const peer = ((KDMapData as any).Entities || []).find((e: any) => e.id === id);
			return peer ? (KDGetFaction as any)(peer) : null;
		}, peerB.id);
		expect(factionForB).toBe('Enemy');
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
		delete process.env.KD_PVP;
	}
});
