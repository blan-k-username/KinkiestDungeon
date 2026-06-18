/**
 * Second co-op player avatar (spawn / control / sync).
 *
 * Under host-authority the host spawns a real P2 entity (KDMapData.Entities,
 * playerSlot:1) once a peer connects; it renders + serializes + rides state_sync for
 * free. The guest controls slot 1; the host controls slot 0. These two-client tests
 * (real server + bundle) assert spawn, propagation, binding, and move routing.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForBundleReady } from '../helpers/bundle';
import { resetKDState } from '../helpers/state';

async function resetServerSession(page: Page): Promise<void> {
	await page.request.get('/_test/reset');
}

async function openClient(browser: import('@playwright/test').Browser): Promise<Page> {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/');
	await waitForBundleReady(page);
	await resetKDState(page);
	return page;
}

async function connectHost(page: Page): Promise<{ joinCode: string }> {
	return page.evaluate(async () => {
		// @ts-ignore
		await MPConnect('127.0.0.1', 8080, { role: 'host' });
		// @ts-ignore
		return { joinCode: MPState.joinCode };
	});
}

async function connectGuest(page: Page, code: string): Promise<void> {
	await page.evaluate(async (c) => {
		// @ts-ignore
		await MPConnect('127.0.0.1', 8080, { code: c });
	}, code);
}

/**
 * Submit a turn action. `[dx,dy]` is a real `move`; `null` is a HOLD — a benign
 * non-move input so the turn gate resolves without touching any avatar position.
 */
async function submitMove(page: Page, dir: [number, number] | null): Promise<void> {
	await page.evaluate((d) => {
		if (d === null) {
			// @ts-ignore — unknown input type: KDProcessInput is a no-op for it
			KDSendInput('mpnoop', { from: 'test' }, false, true, false);
		} else {
			// @ts-ignore
			KDSendInput('move', { dir: { x: d[0], y: d[1] }, delta: 1, from: 'test' }, false, true, false);
		}
	}, dir);
}

async function disconnect(page: Page): Promise<void> {
	await page.evaluate(() => {
		// @ts-ignore
		MPDisconnect();
	}).catch(() => undefined);
}

/** Run one turn: both clients submit, wait for the gate to advance on the host. */
async function runTurn(host: Page, guest: Page, hostMove: [number, number] | null, guestMove: [number, number] | null): Promise<void> {
	const prev = await host.evaluate(() => {
		// @ts-ignore
		return MPState.currentTurn;
	});
	await submitMove(host, hostMove);
	await submitMove(guest, guestMove);
	await host.waitForFunction((p) =>
		// @ts-ignore
		MPState.currentTurn > p, prev, { timeout: 8000 });
	// Give the host's state_sync time to reach the guest.
	await guest.waitForFunction((p) =>
		// @ts-ignore
		MPState.currentTurn > p, prev, { timeout: 8000 });
}

test.describe.configure({ mode: 'serial' });

test('host spawns a P2 avatar that the guest adopts and binds locally', async ({ browser }) => {
	const alice = await openClient(browser);  // host
	const bob = await openClient(browser);    // guest
	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		await connectGuest(bob, a.joinCode);

		// First turn triggers the host's KDEnsureCoopPlayers → spawns P2.
		await runTurn(alice, bob, null, null);

		const host = await alice.evaluate(() => {
			// @ts-ignore
			const p2 = KDPlayerById(1);
			// @ts-ignore
			const inEntities = !!(KDMapData.Entities || []).find((e) => e && e.playerSlot === 1);
			return {
				// @ts-ignore
				hasP2: !!p2, slot: p2 && p2.playerSlot, inEntities, localId: KDLocalPlayerId,
				// @ts-ignore — host's own avatar is slot 0 and is the global
				slot0IsGlobal: KDPlayerById(0) === KinkyDungeonPlayerEntity,
			};
		});
		expect(host.hasP2).toBe(true);
		expect(host.slot).toBe(1);
		expect(host.inEntities).toBe(true);
		expect(host.localId).toBe(0);
		expect(host.slot0IsGlobal).toBe(true);

		// The guest adopts the host's state (P2 entity) and binds it to its own slot.
		await bob.waitForFunction(() =>
			// @ts-ignore
			!!(KDMapData.Entities || []).find((e) => e && e.playerSlot === 1), null, { timeout: 8000 });
		const guest = await bob.evaluate(() => {
			// @ts-ignore
			const p2 = KDPlayerById(1);
			return {
				// @ts-ignore
				hasP2: !!p2, localId: KDLocalPlayerId,
				// @ts-ignore — guest's local player IS its own slot-1 avatar
				localIsP2: KDLocalPlayer() === KDPlayerById(1),
				// @ts-ignore — and is distinct from the host's slot-0 avatar
				distinctFromHostAvatar: KDPlayerById(1) !== KDPlayerById(0),
			};
		});
		expect(guest.hasP2).toBe(true);
		expect(guest.localId).toBe(1);
		expect(guest.localIsP2).toBe(true);
		expect(guest.distinctFromHostAvatar).toBe(true);
	} finally {
		await disconnect(alice);
		await disconnect(bob);
		await alice.context().close();
		await bob.context().close();
	}
});

test('the guest controls slot 1 and the host controls slot 0', async ({ browser }) => {
	const alice = await openClient(browser);
	const bob = await openClient(browser);
	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		await connectGuest(bob, a.joinCode);
		await runTurn(alice, bob, null, null);  // spawn P2 (P2 sits at host.x+1)

		// Routing invariant A: when the host HOLDS, a guest move can never move slot 0.
		// (Asserts the OTHER slot is untouched, so it is independent of walls/collision.)
		const s0before = await alice.evaluate(() => ({
			// @ts-ignore
			x: KDPlayerById(0).x, y: KDPlayerById(0).y,
		}));
		await runTurn(alice, bob, null, [1, 0]);  // host holds, guest moves +x
		const s0after = await alice.evaluate(() => ({
			// @ts-ignore
			x: KDPlayerById(0).x, y: KDPlayerById(0).y,
		}));
		expect(s0after.x).toBe(s0before.x);
		expect(s0after.y).toBe(s0before.y);

		// Routing invariant B: when the guest HOLDS and the host moves AWAY from P2
		// (P2 is to the host's right at +x; host moves -x), P2 (slot 1) is never moved.
		const s1before = await alice.evaluate(() => ({
			// @ts-ignore
			x: KDPlayerById(1).x, y: KDPlayerById(1).y,
		}));
		await runTurn(alice, bob, [-1, 0], null);  // host moves away, guest holds
		const s1after = await alice.evaluate(() => ({
			// @ts-ignore
			x: KDPlayerById(1).x, y: KDPlayerById(1).y,
		}));
		expect(s1after.x).toBe(s1before.x);
		expect(s1after.y).toBe(s1before.y);
	} finally {
		await disconnect(alice);
		await disconnect(bob);
		await alice.context().close();
		await bob.context().close();
	}
});

test('single-player is unaffected — no P2, local slot is 0', async ({ browser }) => {
	const page = await openClient(browser);
	try {
		const r = await page.evaluate(() => ({
			// @ts-ignore
			active: MPState.active, localId: KDLocalPlayerId, p2: KDPlayerById(1),
		}));
		expect(r.active).toBe(false);
		expect(r.localId).toBe(0);
		expect(r.p2).toBeFalsy();
	} finally {
		await page.context().close();
	}
});
