/**
 * In-game multiplayer lobby + session UX.
 *
 * Drives the factored lobby functions (KDLobbyHost / KDLobbyJoin /
 * KDLobbyEnterGameIfReady / KDMPOverlayState) via page.evaluate against the
 * real mp-server.js — the same functions the drawn buttons call. This proves
 * the lobby state machine and overlay logic without simulating canvas clicks
 * (that thin layer is covered by the e2e menu-button test).
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { waitForBundleReady } from '../helpers/bundle';
import { resetKDState } from '../helpers/state';

// Bundle globals reached inside page.evaluate (browser context).
declare let KinkyDungeonState: string;
declare const MPState: any;
declare function MPResetState(): void;
declare function MPDisconnect(): void;
declare function KDLobbyHost(): Promise<void>;
declare function KDLobbyJoin(host: string, code: string): Promise<void>;
declare function KDLobbyEnterGameIfReady(): void;
declare const KDLobbyStatus: { phase: string; reason?: string; message?: string };
declare function KDMPOverlayState(): { kind: string; message: string };

async function resetServerSession(page: Page): Promise<void> {
	await page.request.get('/_test/reset');
}

async function openClient(browser: Browser): Promise<Page> {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/');
	await waitForBundleReady(page);
	await resetKDState(page);
	return page;
}

test.describe.configure({ mode: 'serial' });

test('host shows a join code + waiting, guest joins, both end in Game state', async ({ browser }) => {
	const alice = await openClient(browser);
	const bob = await openClient(browser);
	try {
		await resetServerSession(alice);

		const a = await alice.evaluate(async () => {
			KinkyDungeonState = 'Multiplayer';
			await KDLobbyHost();
			return { active: MPState.active, ws: MPState.wsState, code: MPState.joinCode, phase: KDLobbyStatus.phase };
		});
		expect(a.active).toBe(true);
		expect(a.ws).toBe('open');
		expect(a.code).toMatch(/^\d{4}$/);
		expect(a.phase).toBe('waiting');

		// On join the guest does NOT jump to Game — it waits for the host.
		const bobAfterJoin = await bob.evaluate(async (code) => {
			KinkyDungeonState = 'Multiplayer';
			await KDLobbyJoin('127.0.0.1', code);
			return { state: KinkyDungeonState, phase: KDLobbyStatus.phase };
		}, a.code);
		expect(bobAfterJoin.state).toBe('Multiplayer');     // still in the lobby, waiting
		expect(bobAfterJoin.phase).toBe('waiting_host');

		// Host is notified the guest connected (server `peer_connected`).
		await alice.waitForFunction(() => MPState.peerConnected === true, null, { timeout: 8000 });

		// Host starts the shared game → guest receives session_init/state_sync.
		const aliceState = await alice.evaluate(() => {
			KDLobbyEnterGameIfReady();
			return KinkyDungeonState;
		});
		expect(aliceState).toBe('Game');

		// Now the guest transitions from waiting → playing.
		await bob.waitForFunction(() => KinkyDungeonState === 'Game', null, { timeout: 8000 });
		const bobFinal = await bob.evaluate(() => KinkyDungeonState);
		expect(bobFinal).toBe('Game');
	} finally {
		await alice.evaluate(() => MPDisconnect()).catch(() => undefined);
		await bob.evaluate(() => MPDisconnect()).catch(() => undefined);
		await alice.context().close();
		await bob.context().close();
	}
});

test('joining with the wrong code sets KDLobbyStatus error with reason bad_code', async ({ browser }) => {
	const alice = await openClient(browser);
	const mallory = await openClient(browser);
	try {
		await resetServerSession(alice);
		const code = await alice.evaluate(async () => {
			KinkyDungeonState = 'Multiplayer';
			await KDLobbyHost();
			return MPState.joinCode as string;
		});
		const wrong = code === '0000' ? '0001' : '0000';
		const st = await mallory.evaluate(async (w) => {
			KinkyDungeonState = 'Multiplayer';
			await KDLobbyJoin('127.0.0.1', w);
			return { phase: KDLobbyStatus.phase, reason: KDLobbyStatus.reason };
		}, wrong);
		expect(st.phase).toBe('error');
		expect(st.reason).toBe('bad_code');
	} finally {
		await alice.evaluate(() => MPDisconnect()).catch(() => undefined);
		await alice.context().close();
		await mallory.context().close();
	}
});

test('KDMPOverlayState derives none / waiting / peer_lost / desync from MPState', async ({ browser }) => {
	const page = await openClient(browser);
	try {
		const r = await page.evaluate(() => {
			const out: Record<string, string> = {};
			MPResetState();
			out.none = KDMPOverlayState().kind;

			MPState.active = true; MPState.peerConnected = true; MPState.currentTurn = 3;
			MPState.pendingLocalAction = { turn: 3, type: 'move', data: {} };
			MPState.lastDesyncTurn = null;
			out.waiting = KDMPOverlayState().kind;

			MPState.peerConnected = false;
			out.peerLost = KDMPOverlayState().kind;

			MPState.peerConnected = true; MPState.pendingLocalAction = null; MPState.lastDesyncTurn = 3;
			out.desync = KDMPOverlayState().kind;

			MPResetState();
			return out;
		});
		expect(r.none).toBe('none');
		expect(r.waiting).toBe('waiting');
		expect(r.peerLost).toBe('peer_lost');
		expect(r.desync).toBe('desync');
	} finally {
		await page.context().close();
	}
});

test('single-player path leaves MPState inactive and the overlay at none', async ({ browser }) => {
	const page = await openClient(browser);
	try {
		const r = await page.evaluate(() => ({ active: MPState.active, overlay: KDMPOverlayState().kind }));
		expect(r.active).toBe(false);
		expect(r.overlay).toBe('none');
	} finally {
		await page.context().close();
	}
});
