/**
 * KDM-270 — a refusal that NAMES ANOTHER SEAT does not close the socket.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────────────────
 * `ws-bridge._reject` ended every refusal with `socket.end()`. That is right for a refusal there is
 * no way back from — `build_mismatch`, `session_full`, `declined`, `seat_gone`. It is wrong for
 * `already_hosting`, which does not mean "go away": it means **"you asked for the wrong seat, and
 * the other one may well be free."**
 *
 * Two people on one LAN both press Host, and the second has their socket closed under them — they
 * must back out and re-enter the Join view to do the thing the server already knows they can do.
 * The `#coop=` shortcut needs the same transition and pays for it with a full RECONNECT.
 *
 * ── THE RULE, AND WHY IT LIVES AT THE GATE ────────────────────────────────────────────────────────
 * The refusal carries `retry` — **the seat this client may ask for on THIS socket** — and `_reject`
 * closes iff `retry` is absent. One field, one line, one place; no call site decides for itself and
 * no reason string is matched anywhere else.
 *
 * It could NOT be a table keyed on the reason, and that is the finding this spec pins down:
 * `already_hosting` is raised at two places with two meanings. From `claimHost` it means "somebody
 * else hosts" (→ ask for `guest`). From `requestJoin` it means "*you* are the host" (→ the seat you
 * may ask for is `host`, which you already hold). The second one is a SEATED PLAYER, and closing its
 * socket runs the `close` handler's `gate.release` — the host losing its own seat for asking a silly
 * question. Terminality therefore has to be decided where the refusal is raised.
 *
 * ── WHY THE CONTROLS ARE NOT DECORATION ───────────────────────────────────────────────────────────
 * "The socket is still open" passes trivially against a bridge that has stopped closing sockets at
 * all. So every open-socket assertion here is paired with a terminal refusal asserted CLOSED through
 * the same `closedWithin` primitive, in the same file. Remove the pairing and this spec proves
 * nothing about `_reject` — only that `_reject` exists.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-270.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MPClient, seatPair } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge, OUTBOUND_MESSAGES } = require('../../tools/mp-server/ws-bridge');

const BUILD = 'retry-build';

/**
 * Vitest's default is 5 s, and these tests SPEND time on purpose: proving a socket stayed open means
 * watching it not close, and the terminal controls wait out a real hang-up. Add the full-layer run's
 * contention (114 files, several booting whole KD bundles) and 5 s is a coin toss — R3 passed alone
 * twice and timed out in the full run, which is a slow test wearing a flake's clothes.
 *
 * Raised rather than shortened: the waits are the evidence, and trimming them to fit the default is
 * how a control stops controlling. Nothing here waits this long when it passes.
 */
const SOCKET_TEST_TIMEOUT = 20_000;

const isReject = (m: any) => m.type === 'reject';
const isJoined = (m: any) => m.type === 'joined';

describe('KDM-270 — a non-terminal refusal', () => {
	let bridge: any = null;
	const open: MPClient[] = [];

	afterEach(async () => {
		for (const c of open.splice(0)) c.close();
		if (bridge) { try { await bridge.close(); } catch (e) { /* noop */ } bridge = null; }
	});

	async function boot(opts: any = {}) {
		bridge = new WSBridge(Object.assign({ requiredPlayers: 2, seed: 'retry', hbIntervalMs: 0 }, opts));
		return bridge.listen(0);
	}
	async function client(port: number) {
		const c = await MPClient.connect(port);
		open.push(c);
		return c;
	}
	/** Seat a host and hand back its client, since every case below needs one. */
	async function withHost(port: number, id = 'A') {
		const A = await client(port);
		A.send({ type: 'join', clientId: id, role: 'host' });
		await A.next(isJoined);
		return A;
	}

	// ── R1: the rule is declared, and it is declared once ───────────────────────────────────

	it('R1 — `retry` is a declared field of the reject frame', () => {
		const dec = OUTBOUND_MESSAGES.reject;
		// The outbound drift guard (KDM-274) only checks fields it has been told about, so a field
		// travelling undeclared is invisible to it — which is the hole this line closes.
		expect([...(dec.optional || [])], 'retry rides the refusal it belongs to').toContain('retry');
		expect([...dec.required], 'and only ever optionally — a terminal refusal carries none')
			.not.toContain('retry');
	});

	// ── R2 + R5: the pair that makes each other mean something ──────────────────────────────

	it('R2 — `already_hosting` names the guest seat and LEAVES THE SOCKET OPEN', async () => {
		const port = await boot();
		await withHost(port);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'B', role: 'host' });
		const r = await B.next(isReject);

		expect(r.reason).toBe('already_hosting');
		expect(r.retry, 'the seat B may ask for, named by the server').toBe('guest');
		expect(await B.closedWithin(500), 'the refusal was an answer, not a hang-up').toBe(false);
	}, SOCKET_TEST_TIMEOUT);

	it('R5 CONTROL — `build_mismatch` carries no retry and still closes', async () => {
		const port = await boot({ build: BUILD });
		const A = await client(port);
		A.send({ type: 'join', clientId: 'A', role: 'host', build: BUILD });
		await A.next(isJoined);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'B', role: 'guest', build: 'a-different-build' });
		const r = await B.next(isReject);

		expect(r.reason).toBe('build_mismatch');
		expect(r.retry, 'there is no seat on this server that a wrong build may take').toBeUndefined();
		// The line that makes R2 above a claim about `_reject` rather than a claim about nothing.
		expect(await B.closedWithin(2000), 'a terminal refusal still hangs up').toBe(true);
	}, SOCKET_TEST_TIMEOUT);

	it('R5 CONTROL — `session_full` closes too, so "open" is not simply what this bridge does', async () => {
		const port = await boot();
		const { host, guest } = await seatPair(port);
		open.push(host, guest);

		const C = await client(port);
		C.send({ type: 'join', clientId: 'C', role: 'guest' });
		const r = await C.next(isReject);

		expect(r.reason).toBe('session_full');
		expect(r.retry).toBeUndefined();
		expect(await C.closedWithin(2000)).toBe(true);
	}, SOCKET_TEST_TIMEOUT);

	// ── R3: and the second ask actually works, on that same socket ──────────────────────────

	it('R3 — a client refused `already_hosting` joins as GUEST on the same socket, no reconnect', async () => {
		const port = await boot();
		const A = await withHost(port);

		const B = await client(port);
		const socketBefore = B.ws;
		B.send({ type: 'join', clientId: 'B', role: 'host' });
		const r = await B.next(isReject);
		expect(r.retry).toBe('guest');

		// THE ASK ITSELF — no new WebSocket anywhere in this test.
		B.send({ type: 'join', clientId: 'B', role: 'guest', name: 'Ada' });

		// It goes through the ordinary gate: the host is asked, and only their answer seats anyone.
		await A.next((m: any) => m.type === 'join_pending' && m.clientId === 'B');
		expect(bridge.gate.guest, 'asking is still not joining').toBe(null);

		A.send({ type: 'join_answer', accept: true });
		await B.next(isJoined);
		expect(bridge.gate.guest, 'seated by the gate, through the same road as anyone else').toBe('B');
		expect(B.ws, 'the same socket throughout').toBe(socketBefore);
	}, SOCKET_TEST_TIMEOUT);

	// ── R4: the second `already_hosting`, which is a different refusal ──────────────────────

	it('R4 — the HOST asking for the guest seat keeps its socket AND its seat', async () => {
		const port = await boot();
		const A = await withHost(port);

		// Nothing in today's client sends this. It is reachable by any client that does, and the cost
		// was the host's own seat: `_reject` closed the socket and the `close` handler released it.
		A.send({ type: 'join', clientId: 'A', role: 'guest' });
		const r = await A.next(isReject);

		expect(r.reason).toBe('already_hosting');
		expect(r.retry, 'the seat A may ask for is the one it already holds').toBe('host');
		expect(await A.closedWithin(500), 'a seated player is not hung up on').toBe(false);
		expect(bridge.gate.host, 'and still holds slot 0').toBe('A');
		expect(bridge.gate.slotOf('A')).toBe(0);
		expect(bridge.sockets.get('A'), 'the server can still reach it').toBeTruthy();
	}, SOCKET_TEST_TIMEOUT);

	// ── R7: `no_host` is the mirror case ────────────────────────────────────────────────────

	it('R7 — `no_host` names the host seat, and the guest can take it on the same socket', async () => {
		const port = await boot();

		const G = await client(port);
		G.send({ type: 'join', clientId: 'G', role: 'guest' });
		const r = await G.next(isReject);

		expect(r.reason).toBe('no_host');
		expect(r.retry, 'nobody is hosting, so the host seat is what is on offer').toBe('host');
		expect(await G.closedWithin(500)).toBe(false);

		G.send({ type: 'join', clientId: 'G', role: 'host' });
		await G.next(isJoined);
		expect(bridge.gate.host).toBe('G');
	}, SOCKET_TEST_TIMEOUT);

	// ── R9: a refused ask leaves nothing behind ─────────────────────────────────────────────

	it('R9 — a refused claim seats nothing, so the second ask starts where a first one would', async () => {
		const port = await boot();
		await withHost(port);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'B', role: 'host' });
		await B.next(isReject);

		// If the refused claim had half-seated B, the gate would answer for it here — and the guest
		// ask that follows would be running on top of state no first-time guest ever has.
		expect(bridge.gate.slotOf('B'), 'no slot').toBe(null);
		expect(bridge.gate.players(), 'the seated set is untouched').toEqual(['A']);
		expect(bridge.session.players).toEqual(['A']);
		expect(bridge.presence.roleOf('B'), 'and no presence role').toBeFalsy();
	}, SOCKET_TEST_TIMEOUT);
});
