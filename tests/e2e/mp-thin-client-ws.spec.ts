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
 */
import { test, expect } from '../helpers/playwright-fixtures';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

test('a browser thin-client renders server snapshots and rounds input over a WebSocket', async ({ kdPage }) => {
	const bridge = new WSBridge({ requiredPlayers: 2, seed: 'ws-e2e-seed' });
	const port = await bridge.listen(0);

	try {
		// Inject the production thin-client core and bootstrap render structures.
		await kdPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });
		await kdPage.evaluate(() => {
			// @ts-ignore — bring up PIXI + KD render globals (KDMapData etc.); the
			// thin client renders server snapshots, never simulates.
			KinkyDungeonStartNewGame(false);
			// @ts-ignore
			KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
			// @ts-ignore
			(window as any).KDRenderClient.disableLocalSim();
		});

		// Browser opens a WebSocket to the bridge as player A; store pushed states.
		await kdPage.evaluate((url) => {
			const w = window as any;
			w.__states = [];
			const ws = new WebSocket(url);
			w.__ws = ws;
			ws.onmessage = (e: MessageEvent) => {
				const m = JSON.parse(e.data);
				if (m.type === 'state') {
					w.KDRenderClient.apply(m.snapshot);        // render-only adopt
					w.__states.push({ tick: m.tick, grid: m.snapshot.map.Grid });
				}
			};
			ws.onopen = () => ws.send(JSON.stringify({ type: 'join', clientId: 'A' }));
		}, `ws://127.0.0.1:${port}`);

		// Node-side player B joins so the shared world starts.
		// eslint-disable-next-line no-undef
		const B = new WebSocket(`ws://127.0.0.1:${port}`);
		const bMsgs: any[] = [];
		B.addEventListener('message', (e: any) => bMsgs.push(JSON.parse(e.data)));
		await new Promise<void>((res) => B.addEventListener('open', () => res()));
		B.send(JSON.stringify({ type: 'join', clientId: 'B' }));

		// The browser should receive its first render-state and adopt it.
		await kdPage.waitForFunction(() => (window as any).__states.length >= 1, undefined, { timeout: 20_000 });
		const first = await kdPage.evaluate(() => {
			const w = window as any;
			return {
				stateTick: w.__states[0].tick,
				stateGrid: w.__states[0].grid,
				// @ts-ignore — the render globals now reflect the server snapshot
				liveGrid: KDMapData.Grid,
				// @ts-ignore — KDServerRole is a bundle `let` global (not on window)
				role: (typeof KDServerRole !== 'undefined') ? KDServerRole : null,
			};
		});
		// the browser's live render globals match the snapshot the server pushed
		expect(first.liveGrid).toBe(first.stateGrid);
		expect(first.role).toBe('client');

		// canvas renders a real frame of the server's world
		await kdPage.waitForTimeout(300);
		const shot = await kdPage.locator('#MainCanvas').screenshot();
		expect(shot.length).toBeGreaterThan(1000);

		// --- input round-trip: both players submit → shared world advances a turn ---
		const t0 = first.stateTick;
		// browser A submits its input (the submitter receives 'waiting' while the
		// barrier is open); then node B submits → barrier completes → turn advances.
		await kdPage.evaluate(() => {
			const w = window as any;
			w.__ws.send(JSON.stringify({ type: 'input', action: { dx: 0, dy: 0 } }));
		});
		await kdPage.waitForTimeout(200); // let A's input reach the server first
		B.send(JSON.stringify({ type: 'input', action: { dx: 0, dy: 0 } }));

		// the browser receives the post-turn render-state with the tick advanced
		await kdPage.waitForFunction(
			(prev) => (window as any).__states.some((s: any) => s.tick === prev + 1),
			t0, { timeout: 20_000 },
		);
		const advancedTick = await kdPage.evaluate(() => (window as any).__states[(window as any).__states.length - 1].tick);
		expect(advancedTick).toBe(t0 + 1);

		B.close();
	} finally {
		bridge.close();
	}
});
