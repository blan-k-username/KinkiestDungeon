/**
 * E2E (Playwright/Chromium): KD-071 browser thin-client over a real WebSocket.
 *
 * Proves the full browser↔server seam: a REAL browser connects to the local
 * WSBridge (KD-071) as player A, renders the render-state snapshots the server
 * pushes (via KDRenderClient.apply — no local simulation), and its input
 * round-trips to advance the shared world. A node-side WebSocket plays player B so
 * the 2-player session starts and the turn barrier can complete.
 *
 * Together with the spike (renderer driven from a snapshot) and the node bridge
 * test (server delivers snapshots + lockstep over WS), this closes the MVP loop:
 * a browser plays a shared, server-authoritative dungeon over a WebSocket.
 *
 * KDM-216 — uses `isolatedPage`, NOT `kdPage`. This spec injects render-client.js and
 * calls disableLocalSim(), which installs permanent __kdClientGuard wrappers that make
 * KinkyDungeonAdvanceTime a no-op. resetKDState() cannot undo a monkey-patch, so on the
 * worker-scoped shared page every later spec — all four integration specs included —
 * inherited a game that could not advance a turn. Its own context, its own mess.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { installRenderSurfaceReader, readRenderSurface, PAINTED_MIN_COLORS } from './helpers/render-surface';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_DELTA_BROWSER } = require('../../tools/mp-server/kd-delta');

test('a browser thin-client renders server snapshots and rounds input over a WebSocket', async ({ isolatedPage }) => {
	await installRenderSurfaceReader(isolatedPage);   // KDM-217: before the bundle brings PIXI up
	await bootKD(isolatedPage);
	const bridge = new WSBridge({ requiredPlayers: 2, seed: 'ws-e2e-seed' });
	const port = await bridge.listen(0);

	try {
		// Inject the production thin-client core and bootstrap render structures.
		await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });
		// KDM-206: this spec builds its own thin client on the STOCK game page, not the demo-server,
		// so nothing has injected the delta merge for it. Same source text the server diffs with.
		await isolatedPage.addScriptTag({ content: KD_DELTA_BROWSER });
		await isolatedPage.evaluate(() => {
			// @ts-ignore — bring up PIXI + KD render globals (KDMapData etc.); the
			// thin client renders server snapshots, never simulates.
			KinkyDungeonStartNewGame(false);
			// @ts-ignore
			KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
			// @ts-ignore
			(window as any).KDRenderClient.disableLocalSim();
		});

		// Browser opens a WebSocket to the bridge as player A; store pushed states.
		await isolatedPage.evaluate((url) => {
			const w = window as any;
			w.__states = [];
			const ws = new WebSocket(url);
			w.__ws = ws;
			// KDM-206: the bridge sends a full `snapshot` first and a `delta` thereafter, so this
			// hand-rolled client merges like the real one — with the served `window.KDDelta.kdMerge`,
			// the SAME code the server diffs with, never a second implementation.
			w.__base = null;
			ws.onmessage = (e: MessageEvent) => {
				const m = JSON.parse(e.data);
				// KDM-255: as the host, this client is the gate — the guest below waits on this answer.
				if (m.type === 'joined') w.__seated = true;
				if (m.type === 'join_pending') ws.send(JSON.stringify({ type: 'join_answer', accept: true }));
				if (m.type === 'state') {
					if (m.snapshot) w.__base = m.snapshot;
					else if (m.delta && w.__base) w.__base = w.KDDelta.kdMerge(w.__base, m.delta);
					if (!w.__base) return;
					w.KDRenderClient.apply(w.__base);          // render-only adopt
					w.__states.push({ tick: m.tick, grid: w.__base.map.Grid });
				}
			};
			// KDM-255 — the join gate is the only road in. This client is the HOST, so it claims slot 0
			// and answers the node-side guest's request below.
			ws.onopen = () => ws.send(JSON.stringify({ type: 'join', clientId: 'A', role: 'host' }));
		}, `ws://127.0.0.1:${port}`);

		/*
		 * KDM-255 — WAIT FOR THE HOST TO BE SEATED BEFORE THE GUEST ASKS.
		 *
		 * `page.evaluate` above returns once `onopen` is ASSIGNED, not once the socket has opened and
		 * joined, so the two joins used to race. That was harmless while a roleless join simply seated
		 * whoever arrived; through the gate it is not — a guest that asks before anyone holds slot 0 is
		 * refused `no_host` and its socket is closed, and the session never starts. Ordering is a real
		 * requirement of the flow now (the same one `helpers/coop.ts` has always observed), so it is
		 * awaited rather than hoped for.
		 */
		await isolatedPage.waitForFunction(() => (window as any).__seated === true, undefined, { timeout: 20_000 });

		// Node-side player B joins so the shared world starts.
		// eslint-disable-next-line no-undef
		const B = new WebSocket(`ws://127.0.0.1:${port}`);
		const bMsgs: any[] = [];
		B.addEventListener('message', (e: any) => bMsgs.push(JSON.parse(e.data)));
		await new Promise<void>((res) => B.addEventListener('open', () => res()));
		B.send(JSON.stringify({ type: 'join', clientId: 'B', role: 'guest' }));

		// The browser should receive its first render-state and adopt it.
		await isolatedPage.waitForFunction(() => (window as any).__states.length >= 1, undefined, { timeout: 20_000 });
		const first = await isolatedPage.evaluate(() => {
			const w = window as any;
			return {
				stateTick: w.__states[0].tick,
				stateGrid: w.__states[0].grid,
				// @ts-ignore — the render globals now reflect the server snapshot
				liveGrid: KDMapData.Grid,
				// render-only flag lives on KDRenderClient now (KD-085 reverted the
				// KDServerRole game-source flag; the client is pure monkey-patch).
				clientMode: (window as any).KDRenderClient.isLocalSimDisabled(),
			};
		});
		// the browser's live render globals match the snapshot the server pushed
		expect(first.liveGrid).toBe(first.stateGrid);
		expect(first.clientMode).toBe(true);

		// The renderer paints a real frame of the server's world. Read off PIXIapp.view —
		// this used to screenshot the dead #MainCanvas placeholder and assert a byte length,
		// which a blank 300x150 PNG also satisfies (KDM-217; see helpers/render-surface.ts).
		await isolatedPage.waitForTimeout(300);
		const frame = await readRenderSurface(isolatedPage);
		expect(frame.colors, 'render surface should hold a painted frame').toBeGreaterThan(PAINTED_MIN_COLORS);

		// --- input round-trip: both players submit → shared world advances a turn ---
		const t0 = first.stateTick;
		// browser A submits its input (the submitter receives 'waiting' while the
		// barrier is open); then node B submits → barrier completes → turn advances.
		await isolatedPage.evaluate(() => {
			const w = window as any;
			w.__ws.send(JSON.stringify({ type: 'input', action: { dx: 0, dy: 0 } }));
		});
		await isolatedPage.waitForTimeout(200); // let A's input reach the server first
		B.send(JSON.stringify({ type: 'input', action: { dx: 0, dy: 0 } }));

		// the browser receives the post-turn render-state with the tick advanced
		await isolatedPage.waitForFunction(
			(prev) => (window as any).__states.some((s: any) => s.tick === prev + 1),
			t0, { timeout: 20_000 },
		);
		const advancedTick = await isolatedPage.evaluate(() => (window as any).__states[(window as any).__states.length - 1].tick);
		expect(advancedTick).toBe(t0 + 1);

		B.close();
	} finally {
		bridge.close();
	}
});
