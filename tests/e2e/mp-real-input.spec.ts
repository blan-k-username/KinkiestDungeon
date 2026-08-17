/**
 * E2E — REAL user input through the co-op proxy (KDM-186).
 *
 * ⚠️ THE COVERAGE HOLE THIS FILLS. Every other MP e2e drives the session through the test hooks
 * `__coop.sendMove()` / `__coop.sendAction()`, which BUILD a `{kdType,data}` action and hand it
 * straight to `submit()`. That skips the entire real input path:
 *
 *     real key/click → KD's own handler → KDSendInput(type, data) → routed wrapper → submit()
 *
 * So the suite can be fully green while a human cannot move at all — which is what the first
 * hands-on UAT reported (2026-08-16: "I cannot move any char or do any action", keyboard AND mouse).
 *
 * Asserts the PLAYER-VISIBLE outcome (the character moved / the shared turn advanced), never an
 * internal counter — an input that is accepted, routed, classified and then changes nothing is
 * precisely the failure being hunted.
 *
 * HARNESS RULES learned the hard way (first version timed out at 600 s and proved nothing):
 *  - use `page.mouse` / `page.keyboard` directly, NEVER `locator.click()`. KD renders into a canvas
 *    that Playwright's actionability checks can wait on forever; a hang there is a harness bug that
 *    masquerades as a product red.
 *  - every wait has a SHORT explicit timeout and is followed by a diagnostic dump, so a red says
 *    which stage died instead of "test timeout exceeded".
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const ACT_TIMEOUT = 20_000;

/** Authoritative position of this client's character (not where it happens to be drawn). */
async function pos(P: Page) {
	// @ts-ignore bare let-global
	return P.evaluate(() => ({ x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y }));
}

/** Both halves of the picture: client rollups + what the client believes about the session. */
async function diagOf(P: Page) {
	return P.evaluate(() => {
		const w = window as any;
		const d = w.__coopDiag ? JSON.parse(w.__coopDiag.dump()) : null;
		return {
			tick: w.__coop && w.__coop.lastTick, submitted: w.__coop && w.__coop.submitted,
			inFlight: w.__coop && w.__coop._sentRoute.length,
			rollups: d ? d.rollups.slice(-3) : null, recentInputs: d ? d.recentInputs.slice(-10) : null,
		};
	});
}

test('a real keypress moves the character (the human input path, not the test hook)', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errs: string[] = [];
	A.on('pageerror', (e) => errs.push('A: ' + e.message));
	B.on('pageerror', (e) => errs.push('B: ' + e.message));

	try {
		await bootCoopPair(A, B, port);
		const before = await pos(A);
		const tick0 = await A.evaluate(() => (window as any).__coop.lastTick);

		// Click into the page to focus it (raw mouse — no actionability wait), then press a REAL key.
		// Lockstep: BOTH must act, so B waits with the real wait key rather than a test hook.
		await A.mouse.click(200, 200);
		// HELD, not pressed: this harness renders at ~4 fps and KD samples transient key state per
		// frame, so a normal keydown+keyup lands entirely between polls. Holding it spans several
		// frames at any frame rate — the real browser (85 fps) does not need this.
		await A.keyboard.down('ArrowRight');
		await A.waitForTimeout(1500);
		await A.keyboard.up('ArrowRight');
		await B.mouse.click(200, 200);
		await B.keyboard.press('Space');

		const advanced = await A.waitForFunction(
			(t) => (window as any).__coop.lastTick !== t, tick0, { timeout: ACT_TIMEOUT },
		).then(() => true).catch(() => false);

		const after = await pos(A);
		const moved = after.x !== before.x || after.y !== before.y;

		expect(moved || advanced,
			'a real ArrowRight keypress changed NOTHING — neither the character nor the shared turn.\n' +
			`before=${JSON.stringify(before)} after=${JSON.stringify(after)} tick0=${tick0} advanced=${advanced}\n` +
			`A=${JSON.stringify(await diagOf(A))}\nB=${JSON.stringify(await diagOf(B))}\n` +
			`pageerrors=${JSON.stringify(errs.slice(0, 5))}`).toBe(true);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * THE REGRESSION GUARD (KDM-186) — per-frame input must not produce per-frame full state.
 *
 * This is the assertion that would have caught the UAT failure before a human ever saw it. It does
 * NOT depend on the frame rate, so unlike the keypress test above it is meaningful in a headless
 * harness that runs at 4 fps.
 *
 * What broke: the bridge answered EVERY input with a full ~40 KB snapshot. KD's draw loop emits an
 * input every frame, so two clients generated ~8 MB/s, the server saturated, replies stopped and the
 * shared turn never advanced — the players could do nothing at all.
 *
 * The invariant is stated in bytes, not in input names: idle play (mouse chatter only, no game state
 * changing) must cost approximately NOTHING on the wire. Any future change that reintroduces
 * state-per-input fails here regardless of which input type carries it.
 */
test('idle per-frame input costs no state traffic', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// Drive the game's own per-frame input directly, many times — the same call KD's draw loop
		// makes from the mouse position. No game state changes, so no state needs to cross the wire.
		await A.evaluate(async () => {
			const w = window as any;
			for (let i = 0; i < 200; i++) {
				w.__coop.sendAction({ kdType: 'setMoveDirection', data: { dir: { x: 1, y: 0 }, delta: 1 } });
				await new Promise((r) => setTimeout(r, 5));
			}
		});
		await A.waitForTimeout(1500);   // let any replies land

		const traffic = await A.evaluate(() => {
			const d = JSON.parse((window as any).__coopDiag.dump());
			const recent = d.rollups.slice(-4);
			return {
				kb: recent.reduce((s: number, r: any) => s + r.kbPerS, 0),
				uiReplies: recent.reduce((s: number, r: any) => s + r.recv.ui, 0),
				skipped: recent.reduce((s: number, r: any) => s + Object.values(r.skips || {})
					.reduce((a: number, b: any) => a + b, 0), 0),
			};
		});

		// A handful of KB is fine (the first send of a new payload legitimately returns state once).
		// Hundreds of KB means state-per-input is back.
		expect(traffic.kb, `idle per-frame input cost ${traffic.kb} KB of state traffic — ` +
			`state-per-input has regressed. ${JSON.stringify(traffic)}`).toBeLessThan(100);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
