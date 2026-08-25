/**
 * KDM-268 (browser) — an input whose dispatch THREW must reach the player's client, not just a
 * server-side list.
 *
 * The unit spec (`tests/unit/mp-failed-input.spec.ts`) proves the session records it and puts it in
 * the snapshot. That is only half the complaint: the whole point of the drop-report family is that a
 * player can tell "my input did nothing" from "my input was ignored", and the player is in a browser.
 * This is the same shape as `mp-input-no-silent-drop.spec.ts` does for `unknownInputs`, which is the
 * sibling this one was modelled on.
 *
 * ⚠️ THE THROW IS INJECTED SERVER-SIDE, and it has to be. A dispatch failure is by definition an
 * engine-side exception — there is no browser action that reliably produces one, and KDM-267 removed
 * the one real cause we knew about (KD's own autosave at the tail of `KinkyDungeonDefeat`). Injecting
 * it keeps the REPORTING path under test whatever produces the next exception.
 *
 * ⚠️ TIMING, exactly as the sibling spec documents: the failure is discovered when the turn RESOLVES,
 * which needs the peer to act. Asserting before that reads an empty report and says nothing.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const BOOM = 'kdm268 injected dispatch failure';

test('a dispatch that throws is reported to the browser, not swallowed', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// Healthy baseline: nothing is reported before anything has gone wrong. Without this, a client
		// that always answered with a non-empty list would pass the assertion below.
		const before = await A.evaluate(() => (window as any).KDRenderClient.failedInputs() || []);
		expect(before, 'a healthy session reports no failed inputs').toHaveLength(0);

		// Make the NEXT dispatch throw, once, inside the world. Fired from KinkyDungeonAdvanceTime,
		// which is where the game itself runs end-of-turn work — the same place a real engine
		// exception would surface from.
		bridge.session.world.eval(`(function(){
			var _prev = KinkyDungeonAdvanceTime;
			KinkyDungeonAdvanceTime = function () {
				var r = _prev.apply(this, arguments);
				if (globalThis.__kdm268Armed) {
					globalThis.__kdm268Armed = false;
					throw new Error(${JSON.stringify(BOOM)});
				}
				return r;
			};
			globalThis.__kdm268Armed = true;
		})()`);

		// Resolve a turn — only then has the world tried to dispatch anything.
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });

		// The server recorded it…
		const serverSide = bridge.session.failedInputReport();
		expect(serverSide.length, 'the server recorded the thrown dispatch').toBeGreaterThan(0);
		expect(String(serverSide[0].error)).toContain(BOOM);

		// …and the browser heard about it. This is the assertion the task exists for.
		await A.waitForFunction(
			(msg) => ((window as any).KDRenderClient.failedInputs() || [])
				.some((f: any) => String(f.error || '').indexOf(msg) >= 0),
			BOOM, { timeout: 30_000 },
		).catch(() => { throw new Error('the thrown dispatch was never reported to the client'); });

		// R6 — reporting only. The session kept going; a failure that is merely VISIBLE must not also
		// have become fatal.
		const t1 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t1, { timeout: 30_000 })
			.catch(() => { throw new Error('the session stopped taking turns after a reported failure'); });
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise((r) => server.close(r));
	}
});
