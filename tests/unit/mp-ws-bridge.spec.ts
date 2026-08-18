/**
 * Node-layer (Vitest) test for the local WebSocket bridge — KD-071/KD-085.
 *
 * Drives the hand-rolled RFC6455 bridge (tools/mp-server/ws-bridge.js, now fronting
 * the SWAP-model SwapSession) with TWO REAL WebSocket clients (Node's built-in global
 * WebSocket) to prove the full browser↔server protocol server-side: both clients join
 * → the shared world starts → each receives its render-state snapshot composed from the
 * ONE authoritative world + its state bundle (SwapSession.snapshotFor) → inputs are
 * barrier-gated (R8) → on completion both receive a new snapshot with the session turn
 * advanced in lockstep. This is exactly what KDRenderClient.apply() consumes in the
 * browser (proven render-able by the e2e spike).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { kdMerge } = require('../../tools/mp-server/kd-delta');

const BOOT_TIMEOUT = 240_000;

class Client {
	ws: any;
	private buf: any[] = [];
	private waiters: { pred: (m: any) => boolean; res: (m: any) => void; rej: (e: any) => void; timer: any }[] = [];

	static async connect(port: number): Promise<Client> {
		const c = new Client();
		// eslint-disable-next-line no-undef
		c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
		c.ws.addEventListener('message', (e: any) => { c.buf.push(c._resolve(JSON.parse(e.data))); c._pump(); });
		await new Promise<void>((res) => c.ws.addEventListener('open', () => res()));
		return c;
	}
	send(obj: any) { this.ws.send(JSON.stringify(obj)); }

	/**
	 * KDM-206: the bridge sends a full `snapshot` on the first state and a `delta` thereafter. A test
	 * client is a client, so it merges exactly like the browser does — with the SAME `kdMerge`, not a
	 * second implementation that could drift from it.
	 *
	 * Re-exposes the merged result as `m.snapshot`, so every assertion in this file keeps reading the
	 * property it always read. The protocol changed; what the tests assert about it did not.
	 */
	private _base: any = null;
	private _resolve(m: any) {
		if (m && m.type === 'state') {
			if (m.snapshot) this._base = m.snapshot;
			else if (m.delta && this._base) m.snapshot = this._base = kdMerge(this._base, m.delta);
		}
		return m;
	}
	next(pred: (m: any) => boolean, timeout = 20_000): Promise<any> {
		return new Promise((res, rej) => {
			const timer = setTimeout(() => rej(new Error('timeout waiting for message')), timeout);
			this.waiters.push({ pred, res, rej, timer });
			this._pump();
		});
	}
	private _pump() {
		for (let wi = 0; wi < this.waiters.length; wi++) {
			const w = this.waiters[wi];
			const idx = this.buf.findIndex(w.pred);
			if (idx >= 0) {
				const [m] = this.buf.splice(idx, 1);
				clearTimeout(w.timer);
				this.waiters.splice(wi, 1);
				w.res(m);
				wi--;
			}
		}
	}
	close() { try { this.ws.close(); } catch (e) { /* noop */ } }
}

describe('WSBridge — local WebSocket render+input round-trip (KD-071)', () => {
	let bridge: any;
	let port: number;
	let A: Client;
	let B: Client;

	beforeAll(async () => {
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'ws-bridge-seed' });
		port = await bridge.listen(0);
		A = await Client.connect(port);
		B = await Client.connect(port);
	}, BOOT_TIMEOUT);

	afterAll(() => {
		A?.close(); B?.close(); bridge?.close();
	});

	it('does not start until both clients join (barrier on join)', async () => {
		A.send({ type: 'join', clientId: 'A' });
		const ja = await A.next((m) => m.type === 'joined');
		expect(ja.clientId).toBe('A');
		expect(ja.started).toBe(false);
	}, BOOT_TIMEOUT);

	it('starts the shared world and pushes each client its render-state on join', async () => {
		B.send({ type: 'join', clientId: 'B' });
		const sa = await A.next((m) => m.type === 'state');
		const sb = await B.next((m) => m.type === 'state');
		// each gets a render-state v1 snapshot with a real dungeon map
		expect(sa.snapshot.version).toBe(1);
		expect(sb.snapshot.version).toBe(1);
		expect(typeof sa.snapshot.map.Grid).toBe('string');
		expect(sa.snapshot.map.Grid.length).toBeGreaterThan(0);
		// both clients see the SAME shared world map
		expect(sa.snapshot.map.Grid).toBe(sb.snapshot.map.Grid);
		// world tick is in lockstep across clients
		expect(sa.tick).toBe(sb.tick);
	}, BOOT_TIMEOUT);

	it('barrier-gates input and advances the turn in lockstep on completion', async () => {
		const t0 = bridge.session.turn;

		// A submits first → A gets a 'waiting' (barrier still open), no advance
		A.send({ type: 'input', action: { kind: 'wait' } });
		const waiting = await A.next((m) => m.type === 'waiting');
		expect(waiting.waitingOn).toContain('B');
		expect(bridge.session.turn).toBe(t0);

		// B submits → barrier completes → both receive a new state, tick advanced
		B.send({ type: 'input', action: { kind: 'wait' } });
		const sa = await A.next((m) => m.type === 'state');
		const sb = await B.next((m) => m.type === 'state');
		expect(sa.tick).toBe(t0 + 1);
		expect(sb.tick).toBe(t0 + 1);
		expect(sa.snapshot.version).toBe(1);
	}, BOOT_TIMEOUT);
});
