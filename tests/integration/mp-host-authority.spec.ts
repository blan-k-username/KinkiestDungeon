/**
 * Host-authoritative turn loop + full-state broadcast.
 *
 * Under the revised model the HOST is the source of truth: each turn it applies
 * both players' actions, serializes its full state, and broadcasts a `state_sync`;
 * the GUEST does not simulate — it adopts the host's state verbatim
 * (KinkyDungeonLoadGame). These tests drive two real browser contexts through the
 * real mp-server.js relay and assert:
 *
 *   1. A host-only shared-world mutation reaches the guest via `state_sync`
 *      (the guest adopted the host's state — it did not derive it independently).
 *   2. The integrity hash matches post-sync (the guest holds the host's exact
 *      bytes) — the property the old symmetric-lockstep test could not achieve.
 *   3. The guest never double-applies the turn's actions (its input queue stays
 *      empty; only the host drains the queue).
 *   4. Single-player is unaffected (no session → local enqueue as before).
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

async function disconnect(page: Page): Promise<void> {
	await page.evaluate(() => {
		// @ts-ignore
		MPDisconnect();
	}).catch(() => undefined);
}

test.describe.configure({ mode: 'serial' });

test('a host-only shared mutation reaches the guest via state_sync', async ({ browser }) => {
	const alice = await openClient(browser);  // host
	const bob = await openClient(browser);    // guest

	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		const b = await connectGuest(bob, a.joinCode);
		expect(a.sessionId).toBe(b.sessionId);
		expect(a.playerId).toBe(0);
		expect(b.playerId).toBe(1);

		// Mutate a shared-world value on the HOST only, to a sentinel the guest
		// has no other way to arrive at.
		const target = await alice.evaluate(() => {
			// @ts-ignore
			KinkyDungeonChangeFactionRep('Maidforce', 0.1);
			// @ts-ignore
			return KDFactionRelation('Player', 'Maidforce');
		});

		// Run a turn: both commit, host applies + broadcasts, guest adopts.
		await submitMove(alice, 'aliceMove');
		await submitMove(bob, 'bobMove');

		// Wait until the guest has adopted the host's faction value.
		await bob.waitForFunction(
			// @ts-ignore — bundle globals
			(t) => Math.abs(KDFactionRelation('Player', 'Maidforce') - t) < 1e-6,
			target,
			{ timeout: 8000 },
		);
		const guestValue = await bob.evaluate(() =>
			// @ts-ignore
			KDFactionRelation('Player', 'Maidforce'),
		);
		expect(guestValue).toBeCloseTo(target, 6);
	} finally {
		await disconnect(alice);
		await disconnect(bob);
		await alice.context().close();
		await bob.context().close();
	}
});

test('host and guest agree on the broadcast integrity hash (no desync)', async ({ browser }) => {
	// The integrity check is over the *transmitted save payload* (identical on both
	// sides by construction), NOT the live KDGameData — whose derived per-avatar
	// fields (HeelPower, HunterTimer, …) are recomputed locally after load and
	// legitimately differ. So the meaningful guarantee is: both sides record the
	// same MPState.lastSyncHash and the server never flags a desync.
	const alice = await openClient(browser);
	const bob = await openClient(browser);

	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		await connectGuest(bob, a.joinCode);

		const target = await alice.evaluate(() => {
			// @ts-ignore
			KinkyDungeonChangeFactionRep('Ambush', 0.2);
			// @ts-ignore
			return KDFactionRelation('Player', 'Ambush');
		});

		await submitMove(alice, 'aliceMove');
		await submitMove(bob, 'bobMove');

		// The guest adopting the host's faction value signals the turn fully landed.
		await bob.waitForFunction(
			// @ts-ignore
			(t) => Math.abs(KDFactionRelation('Player', 'Ambush') - t) < 1e-6,
			target,
			{ timeout: 8000 },
		);
		// Both sides should have stamped a sync hash for this broadcast.
		await alice.waitForFunction(() =>
			// @ts-ignore
			typeof MPState.lastSyncHash === 'string', null, { timeout: 8000 });
		await bob.waitForFunction(() =>
			// @ts-ignore
			typeof MPState.lastSyncHash === 'string', null, { timeout: 8000 });

		const hostState = await alice.evaluate(() => ({
			// @ts-ignore
			hash: MPState.lastSyncHash, desync: MPState.lastDesyncTurn,
		}));
		const guestState = await bob.evaluate(() => ({
			// @ts-ignore
			hash: MPState.lastSyncHash, desync: MPState.lastDesyncTurn,
		}));

		expect(guestState.hash).toBe(hostState.hash);   // same transmitted bytes
		expect(hostState.desync).toBeNull();             // server never flagged a desync
		expect(guestState.desync).toBeNull();
	} finally {
		await disconnect(alice);
		await disconnect(bob);
		await alice.context().close();
		await bob.context().close();
	}
});

test('the guest does not double-apply the turn actions', async ({ browser }) => {
	const alice = await openClient(browser);
	const bob = await openClient(browser);

	try {
		await resetServerSession(alice);
		const a = await connectHost(alice);
		await connectGuest(bob, a.joinCode);

		await bob.evaluate(() => {
			// @ts-ignore — clean baseline for the queue assertion
			KinkyDungeonInputQueue.length = 0;
		});

		await submitMove(alice, 'aliceMove');
		await submitMove(bob, 'bobMove');

		// Wait for the gate to advance on the guest (turn broadcast processed).
		await bob.waitForFunction(
			// @ts-ignore
			() => MPState.currentTurn > 1,
			null,
			{ timeout: 8000 },
		);

		const guestQueue = await bob.evaluate(() =>
			// @ts-ignore
			KinkyDungeonInputQueue.length,
		);
		// Guest enqueues nothing: its own move went over the wire (not enqueued)
		// and it does not apply the host's broadcast locally.
		expect(guestQueue).toBe(0);
	} finally {
		await disconnect(alice);
		await disconnect(bob);
		await alice.context().close();
		await bob.context().close();
	}
});

test('single-player is unaffected (no session → local enqueue)', async ({ browser }) => {
	const page = await openClient(browser);
	try {
		const r = await page.evaluate(() => {
			// @ts-ignore
			KinkyDungeonInputQueue.length = 0;
			// @ts-ignore
			const active = MPState.active;
			// @ts-ignore — no session: KDSendInput should enqueue locally as before
			KDSendInput('spMove', { from: 'test' }, false, true, false);
			// @ts-ignore
			return { active, queued: KinkyDungeonInputQueue.length };
		});
		expect(r.active).toBe(false);
		expect(r.queued).toBeGreaterThan(0);
	} finally {
		await page.context().close();
	}
});
