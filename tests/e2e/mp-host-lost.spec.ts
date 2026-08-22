/**
 * E2E (KDM-251) — the guest whose HOST vanished waits, knowingly.
 *
 * The node spec proves the server refuses the turn. This proves the only part it cannot: that the
 * refusal reaches a REAL browser as something the player can read and act on, rather than as a game
 * that has simply stopped responding.
 *
 * ⚠️ THE ROLES ARE NOT SYMMETRIC (KDM-234 D5/D7). A guest who loses the host gets no choice: the
 * host's process owns the world, so there is nothing to continue. What the guest must get instead is
 * (a) the plain truth about what is happening, and (b) input that is visibly REFUSED rather than
 * silently eaten — the distinction between "waiting for your friend" and "this game is broken".
 *
 * ONE BOOT. A co-op boot is two full game bundles plus a node host; the control and the assertion
 * share the session, read on the same page before and after.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HOST_LOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

/** What the guest's page believes, and what it is showing. */
async function guestView(P: any) {
	return P.evaluate(() => {
		const c = (window as any).__coop || {};
		const el = document.getElementById('coop-overlay');
		return {
			peerMissing: c.peerMissing || null,
			blocked: c.blocked || null,
			submitted: !!c.submitted,
			status: (el && el.textContent) || '',
			// @ts-ignore bare let-global
			dialogue: (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : '',
		};
	});
}

test('a guest whose host disconnects is told they are waiting, and their moves are refused out loud',
	async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);

		const ctxA = await browser.newContext();   // A joins first → seat 0 → the HOST
		const ctxB = await browser.newContext();   // B → seat 1 → the guest
		const A = await ctxA.newPage();
		const B = await ctxB.newPage();

		try {
			await bootCoopPair(A, B, port);

			// ---- control: while both are here, nothing is paused and nothing is refused -----------
			const before = await guestView(B);
			expect(before.peerMissing, 'nobody has left yet').toBeNull();
			expect(before.status, 'and the overlay is not talking about a disconnect')
				.not.toMatch(/disconnect|paused/i);

			// ---- the HOST's connection dies --------------------------------------------------------
			await A.evaluate(() => { (window as any).__coop.ws.close(); });

			await B.waitForFunction(
				() => !!((window as any).__coop && (window as any).__coop.peerMissing),
				undefined, { timeout: 60_000 },
			);

			// ---- E3/D6: the guest knows WHO went and that they are waiting on them ------------------
			const lost = await guestView(B);
			expect(lost.peerMissing!.role, 'it was the host who left').toBe('host');
			expect(lost.status, 'said plainly, not left to be guessed at').toMatch(/host/i);
			expect(lost.status).toMatch(/waiting|paused/i);

			// ---- S3: told IN THE GAME, not only in a corner overlay ---------------------------------
			await B.waitForFunction(
				(name) => {
					// @ts-ignore bare let-global
					return typeof KDGameData !== 'undefined' && KDGameData && KDGameData.CurrentDialog === name;
				},
				HOST_LOST_DIALOGUE, { timeout: 60_000 },
			);

			// ---- S5/D7: exactly one way out, and it is not "continue" -------------------------------
			const options = await B.evaluate((name) => {
				// @ts-ignore bare let-global
				const d = (KDDialogue as any)[name];
				return d && d.options ? Object.keys(d.options) : null;
			}, HOST_LOST_DIALOGUE);
			expect(options, 'the guest is offered quit and nothing else').toEqual(['Quit']);

			// ---- S2/N1: a real move is REFUSED, and does not look accepted --------------------------
			//
			// The `submitted` half is the point. KDM-225 shipped a client that set `submitted = true`
			// on a `waiting` reply and then suppressed every later input as already-acted; a player
			// whose move entered a barrier that will never close was locked out of their own controls.
			// A refusal must leave them able to keep trying.
			await B.evaluate(() => (window as any).__coop.sendMove(1, 0));
			await B.waitForFunction(
				() => (window as any).__coop && (window as any).__coop.blocked === 'peer-missing',
				undefined, { timeout: 60_000 },
			);
			const refused = await guestView(B);
			expect(refused.blocked, 'the refusal names its cause').toBe('peer-missing');
			expect(refused.submitted, 'and the client must NOT believe it has acted').toBe(false);
			expect(refused.status, 'the player is told why, every time').toMatch(/paused|waiting/i);
		} finally {
			await ctxA.close().catch(() => {});
			await ctxB.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
