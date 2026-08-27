/**
 * E2E (KDM-252) — the browser comes back on its own, and the survivor's modal goes away by itself.
 *
 * The node spec proves the SERVER re-seats a returning `clientId` into its own bundle. This proves
 * the two halves it cannot see:
 *   A6 — a real browser whose socket died re-establishes it with no reload and no click, so the
 *        player who dropped does not have to know what a WebSocket is;
 *   E4 — and the person who stayed has the "your host has gone" dialogue TAKEN AWAY from them,
 *        without touching a key. A modal about somebody who is already back is worse than no modal.
 *
 * ⚠️ THE RECONNECT COUNTER IS A LATCH, NOT A SAMPLE. `__coop.connected` returning to `true` is not
 * evidence of a retry — it is also what a socket that never really dropped looks like. So the client
 * keeps a cumulative `reconnect.total` that is never reset, and the assertion is on that.
 *
 * ONE BOOT. A co-op boot is two full game bundles plus a node host; the control (before the drop) and
 * every assertion after it share the one session.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, killCoopSocket, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HOST_LOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

/** What a page believes about the session and what it is showing the player. */
async function view(P: any) {
	return P.evaluate(() => {
		const c = (window as any).__coop || {};
		const el = document.getElementById('coop-overlay');
		return {
			connected: !!c.connected,
			peerMissing: c.peerMissing || null,
			blocked: c.blocked || null,
			reconnectTotal: (c.reconnect && c.reconnect.total) || 0,
			status: (el && el.textContent) || '',
			// @ts-ignore bare let-global
			dialogue: (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : '',
		};
	});
}

test('a dropped client reconnects by itself and the survivor\'s disconnect modal closes with no click',
	async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);

		const ctxA = await browser.newContext();   // A joins first → seat 0 → the HOST
		const ctxB = await browser.newContext();   // B → seat 1 → the guest, the survivor
		const A = await ctxA.newPage();
		const B = await ctxB.newPage();

		try {
			await bootCoopPair(A, B, port);

			// ---- control: nobody has dropped, and nobody has retried anything --------------------
			const before = await view(A);
			expect(before.connected).toBe(true);
			expect(before.reconnectTotal, 'the retry counter is a latch — it must start at zero').toBe(0);
			expect((await view(B)).dialogue, 'no disconnect modal while both are here')
				.not.toBe(HOST_LOST_DIALOGUE);

			// ---- the HOST's socket dies (a dropped Wi-Fi, a closed lid) ---------------------------
			// `retry: true` — this is the ONE spec that wants the client's own recovery to run.
			await killCoopSocket(A, { retry: true });

			// the survivor learns of it, in the game
			await B.waitForFunction(
				(name) => {
					const c = (window as any).__coop;
					// @ts-ignore bare let-global
					return !!(c && c.peerMissing) && typeof KDGameData !== 'undefined' && KDGameData
						&& KDGameData.CurrentDialog === name;
				},
				HOST_LOST_DIALOGUE, { timeout: 120_000 },
			);
			const paused = await view(B);
			expect(paused.peerMissing!.role, 'it was the host who went').toBe('host');

			// ---- A6: the browser retries ON ITS OWN — no reload, no click -------------------------
			//
			// Nothing below is driven by the test. The next `evaluate` on A is the ASSERTION, after
			// the page has already put itself back together.
			await A.waitForFunction(
				() => {
					const c = (window as any).__coop;
					return !!(c && c.connected && c.reconnect && c.reconnect.total > 0);
				},
				undefined, { timeout: 120_000 },
			);
			const resumed = await view(A);
			expect(resumed.reconnectTotal, 'it got back by RETRYING, which is the whole feature')
				.toBeGreaterThan(0);
			expect(resumed.connected).toBe(true);

			// ---- E4: the survivor's modal is taken away, without them touching anything ------------
			await B.waitForFunction(
				() => {
					const c = (window as any).__coop;
					// @ts-ignore bare let-global
					const d = (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : '';
					return !!c && !c.peerMissing && !d;
				},
				undefined, { timeout: 120_000 },
			);
			const back = await view(B);
			expect(back.dialogue, 'the modal is gone and the test never clicked it').toBe('');
			expect(back.peerMissing, 'and the page no longer believes anyone is away').toBeNull();
			expect(back.status, 'the player is told, rather than left to notice').toMatch(/back|resumed|reconnect/i);

			// ---- E4: and the game accepts turns again ---------------------------------------------
			const tickBefore = await B.evaluate(() => (window as any).__coop.lastTick);
			await B.evaluate(() => (window as any).__coop.sendMove(1, 0));
			await A.evaluate(() => (window as any).__coop.sendMove(-1, 0));
			await B.waitForFunction(
				(t) => {
					const c = (window as any).__coop;
					return !!c && c.lastTick != null && c.lastTick > (t as number);
				},
				tickBefore, { timeout: 120_000 },
			);
			expect((await view(B)).blocked, 'nothing is being refused any more').not.toBe('peer-missing');

			// ---- the identity a reconnect is recognised BY is stable across a fresh page ------------
			//
			// The `#coop=` path gets this for free (the id is in the URL); the lobby path generates
			// one, and a generated id that changed on every page load would make every reconnect look
			// like a stranger. Asserted at the mechanism, in the browser where the storage lives.
			const ids = await A.evaluate(() => {
				const c = (window as any).__coop;
				const first = c._stableId('guest');
				// what a RELOAD does: the module re-runs and asks again, with storage as it left it
				const second = c._stableId('guest');
				// KDM-280 — and asking for the OTHER seat must not mint a second identity. The
				// generator used to answer the literal `'host'` here, which is both a collision
				// between two tabs and a different id for the same tab depending on which button was
				// pressed. Kept beside the stability check because they are one property: this tab
				// has exactly one identity, whatever it asks for and however often.
				const asHost = c._stableId('host');
				return { first, second, asHost };
			});
			expect(ids.first, 'an identity is actually produced').toBeTruthy();
			expect(ids.second, 'and the same one is produced on the next page load').toBe(ids.first);
			expect(ids.asHost, 'and asking for the host seat does not change who you are').toBe(ids.first);
		} finally {
			await ctxA.close().catch(() => {});
			await ctxB.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
