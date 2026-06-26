/**
 * E2E (KD-101 UAT aid) — a carryable starting restraint item.
 *  - Client: `#coop=<id>&startitem=HingedCuffs` adds a loose-restraint ITEM to that client's Items
 *    inventory (coop-bootstrap ensureStartItem) — the inventory is client-local, snapshots don't sync it.
 *  - Server: KD_START_RESTRAINT=HingedCuffs gives each player's bundle the same loose item so an apply
 *    also runs server-side.
 * Verifies the client carries the item (what the player sees in Items).
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const CUFFS = 'HingedCuffs';

test('KD_START_RESTRAINT seeds a carryable restraint item on the client (no URL param needed)', async ({ browser }) => {
	test.setTimeout(180_000);
	process.env.KD_START_RESTRAINT = CUFFS;
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	try {
		// standard URL — no &startitem=; the server pushes the item name via snapshot.startItem
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });
		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop._startItemAdded, undefined, { timeout: 30_000 });

		// A carries the loose cuffs ITEM (visible in the Items inventory)
		const aHasItem = await A.evaluate((n) => {
			// @ts-ignore
			const it = (typeof KinkyDungeonInventoryGetLoose === 'function') ? KinkyDungeonInventoryGetLoose(n) : null;
			return it ? it.name : null;
		}, CUFFS);
		expect(aHasItem, `A should carry the ${CUFFS} item`).toBe(CUFFS);

		// it shows up among the loose-restraint inventory the bind/apply UI reads
		const aLoose = await A.evaluate(() => {
			// @ts-ignore
			const inv = (typeof KinkyDungeonFilterInventory === 'function')
				? KinkyDungeonFilterInventory(LooseRestraint, undefined, undefined, undefined, undefined, KDInvFilter, undefined, undefined, true) : [];
			return inv.map((f: any) => f.name);
		});
		expect(aLoose).toContain(CUFFS);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_START_RESTRAINT;
	}
});
