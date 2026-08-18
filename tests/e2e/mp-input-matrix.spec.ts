/**
 * E2E — WHY does real input not reach the proxy? A discriminating matrix (KDM-186).
 *
 * ⚠️ KDM-204 — READ THIS BEFORE TRUSTING AN OLDER READING FROM THIS FILE.
 * The premise below used to be: "`mp-real-input.spec.ts` established the FACT that a real ArrowRight
 * produces no input at all". That was not a fact about the transport. KD binds movement to a
 * roguelike layout via `KinkyDungeonKeybindings` (`Game/src/base/KinkyDungeon.ts:162`) and the string
 * "ArrowRight" appears NOWHERE in the game source — the arrows are simply not bound, so the keypress
 * had nothing to reach. Every arm now presses the key the LIVE binding table names, and moves in a
 * direction that is provably open, because a blocked move still resolves a turn without changing
 * position. Both confounds used to report "input lost" for inputs the server handled perfectly.
 *
 * This spec separates the remaining candidate causes in ONE run, because each needs the same
 * expensive two-window boot:
 *
 *   CONTROL   synthetic `KDSendInput('move')` → proves routing + lockstep still work end-to-end.
 *   HOLD      keydown, wait ~2 s (several frames at even 3 fps), keyup → if THIS moves the character
 *             but a normal press does not, the loss is a FRAME-POLL MISS: KD samples transient key
 *             state per frame and the frame rate is too low to catch a normal press.
 *   FPS       measure frames/s with per-frame `setMoveDirection` routing ON, then with it suppressed
 *             (`__coopDiag.suppressHover(true)`) → if fps recovers, the per-frame round-trip is what
 *             starves the loop; if it does not, the starvation is elsewhere and the chatter is a
 *             passenger, not the driver.
 *
 * Reports the whole matrix in one assertion message — the point is the comparison, not a pass/fail.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootCoopPair, coopRealKeyMove, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Frames per second, measured over `ms` by counting real rAF callbacks. */
async function fps(P: Page, ms: number) {
	return P.evaluate((d) => new Promise<number>((res) => {
		let n = 0; const t0 = performance.now();
		(function f() { n++; if (performance.now() - t0 < d) requestAnimationFrame(f); else res(Math.round(n / (d / 1000))); })();
	}), ms);
}
async function sendsOf(P: Page) {
	return P.evaluate(() => {
		const w = window as any;
		const r = w.__coopDiag ? JSON.parse(w.__coopDiag.dump()).rollups.slice(-2) : [];
		return r.map((x: any) => ({ frames: x.frames, sends: x.sends, ui: x.recv.ui, kb: x.kbPerS, applyAvg: x.applyAvg }));
	});
}

test('WHY real input is lost: control vs hold vs frame rate', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const out: any = {};

	try {
		await bootCoopPair(A, B, port);

		// ── FPS, chatter ON then OFF ────────────────────────────────────────────────────────────
		out.fpsWithChatter = await fps(A, 3000);
		out.sendsWithChatter = await sendsOf(A);
		await A.evaluate(() => (window as any).__coopDiag.suppressHover(true));
		await B.evaluate(() => (window as any).__coopDiag.suppressHover(true));
		out.fpsNoChatter = await fps(A, 3000);
		out.sendsNoChatter = await sendsOf(A);

		// ── CONTROL + HOLD ──────────────────────────────────────────────────────────────────────
		// Both legs come from `coopRealKeyMove` (KDM-211), which owns the two corrections this arm used
		// to carry inline — read the key from the live binding table rather than pressing an arrow KD
		// never binds, and aim at a tile the control leg has just proved is open. `mp-real-input`
		// asserts on the same primitive; keeping a second copy here is how the two would drift.
		const real = await coopRealKeyMove(A, B, { timeout: 20_000 });
		out.controlAdvanced = real.control.advanced;
		out.controlMoved = real.control.moved;
		out.controlDir = real.control.dir;
		out.holdDir = real.dir;
		out.holdKey = real.key;
		out.holdAdvanced = real.advanced;
		out.holdMoved = real.moved;
		out.holdSends = await sendsOf(A);

		// KDM-204: the matrix is the POINT of this spec, and an assertion message is printed only when
		// the assertion FAILS — so a green run used to throw the reading away. Emit it unconditionally
		// (and attach it, so it survives in the HTML report) before asserting.
		console.log('INPUT MATRIX ' + JSON.stringify(out, null, 1));
		await test.info().attach('input-matrix.json', { body: JSON.stringify(out, null, 1), contentType: 'application/json' });

		// The pass/fail half is narrower than the matrix: these two are real behavioural coverage of
		// the human input path. The fps columns are measurement and are reported, never gated.
		expect(out.controlMoved && out.holdMoved, 'INPUT MATRIX ' + JSON.stringify(out, null, 1)).toBe(true);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
