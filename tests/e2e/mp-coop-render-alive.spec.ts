/**
 * E2E (KDM-258) — a co-op session must actually RENDER, whichever way it was started.
 *
 * ── THE BUG THIS PINS ─────────────────────────────────────────────────────────────────────────────
 * `pinGameScreen()` sets `KinkyDungeonState = 'Game'`, and three `state` message handlers call it
 * unconditionally. But `KinkyDungeonContext` — the 2D context every map draw writes to — is `null`
 * until `KDInitCanvas()` runs, and that is reached only through
 * `KinkyDungeonStartNewGame` -> `KinkyDungeonInitialize` (`KinkyDungeonGame.ts:95, :568, :577`).
 *
 * On the LEGACY `#coop=` path that ordering is safe: `boot()` runs `enterGame()` and only then
 * `connect()`, so the game is initialised before a state frame can arrive. On the LOBBY path the
 * socket is opened first (from the Host/Join button) and `enterGame()` runs later, on
 * `joined.started` — and it defers on assets and on mod execution via `setTimeout`. In that window a
 * state frame arrives, pins the screen to `'Game'`, and the next frame runs
 * `KinkyDungeonContext.fillStyle = …` (`KinkyDungeonDraw.ts:1230`) against null.
 *
 * That throw escapes `DrawProcess` into the PIXI ticker (`Scripts/Drawing.ts:197-205`,
 * `Scripts/Main.ts:93-97`) and the render loop STOPS. The player is left looking at one frozen frame,
 * for the rest of the session. The draw's own guard is `if (KinkyDungeonCanvas)`, and that is a
 * `document.createElement("canvas")` at module scope (`:94`) — always truthy, so it protects nothing.
 *
 * ── WHY IT WENT UNNOTICED ─────────────────────────────────────────────────────────────────────────
 * Every MP e2e asserts on STATE, never on rendering. KDM-249's acceptance test drives this exact
 * lobby flow and passes green while the screen is frozen.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. The LEGACY path is run as a control, with the identical assertions. It passes before the fix
 *     and after it, so a green here cannot come from an oracle that never fires.
 *  2. Liveness is measured, not inferred: a probe is written onto `KDButtonsCache`, which the game
 *     wipes and REPLACES at the top of every frame (`KinkyDungeon.ts:1670-1671`). If the probe
 *     survives, no frame ran. That is a direct observation of the thing the player loses.
 *  3. The invariant is asserted as well as the symptom, so a fix that merely silences the error
 *     without restoring frames still fails.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair } from './helpers/coop';
import { press, openLobby, lobbyState, guestAsks } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Did KD run a frame in the last ~10 rAF? The cache is replaced per frame, so a survivor means no. */
async function loopAlive(P: any): Promise<boolean> {
	return P.evaluate(() => new Promise<boolean>((resolve) => {
		// Mutating a PROPERTY of the object is scope-safe — unlike rebinding the name, which from an
		// evaluate would only touch the global binding and never the bundle's own.
		// @ts-ignore — bundle `let` global, readable by bare name.
		KDButtonsCache.__kdm258 = 1;
		let n = 0;
		const tick = () => {
			// @ts-ignore
			if (!KDButtonsCache.__kdm258) return resolve(true);       // cache replaced ⇒ a frame ran
			if (++n > 30) return resolve(false);
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}));
}

/** The invariant: a page showing the Game screen must have a context to draw it with. */
const drawable = (P: any) => P.evaluate(() => ({
	// @ts-ignore
	state: KinkyDungeonState,
	// @ts-ignore
	contextReady: typeof KinkyDungeonContext !== 'undefined' && KinkyDungeonContext !== null,
	startError: (window as any).__coop ? (window as any).__coop._startError : '',
}));

const FILL = /fillStyle/;

test.describe('KDM-258 — a co-op session renders, however it was started', () => {
	test('CONTROL: the legacy #coop= path renders and keeps rendering', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const cA = await browser.newContext(); const cB = await browser.newContext();
		const A = await cA.newPage(); const B = await cB.newPage();
		const errA: string[] = []; A.on('pageerror', (e) => errA.push(String(e.message || e)));
		try {
			await bootCoopPair(A, B, port);
			const d = await drawable(A);
			expect(d.state, 'the control has to actually reach the game, or it controls nothing').toBe('Game');
			expect(d.contextReady, 'legacy path: the game was initialised before the screen was pinned').toBe(true);
			expect(errA.filter((e) => FILL.test(e)), 'no null-context draw on the legacy path').toEqual([]);
			expect(await loopAlive(A), 'and the render loop is still running').toBe(true);
		} finally {
			await cA.close().catch(() => {}); await cB.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('a session started through the Multiplayer LOBBY renders too', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const cH = await browser.newContext(); const cG = await browser.newContext();
		const H = await cH.newPage(); const G = await cG.newPage();
		const errH: string[] = []; H.on('pageerror', (e) => errH.push(String(e.message || e)));
		const errG: string[] = []; G.on('pageerror', (e) => errG.push(String(e.message || e)));
		try {
			await openLobby(H, port, '127.0.0.1', { preload: true });
			await press(H, 'KDMPHost');
			await guestAsks(G, port, 'Ada', undefined, { preload: true });
			await expect.poll(async () => (await lobbyState(H)).pending?.name,
				{ timeout: 60_000, message: 'the host should be prompted' }).toBe('Ada');
			await press(H, 'KDMPAccept');
			await expect.poll(() => bridge.session.players.length,
				{ timeout: 120_000, message: 'both players seated' }).toBe(2);
			await G.waitForFunction(() => KinkyDungeonState === 'Game', undefined,
				{ timeout: 120_000, polling: 'raf' });
			await H.waitForFunction(() => KinkyDungeonState === 'Game', undefined,
				{ timeout: 120_000, polling: 'raf' });

			// THE HOST IS THE ONE THAT BREAKS — it opens its socket from the Host button, long before
			// `enterGame()` — but both are asserted, because a fix that only reorders the guest's path
			// would otherwise look complete.
			for (const [who, P, errs] of [['host', H, errH], ['guest', G, errG]] as const) {
				const d = await drawable(P);
				expect(d.startError, `${who}: KinkyDungeonStartNewGame must not have failed`).toBe('');
				expect(d.contextReady, `${who}: on the Game screen with no context to draw it`).toBe(true);
				expect(errs.filter((e) => FILL.test(e)), `${who}: null-context draw`).toEqual([]);
				expect(await loopAlive(P), `${who}: the render loop died — the screen is frozen`).toBe(true);
			}
		} finally {
			await cH.close().catch(() => {}); await cG.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
