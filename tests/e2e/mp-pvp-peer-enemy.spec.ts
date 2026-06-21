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

test('PvP session: each browser sees the peer avatar as Enemy faction', async ({ browser }) => {
	test.setTimeout(300_000);
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
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });
		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForTimeout(1500);

		// In A's view, the single RemotePlayer avatar is B; the game must see it as Enemy.
		const factionForA = await A.evaluate(() => {
			const ents = (KDMapData as any).Entities || [];
			const peer = ents.find((e: any) => e.Enemy && e.Enemy.name === 'RemotePlayer');
			return peer ? (KDGetFaction as any)(peer) : null;
		});
		expect(factionForA).toBe('Enemy');

		// Symmetric in B's view.
		const factionForB = await B.evaluate(() => {
			const ents = (KDMapData as any).Entities || [];
			const peer = ents.find((e: any) => e.Enemy && e.Enemy.name === 'RemotePlayer');
			return peer ? (KDGetFaction as any)(peer) : null;
		});
		expect(factionForB).toBe('Enemy');
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
		delete process.env.KD_PVP;
	}
});
