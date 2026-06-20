/**
 * E2E (Playwright/Chromium): the hands-on co-op demo launcher — KD-071.
 *
 * Starts the real demo server (static game + WS bridge on one port) and drives TWO
 * independent browser windows against it, exactly as a human would:
 *   window A → /#coop=A , window B → /#coop=B → the shared dungeon starts.
 * Asserts both render the SAME server-owned world and that a lockstep move (both
 * submit) advances the shared turn — proving the two-browser UAT path works.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('two browser windows play one shared co-op dungeon via the demo server', async ({ browser }) => {
	test.setTimeout(120_000);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 60_000 });

		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		// both joined → server starts the shared world → both receive their first state
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 60_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 60_000 });

		// both windows render the SAME shared, server-owned dungeon, render-only
		const ga = await A.evaluate(() => (KDMapData as any).Grid);
		const gb = await B.evaluate(() => (KDMapData as any).Grid);
		expect(typeof ga).toBe('string');
		expect(ga.length).toBeGreaterThan(0);
		expect(ga).toBe(gb);
		// @ts-ignore — KDServerRole is a bundle `let` global, not on window
		expect(await A.evaluate(() => (typeof KDServerRole !== 'undefined' ? KDServerRole : null))).toBe('client');

		// lockstep move: both submit → the shared turn advances by exactly one
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendMove(1, 0));
		await A.waitForTimeout(200);
		await B.evaluate(() => (window as any).__coop.sendMove(0, 0));
		await A.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, t0, { timeout: 30_000 });
		await B.waitForFunction((prev) => (window as any).__coop.lastTick === prev + 1, t0, { timeout: 30_000 });
		expect(await A.evaluate(() => (window as any).__coop.lastTick)).toBe(t0 + 1);

		// real rendered frames in both windows
		const shotA = await A.locator('#MainCanvas').screenshot();
		const shotB = await B.locator('#MainCanvas').screenshot();
		expect(shotA.length).toBeGreaterThan(1000);
		expect(shotB.length).toBeGreaterThan(1000);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
	}
});
