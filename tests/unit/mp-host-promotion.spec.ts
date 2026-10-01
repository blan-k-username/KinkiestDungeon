/**
 * When the host has been gone for the grace period, a guest becomes the host and the run
 * goes on.
 *
 * Before this, a host who left a running game held the host seat for ever: the guest could only quit,
 * and anyone pressing Host was refused `already_hosting` until the server restarted
 * (owner UAT). The world lives in the gateway, so the host ROLE can move.
 *
 * Driven through the real `WSBridge` over real sockets, with `hostGraceMs` shortened — the owner's
 * default is 2 minutes and a spec must never sleep that long. Every "did not happen" assertion waits
 * PAST the deadline, so it cannot pass merely by looking too early.
 *
 * The requirement labels name the behaviours this spec pins.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MPClient, seatPair } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HOST_LOST_DIALOGUE, NOW_HOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT_TIMEOUT = 240_000;
const GRACE = 1500;

const gd = (c: MPClient) => (c.snapshot && c.snapshot.bundle && c.snapshot.bundle.gameData) || {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 15_000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timeout after ${ms}ms waiting for: ${what}`);
		await sleep(20);
	}
}

let bridge: any = null;
const clients: MPClient[] = [];
afterEach(() => {
	for (const c of clients.splice(0)) c.close();
	try { bridge && bridge.close(); } catch (e) { /* noop */ }
	bridge = null;
});

async function pair(opts: any = {}) {
	bridge = new WSBridge(Object.assign({ requiredPlayers: 2, seed: 'host-promotion', hbIntervalMs: 0, hostGraceMs: GRACE }, opts));
	const port = await bridge.listen(0);
	const { host: A, guest: B } = await seatPair(port);
	clients.push(A, B);
	await A.next((m) => m.type === 'state');
	await B.next((m) => m.type === 'state');
	return { port, A, B };
}

async function joinAs(port: number, clientId: string, role: 'host' | 'guest') {
	const c = await MPClient.connect(port);
	clients.push(c);
	c.send({ type: 'join', clientId, role });
	return c;
}

describe('the host is gone: wait, then hand the seat on', () => {
	it('R1 — the guest is told the host is gone, with a countdown that the SERVER runs', async () => {
		const { B, A } = await pair();
		A.close();
		const miss = await B.next((m) => m.type === 'peer_missing');
		expect(miss.role).toBe('host');
		await until(() => gd(B).CurrentDialog === HOST_LOST_DIALOGUE, 'the host-lost dialogue on the guest');
		await until(() => !!(gd(B).CurrentDialogMsgData && gd(B).CurrentDialogMsgData.TIME), 'a countdown value');
		const first = gd(B).CurrentDialogMsgData.TIME;
		expect(first, 'm:ss').toMatch(/^\d+:\d\d$/);
		expect(bridge.session.paused, 'the run waits meanwhile').toBeTruthy();
	}, BOOT_TIMEOUT);

	it('R2 + R7 — a host who comes back in time keeps the seat; nobody is promoted', async () => {
		const { port, A, B } = await pair();
		A.close();
		await B.next((m) => m.type === 'peer_missing');
		const A2 = await joinAs(port, 'A', 'host');
		await A2.next((m) => m.type === 'joined');
		await sleep(GRACE + 500);                        // PAST the deadline, or "nothing happened" is vacuous
		expect(bridge.gate.host).toBe('A');
		expect(B.seen((m) => m.type === 'host_changed'), 'no promotion').toBe(false);
	}, BOOT_TIMEOUT);

	it('R3 — past the deadline the connected guest becomes the host, the old one leaves, the run resumes', async () => {
		const { A, B } = await pair();
		const turn = bridge.session.turn;
		A.close();
		await B.next((m) => m.type === 'peer_missing');
		const hc = await B.next((m) => m.type === 'host_changed', GRACE + 10_000);
		expect(hc.host).toBe('B');
		expect(bridge.gate.host).toBe('B');
		expect(bridge.session.players, "the old host's character left").toEqual(['B']);
		expect(bridge.session.turn, 'the same run, not a new one').toBe(turn);
		expect(bridge.session.paused, 'the run goes on').toBeFalsy();
		await until(() => gd(B).CurrentDialog === NOW_HOST_DIALOGUE, 'the "you are the host now" dialogue');
		// …and the new host really has the host's rights: exporting the run is host-only.
		B.send({ type: 'export_request' });
		const ex = await B.next((m) => m.type === 'save_export' || m.type === 'error');
		expect(ex.type, JSON.stringify(ex)).toBe('save_export');
		// R7 — at most once: another grace later, nothing else changes hands.
		await sleep(GRACE + 500);
		expect(bridge.gate.host).toBe('B');
	}, BOOT_TIMEOUT);

	it('R5 — the old host comes back after the hand-over and can join as an ordinary guest', async () => {
		const { port, A, B } = await pair();
		A.close();
		await B.next((m) => m.type === 'host_changed', GRACE + 10_000);
		const A2 = await joinAs(port, 'A', 'host');       // their tab reconnects claiming the seat it had
		const r = await A2.next((m) => m.type === 'reject');
		expect(r.reason).toBe('already_hosting');
		expect(r.retry, 'told it may ask as a guest, on the same socket').toBe('guest');
		A2.send({ type: 'join', clientId: 'A', role: 'guest' });
		await A2.next((m) => m.type === 'awaiting_approval');
		await B.next((m) => m.type === 'join_pending' && m.clientId === 'A');
		B.send({ type: 'join_answer', accept: true });
		const j = await A2.next((m) => m.type === 'joined');
		expect(j.started).toBe(true);
		expect(bridge.session.players).toEqual(['B', 'A']);
		expect(bridge.gate.host).toBe('B');
	}, BOOT_TIMEOUT);

	it('R4 + R6 — nobody left: the seat frees, a waiting guest is held, and the next Host continues the SAME run', async () => {
		const { port, A, B } = await pair();
		const turn = bridge.session.turn;
		// The host drops; the guest does not wait — they press LEAVE on the countdown screen, which
		// gives their seat up (a guest who merely disconnects keeps it held for their return).
		A.close();
		await B.next((m) => m.type === 'peer_missing');
		await until(() => gd(B).CurrentDialog === HOST_LOST_DIALOGUE, 'the countdown screen');
		B.send({ type: 'input', action: { kdType: 'dialogue', data: { dialogue: HOST_LOST_DIALOGUE, dialogueStage: 'Quit', click: true } } });
		await until(() => bridge.presence.state('B') === 'gone', 'the guest to leave');
		await sleep(GRACE + 800);
		expect(bridge.gate.host, 'the seat is free').toBe(null);
		expect(bridge.session.started, 'the run is still alive').toBe(true);

		// R6 — a guest who asks now waits for a host instead of being told nobody is hosting.
		const D = await joinAs(port, 'D', 'guest');
		const w = await D.next((m) => m.type === 'awaiting_approval' || m.type === 'reject');
		expect(w.type, JSON.stringify(w)).toBe('awaiting_approval');

		// R4 — the next Host press takes over the same run with their own character.
		const C = await joinAs(port, 'C', 'host');
		const j = await C.next((m) => m.type === 'joined');
		expect(j.started, 'into the running game').toBe(true);
		expect(bridge.gate.host).toBe('C');
		expect(bridge.session.players).toContain('C');
		expect(bridge.session.players, "the old host's character is gone").not.toContain('A');
		expect(bridge.session.turn, 'the same run').toBe(turn);
		// …and the waiting guest's question is put to them (R6).
		await C.next((m) => m.type === 'join_pending' && m.clientId === 'D');
	}, BOOT_TIMEOUT);
});
