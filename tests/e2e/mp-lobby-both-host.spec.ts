/**
 * E2E (KDM-270) — two people on one LAN both press **Host**.
 *
 * The second one is refused `already_hosting`, which does not mean "go away" — it means the OTHER
 * seat is free. Before this, `_reject` closed their socket: the lobby printed an error and the
 * player had to back out to the root and re-enter the Join view to do the thing the server had
 * already told them they could do.
 *
 * `mp-reject-retry.spec.ts` proves the rule at the socket, in milliseconds — that `retry` names a
 * seat and the socket survives. This proves the two halves are wired to each other at all: refusal →
 * the lobby's own view switch → the Join button → a join frame on the SAME socket → the host's
 * prompt. None of that is visible from the node layer, because the bootstrap's `reject` handler is
 * only unit-tested by reading its source.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 * "B ends up on the join view" would pass against a lobby that simply started there. So the view is
 * asserted to be `host` FIRST — B really did ask to host — and only then to become `join`. And the
 * socket is STAMPED before the second ask and the stamp read after it: a reconnect would satisfy
 * every other assertion in this file while quietly keeping the old behaviour, and the stamp is the
 * only thing that can tell the two apart from outside.
 *
 * WHY IT USES THE DEMO SERVER: the client scripts are injected at serve time (`demo-server.js`
 * `INJECT`), so on the plain static server there is no Multiplayer entry to press.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Is the page's co-op socket open, and is it still the one we stamped? */
const socketState = (page: any) => page.evaluate(() => ({
	ready: window.__coop && window.__coop.ws ? window.__coop.ws.readyState : -1,
	mark: window.__coop && window.__coop.ws ? (window.__coop.ws as any).__kdm270 : undefined,
	closedForGood: !!(window.__coop && window.__coop._closedForGood),
}));

test.describe('KDM-270 — the second Host press', () => {
	test('lands on the join view and joins on the SAME socket (R6)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const A = await ctxA.newPage();
		const B = await ctxB.newPage();
		try {
			await openLobby(A, port);
			await press(A, 'KDMPHost');
			expect((await lobbyState(A)).view).toBe('host');

			/*
			 * KDM-280 — B used to be handed a client id here, because `stableId` minted the literal
			 * `'host'` for everyone and the two tabs collided before they could ever reach the
			 * refusal this spec is about. That seeding is gone, which is the regression test: if the
			 * id generator ever goes back to naming a seat, this spec fails at the poll below rather
			 * than passing on a workaround.
			 */
			await openLobby(B, port);
			await press(B, 'KDMPHost');

			/*
			 * KDM-280 R1 — the two tabs really did mint DIFFERENT ids.
			 *
			 * Asserted here rather than in a spec of its own because this is the only place two real
			 * browser contexts, each with its own `sessionStorage`, ask for the same seat — which is
			 * the exact condition the bug needed. Read from the pages, not from the server: the
			 * generator is what regressed, and the server would happily report one id for both.
			 */
			const idA = await A.evaluate(() => (window as any).__coop.id);
			const idB = await B.evaluate(() => (window as any).__coop.id);
			expect(idA, 'both tabs have an identity').toBeTruthy();
			expect(idB).toBeTruthy();
			expect(idB, 'two tabs are two players — README, and the invariant KDM-280 restored')
				.not.toBe(idA);

			// ── the refusal moves it, and does not hang up ──────────────────────────────────
			await expect.poll(async () => (await lobbyState(B)).view,
				{ message: 'the refusal takes B to the join view', timeout: 15_000 }).toBe('join');
			/*
			 * It got there BY BEING REFUSED — the assertion that stops this being "the lobby was
			 * already on the join view". Deliberately the error text and not a view transition read
			 * right after the press: the refusal is a round trip to a server on the same machine and
			 * lands well inside one frame, so `view === 'host'` is a race that fails on a fast host
			 * exactly when the feature is working.
			 */
			expect((await lobbyState(B)).error, 'and it was told why it moved')
				.toContain('already hosting');
			const refused = await socketState(B);
			expect(refused.ready, 'the socket survived the refusal').toBe(1);
			expect(refused.closedForGood, 'and the client did not write it off').toBe(false);

			// Stamp it: everything after this must happen on THIS socket.
			await B.evaluate(() => { (window.__coop.ws as any).__kdm270 = 'same-socket'; });

			// ── and the ordinary join runs from there ───────────────────────────────────────
			await B.locator('#KDMPName').fill('Ada');
			await press(B, 'KDMPConnect');

			await expect.poll(async () => (await lobbyState(A)).pending?.name,
				{ message: 'the host is asked, by name', timeout: 15_000 }).toBe('Ada');

			const asked = await socketState(B);
			expect(asked.mark, 'the ask travelled on the socket the refusal left open').toBe('same-socket');
			expect(asked.ready).toBe(1);

			await press(A, 'KDMPAccept');
			await expect.poll(() => bridge.gate.guest,
				{ message: 'and the host answering is what seats B', timeout: 15_000 }).toBeTruthy();

			const seated = await socketState(B);
			expect(seated.mark, 'still the same socket once seated — no reconnect anywhere').toBe('same-socket');
		} finally {
			await ctxA.close();
			await ctxB.close();
			await new Promise((r) => server.close(r));
		}
	});
});
