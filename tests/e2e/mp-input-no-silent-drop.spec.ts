/**
 * KDM-163 AC1 + AC3 + AC5 (browser) — the client routes EVERYTHING, and an input the authoritative
 * world cannot dispatch is REPORTED rather than silently dropped.
 *
 * `render-client.js` used to classify with two hardcoded lists and end with a bare `return ''` for
 * anything on neither: no effect, no error, no log. Measured cost — the game's own registry
 * `KDInputTypes` has 85 types and the lists knew 81, so `defeat`, `lose`, `lock` and
 * `setrestraintpalette` did nothing at all, undiscoverably.
 *
 * Both lists are now GONE (AC1). That moves the whole question: the client can no longer fail to route
 * anything, so the only place an input can go unhandled is the authoritative world — and the server
 * reports that in `snapshot.unknownInputs`, which `KDRenderClient.unhandledInputs()` surfaces.
 *
 * ⚠️ TIMING is a real property of this design, not a test quirk. An input the world has no handler for
 * is by definition unseeded, so it takes the SAFE default and goes through lockstep. Whether it could
 * be dispatched is therefore discovered when the turn RESOLVES — which needs the peer to act. Asserting
 * before that reads an empty report and says nothing.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('AC3: an input the world cannot dispatch is reported, not silently swallowed', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// AC5: the client must never advance its own turn, whatever happens to an input.
		const adv = await A.evaluate(() => {
			// @ts-ignore bare let-global
			const before = KinkyDungeonCurrentTick;
			// @ts-ignore
			KinkyDungeonAdvanceTime(1);
			// @ts-ignore
			return { before, after: KinkyDungeonCurrentTick };
		});
		expect(adv.after, 'no local turn advance is possible').toBe(adv.before);

		// AC1: nothing is classified client-side any more — the lists are gone, so there is no
		// "on neither list" branch left to swallow anything.
		const routed = await A.evaluate(() => {
			const w = window as any;
			const sent: any[] = [];
			const realSend = w.KDRenderClient.sendInput.bind(w.KDRenderClient);
			w.KDRenderClient.sendInput = (a: any) => { sent.push(a); return realSend(a); };
			// @ts-ignore bare let-global — a type NOBODY has a handler for
			KDSendInput('__kdm163_not_a_real_type', {});
			w.KDRenderClient.sendInput = realSend;
			return sent.map((a) => a.kdType);
		});
		expect(routed, 'an unknown type is ROUTED, not dropped on the client')
			.toContain('__kdm163_not_a_real_type');

		// Resolve the turn it entered — only then has the world tried to dispatch it.
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });

		// AC3: the server reports it, and the browser can see the report.
		await A.waitForFunction(
			() => ((window as any).KDRenderClient.unhandledInputs() || [])
				.some((e: any) => e.type === '__kdm163_not_a_real_type'),
			undefined, { timeout: 30_000 },
		).catch(() => { throw new Error('the undispatchable input was never reported to the client'); });

		// …and the server's own report agrees (same fact, read from the authority).
		expect(bridge.session.unknownInputReport().map((r: any) => r.type))
			.toContain('__kdm163_not_a_real_type');

		// A type the world DOES have is never reported — otherwise the report is noise, not a to-do.
		const report = await A.evaluate(() => (window as any).KDRenderClient.unhandledInputs() || []);
		expect(report.map((e: any) => e.type), 'a real input type must not appear as unhandled')
			.not.toContain('move');
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise((r) => server.close(r));
	}
});
