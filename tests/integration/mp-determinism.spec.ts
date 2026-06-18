/**
 * Host worldgen reproducibility.
 *
 * NOTE: the multiplayer model was revised to host-authoritative full-state
 * broadcast; the guest adopts the host's state rather than regenerating it,
 * so cross-client byte-identical simulation is no longer the sync mechanism.
 * These tests are kept because they document a still-useful property: the
 * HOST's init is deterministic given the seed (good for save/load
 * reproducibility), and MPStartSharedGame resets the global id counters so a
 * client's prior history doesn't perturb a fresh game.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { waitForBundleReady } from '../helpers/bundle';

declare let KinkyDungeonEnemyID: number;
declare const MPState: any;
declare function MPStartSharedGame(seed: string, todayDateMs: number): void;
declare function KDComputeStateHash(): string;

async function openClient(browser: Browser): Promise<Page> {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/');
	await waitForBundleReady(page);
	return page;
}

test.describe.configure({ mode: 'serial' });

test('same seed + date yields an identical state hash across two contexts', async ({ browser }) => {
	const a = await openClient(browser);
	const b = await openClient(browser);
	try {
		const ha = await a.evaluate(() => { MPStartSharedGame('seed-x', 1700000000000); return KDComputeStateHash(); });
		const hb = await b.evaluate(() => { MPStartSharedGame('seed-x', 1700000000000); return KDComputeStateHash(); });
		expect(ha).toBe(hb);
	} finally {
		await a.context().close();
		await b.context().close();
	}
});

test('a prior-history client still converges (id-counter reset)', async ({ browser }) => {
	const a = await openClient(browser);
	const b = await openClient(browser);
	try {
		// Context A simulates having played a prior game (id counter advanced).
		const ha = await a.evaluate(() => { KinkyDungeonEnemyID = 500; MPStartSharedGame('seed-y', 1700000000000); return KDComputeStateHash(); });
		const hb = await b.evaluate(() => { MPStartSharedGame('seed-y', 1700000000000); return KDComputeStateHash(); });
		expect(ha).toBe(hb);
	} finally {
		await a.context().close();
		await b.context().close();
	}
});

test('single-player path is unaffected (no shared start)', async ({ browser }) => {
	const page = await openClient(browser);
	try {
		const r = await page.evaluate(() => ({ active: MPState.active }));
		expect(r.active).toBe(false);
	} finally {
		await page.context().close();
	}
});
