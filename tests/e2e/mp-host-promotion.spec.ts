/**
 * E2E (KDM-303) — the host's browser goes away; after the grace the guest is the host and plays on,
 * and when the old host's tab comes back it rejoins as a guest.
 *
 * The node spec (`tests/unit/mp-host-promotion.spec.ts`) proves the seat rules. This proves the two
 * halves only a browser has: the guest's page really BECOMES the host (`coop.isHost()`, which gates the
 * host-only menu entry and the seat a reconnect claims), and a returning old host's page, already in
 * the game, asks as a guest by itself instead of being stranded.
 *
 * ⚠️ KEEPING THE HOST AWAY. The co-op client reconnects on its own within a second, which would be a
 * host "back in time" (R2) and no promotion at all. So the host's browser is put OFFLINE before its
 * socket is cut: every reconnect attempt fails until the spec brings it back — the same thing a laptop
 * lid or a dropped Wi-Fi does. The grace is shortened (`hostGraceMs`); the owner's default is 2 min.
 */
import { test, expect } from '@playwright/test';
import { answerCoopDialogue, bootCoopPair, killCoopSocket, MP_TEST_TIMEOUT, reportedPageErrors } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HOST_LOST_DIALOGUE, NOW_HOST_DIALOGUE, JOIN_ASK_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const GRACE = 4000;

const dialog = (P: any) => P.evaluate(() => {
	// @ts-ignore bare let-global
	const g = (typeof KDGameData !== 'undefined' && KDGameData) || {};
	return { name: g.CurrentDialog || '', data: g.CurrentDialogMsgData || null };
});

test('KDM-303 — the host is gone past the grace: the guest hosts and plays on; the old host rejoins as a guest',
	async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		/*
		 * `hbIntervalMs: 0` — the heartbeat OFF, so "missing" can only mean a real socket close. Measured:
		 * under suite load a headless page can go 30 s without answering a ping, and with the grace cut
		 * to 4 s that stall would hand the seat away from the NEW host mid-spec (seen once as a
		 * `peer_missing` for B while it was the host). The product's 2-minute grace does not have this
		 * problem; the shortened one does.
		 */
		const { server, bridge, port } = await start(0, { hostGraceMs: GRACE, hbIntervalMs: 0 });
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const A = await ctxA.newPage();
		const B = await ctxB.newPage();
		const crashes: string[] = [];
		B.on('pageerror', (e: any) => crashes.push(`B: ${(e && e.message) || String(e)}`));
		try {
			await bootCoopPair(A, B, port);
			expect(await B.evaluate(() => (window as any).__coop.isHost()), 'control: B starts as the guest').toBe(false);
			const crashesBefore = crashes.length;

			// ---- the host's machine drops off the network ------------------------------------------
			// Close FIRST, while still online, so the close frame actually reaches the server (offline
			// emulation swallows it — measured: the server then never learns the host left). Offline
			// straight after, before the client's first reconnect attempt (backoff starts at 1 s).
			await killCoopSocket(A, { retry: true });
			await ctxA.setOffline(true);

			// R1 — the guest waits on a countdown the server runs.
			await B.waitForFunction((n) => {
				// @ts-ignore bare let-global
				const g = KDGameData; return g && g.CurrentDialog === n && g.CurrentDialogMsgData && /^\d+:\d\d$/.test(g.CurrentDialogMsgData.TIME || '');
			}, HOST_LOST_DIALOGUE, { timeout: 60_000 });

			// R3 — past the deadline, B is the host: on the server, on its own page, and told so.
			await B.waitForFunction((n) => {
				const c = (window as any).__coop;
				// @ts-ignore bare let-global
				return !!c && c.isHost() && KDGameData.CurrentDialog === n;
			}, NOW_HOST_DIALOGUE, { timeout: 60_000 });
			expect(bridge.gate.host).toBe('B');
			expect(bridge.session.players, "the old host's character left").toEqual(['B']);

			// …and the run goes on: one player, turns resolve.
			await answerCoopDialogue(B, NOW_HOST_DIALOGUE, 'Ok');
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((t) => (window as any).__coop.lastTick > (t as number), t0, { timeout: 60_000 });

			// ---- R5: the old host's machine comes back ------------------------------------------------
			await ctxA.setOffline(false);
			// Its tab reconnects claiming the host seat, is told to ask as a guest, and does — so the
			// NEW host is asked, in the game (KDM-297).
			await B.waitForFunction((n) => {
				// @ts-ignore bare let-global
				return KDGameData.CurrentDialog === n;
			}, JOIN_ASK_DIALOGUE, { timeout: 120_000 });
			expect((await dialog(B)).data, 'the old host is asked about by their id').toBeTruthy();
			await answerCoopDialogue(B, JOIN_ASK_DIALOGUE, 'Accept');
			await expect.poll(() => bridge.session.players, { timeout: 60_000 }).toEqual(['B', 'A']);
			expect(bridge.gate.host, 'the seat stays with the new host').toBe('B');
			expect(await A.evaluate(() => (window as any).__coop.isHost()), 'the old host is a guest now').toBe(false);

			const { real, ignored } = reportedPageErrors(crashes.slice(crashesBefore));
			// eslint-disable-next-line no-console
			if (ignored.length) console.log(`[KDM-303] ignored ${ignored.length} pre-existing asset error(s): ${ignored[0]}`);
			expect(real, 'handing the seat on must not trip KD\'s error handler').toEqual([]);
		} finally {
			await ctxA.close().catch(() => {});
			await ctxB.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
