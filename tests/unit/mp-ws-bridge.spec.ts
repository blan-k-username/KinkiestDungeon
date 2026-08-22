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
import { MPClient as Client } from '../helpers/mp-ws-client';


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
