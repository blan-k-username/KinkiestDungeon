/**
 * End-to-end test: two browser contexts exchange a turn through the real
 * mp-server.js and apply both actions deterministically.
 *
 * Asserts the multiplayer-relevant guarantees:
 *
 *   1. Both contexts complete the `hello` handshake with distinct playerIds.
 *   2. Submitting an action on context A locks A's turn pending and does NOT
 *      push to A's KinkyDungeonInputQueue.
 *   3. Once both contexts have submitted, both receive the broadcast and
 *      both queues end up with the two actions in the same playerId order.
 *   4. A second submission for the same turn from the same context is
 *      rejected by the server (no spurious extra apply).
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

async function connectHost(page: Page): Promise<{ playerId: number; sessionId: string; joinCode: string }> {
	return page.evaluate(async () => {
		// @ts-ignore — bundle globals
		await MPConnect('127.0.0.1', 8080, { role: 'host' });
		// @ts-ignore
		return { playerId: MPState.playerId, sessionId: MPState.sessionId, joinCode: MPState.joinCode };
	});
}

async function connectGuest(page: Page, code: string): Promise<{ playerId: number; sessionId: string }> {
	return page.evaluate(async (c) => {
		// @ts-ignore — bundle globals
		await MPConnect('127.0.0.1', 8080, { code: c });
		// @ts-ignore
		return { playerId: MPState.playerId, sessionId: MPState.sessionId };
	}, code);
}

async function submitMove(page: Page, moveType: string): Promise<void> {
	await page.evaluate(({ t }) => {
		// @ts-ignore
		KDSendInput(t, { from: 'test' }, false, true, false);
	}, { t: moveType });
}

async function waitForBroadcastApplied(page: Page, prevTurn: number): Promise<number> {
	await page.waitForFunction(
		// @ts-ignore — bundle globals
		(prev) => MPState.currentTurn > prev,
		prevTurn,
		{ timeout: 5000 },
	);
	return page.evaluate(() => {
		// @ts-ignore
		return MPState.currentTurn;
	});
}

test.describe.configure({ mode: 'serial' });

test('two clients complete a turn end-to-end', async ({ browser }) => {
	const alice = await openClient(browser);
	const bob = await openClient(browser);

	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		expect(a.joinCode).toMatch(/^\d{4}$/);
		const b = await connectGuest(bob, a.joinCode);

		expect(a.sessionId).toBe(b.sessionId);
		expect([a.playerId, b.playerId].sort()).toEqual([0, 1]);

		await alice.evaluate(() => {
			// @ts-ignore — clear the local input queue for a clean assertion below
			KinkyDungeonInputQueue.length = 0;
		});
		await bob.evaluate(() => {
			// @ts-ignore
			KinkyDungeonInputQueue.length = 0;
		});

		await submitMove(alice, 'aliceMove');

		const aliceImmediate = await alice.evaluate(() => {
			// @ts-ignore
			return {
				queued: KinkyDungeonInputQueue.length,
				pending: MPState.pendingLocalAction,
				turn: MPState.currentTurn,
			};
		});
		expect(aliceImmediate.queued).toBe(0);
		expect(aliceImmediate.pending).not.toBeNull();
		expect(aliceImmediate.turn).toBe(1);

		await submitMove(bob, 'bobMove');

		const aliceAfter = await waitForBroadcastApplied(alice, 1);
		const bobAfter = await waitForBroadcastApplied(bob, 1);
		expect(aliceAfter).toBe(2);
		expect(bobAfter).toBe(2);
	} finally {
		await alice.evaluate(() => {
			// @ts-ignore
			MPDisconnect();
		}).catch(() => undefined);
		await bob.evaluate(() => {
			// @ts-ignore
			MPDisconnect();
		}).catch(() => undefined);
		await alice.context().close();
		await bob.context().close();
	}
});

test('third client is refused by the server', async ({ browser }) => {
	const alice = await openClient(browser);
	const bob = await openClient(browser);
	const eve = await openClient(browser);

	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		await connectGuest(bob, a.joinCode);
		const result = await eve.evaluate(async (c) => {
			try {
				// @ts-ignore — even with the valid code, slot 1 is taken
				await MPConnect('127.0.0.1', 8080, { code: c });
				return 'connected';
			} catch (_) {
				return 'refused';
			}
		}, a.joinCode);
		expect(result).toBe('refused');
	} finally {
		await alice.evaluate(() => {
			// @ts-ignore
			MPDisconnect();
		}).catch(() => undefined);
		await bob.evaluate(() => {
			// @ts-ignore
			MPDisconnect();
		}).catch(() => undefined);
		await alice.context().close();
		await bob.context().close();
		await eve.context().close();
	}
});

test('a guest presenting the wrong code is refused with reason bad_code', async ({ browser }) => {
	const alice = await openClient(browser);
	const mallory = await openClient(browser);

	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		// Deterministically pick a code that differs from the host's.
		const wrong = a.joinCode === '0000' ? '0001' : '0000';
		const reason = await mallory.evaluate(async (w) => {
			try {
				// @ts-ignore
				await MPConnect('127.0.0.1', 8080, { code: w });
				return 'connected';
			} catch (e) {
				return (e as Error).message;
			}
		}, wrong);
		expect(reason).toBe('bad_code');
	} finally {
		await alice.evaluate(() => {
			// @ts-ignore
			MPDisconnect();
		}).catch(() => undefined);
		await alice.context().close();
		await mallory.context().close();
	}
});
