/**
 * E2E — WHY does real input not reach the proxy? A discriminating matrix (KDM-186).
 *
 * The first oracle (`mp-real-input.spec.ts`) established the FACT: a real ArrowRight produces no
 * input at all (`sends` contains only `setMoveDirection`, `recentInputs` empty) while the client
 * runs at 2-4 fps. This spec separates the candidate causes in ONE run, because each needs the same
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
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

async function pos(P: Page) {
	// @ts-ignore bare let-global
	return P.evaluate(() => ({ x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y }));
}
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

		// ── CONTROL: the synthetic path every other spec uses ───────────────────────────────────
		const p0 = await pos(A);
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendMove(1, 0));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		out.controlAdvanced = await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout: 20_000 })
			.then(() => true).catch(() => false);
		out.controlMoved = JSON.stringify(await pos(A)) !== JSON.stringify(p0);

		// ── HOLD: keep the key down across several frames ───────────────────────────────────────
		const p1 = await pos(A);
		const t1 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.mouse.click(200, 200);
		await A.keyboard.down('ArrowRight');
		await A.waitForTimeout(2000);                 // several frames even at 3 fps
		await A.keyboard.up('ArrowRight');
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		out.holdAdvanced = await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t1, { timeout: 20_000 })
			.then(() => true).catch(() => false);
		out.holdMoved = JSON.stringify(await pos(A)) !== JSON.stringify(p1);
		out.holdSends = await sendsOf(A);

		// Not a pass/fail — surface the matrix.
		expect(out.controlMoved && out.holdMoved, 'INPUT MATRIX ' + JSON.stringify(out, null, 1)).toBe(true);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
