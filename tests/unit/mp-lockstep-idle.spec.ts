/**
 * Node-layer (Vitest) test for humane lockstep — KD-087.
 *
 * Strict lockstep deadlocks when one player is idle/finished (e.g. their click-to-move
 * route ended) while a partner is still acting. The bridge's idle-grace auto-"wait"s
 * the non-submitters after `idleGraceMs` so the turn resolves; a `wait` is never a
 * contested action, so the all-must-submit / R9 invariants hold. With idleGraceMs=0 the
 * barrier is strict (no auto-advance). Driven over the real WebSocket protocol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

const BOOT_TIMEOUT = 240_000;
import { MPClient as Client } from '../helpers/mp-ws-client';


async function joinBoth(bridge: any): Promise<{ A: Client; B: Client }> {
	const port = await bridge.listen(0);
	const A = await Client.connect(port);
	const B = await Client.connect(port);
	A.send({ type: 'join', clientId: 'A' });
	await A.next((m) => m.type === 'joined');
	B.send({ type: 'join', clientId: 'B' });
	await A.next((m) => m.type === 'state');   // both joined → initial state
	await B.next((m) => m.type === 'state');
	return { A, B };
}

describe('Humane lockstep — idle grace (KD-087)', () => {
	let bridge: any;
	let A: Client;
	let B: Client;

	beforeAll(async () => {
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'idle-grace-seed', idleGraceMs: 80 });
		({ A, B } = await joinBoth(bridge));
	}, BOOT_TIMEOUT);

	afterAll(() => { A?.close(); B?.close(); bridge?.close(); });

	it('auto-"wait"s an idle player so a partner is not deadlocked', async () => {
		const t0 = bridge.session.turn;
		// A acts; B never does. Strict lockstep would hang here forever.
		A.send({ type: 'input', action: { kind: 'wait' } });
		// the idle player (B) is told it's being awaited
		const awaitMsg = await B.next((m) => m.type === 'await');
		expect(awaitMsg.waitingOn).toContain('B');
		// after the grace, the server auto-waits B → the turn resolves for BOTH
		const sa = await A.next((m) => m.type === 'state');
		const sb = await B.next((m) => m.type === 'state');
		expect(sa.tick).toBe(t0 + 1);
		expect(sb.tick).toBe(t0 + 1);
		expect(bridge.session.turn).toBe(t0 + 1);
	}, BOOT_TIMEOUT);
});

describe('Strict lockstep — idleGraceMs=0 (default) does NOT auto-advance', () => {
	let bridge: any;
	let A: Client;
	let B: Client;

	beforeAll(async () => {
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'strict-seed' });   // idleGraceMs defaults to 0
		({ A, B } = await joinBoth(bridge));
	}, BOOT_TIMEOUT);

	afterAll(() => { A?.close(); B?.close(); bridge?.close(); });

	it('blocks until every player submits (no auto-advance)', async () => {
		const t0 = bridge.session.turn;
		A.send({ type: 'input', action: { kind: 'wait' } });
		await A.next((m) => m.type === 'waiting');
		// give it ample time — the turn must NOT advance while B is idle
		await new Promise((r) => setTimeout(r, 400));
		expect(A.seen((m) => m.type === 'state')).toBe(false);
		expect(bridge.session.turn).toBe(t0);
		// B finally acts → now it resolves
		B.send({ type: 'input', action: { kind: 'wait' } });
		const sb = await B.next((m) => m.type === 'state');
		expect(sb.tick).toBe(t0 + 1);
	}, BOOT_TIMEOUT);
});
