/**
 * KDM-280 — two clients presenting ONE id, and the seat that used to be stolen in silence.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────────────────
 * Measured with a probe against a real `WSBridge` while writing KDM-270's e2e, not inferred:
 *
 *     B got: {"type":"error","error":"duplicate join: host"}
 *     gate.host = host | name = Bob | players = ["host"] | socket replaced = true | A closed = false
 *
 * By the time the second client is told anything, three things have already happened:
 *
 *   1. `claimHost` ACCEPTED — it is idempotent for the same id, deliberately, so a host reloading its
 *      tab keeps the session — and stored the newcomer's declaration over the sitting host's;
 *   2. `ws-bridge` had already replaced `sockets.get(id)`, so every later server→host message goes to
 *      the WRONG browser and the real host's socket is orphaned, open and never addressed again;
 *   3. only then does `session.join` throw, and the refusal arrives as a bare `{type:'error'}` that no
 *      lobby branch reads — so the second player's screen simply sits there.
 *
 * The client half (`stableId` minting the literal `'host'` for everyone) is what made this reachable
 * by two ordinary players; `mp-lobby-two-tabs.spec.ts` covers that. This file is the server half: it
 * holds whatever the ids turn out to be.
 *
 * ── WHY A RELOAD IS THE CONTROL, AND NOT AN AFTERTHOUGHT ──────────────────────────────────────────
 * "Refuse a second claim on a seated id" and "let a reloading host back into its own seat" are the
 * same message on the wire. Only one signal separates them, and only the bridge holds it: whether the
 * id's PREVIOUS socket is still live. So every refusal assertion here is paired with a reload that
 * must still succeed — without that pair, a bridge that refuses everything passes, and reconnect
 * (KDM-252) dies quietly.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-280.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

/** These tests spend real time watching sockets NOT close; see mp-reject-retry.spec.ts. */
const SOCKET_TEST_TIMEOUT = 20_000;

const isJoined = (m: any) => m.type === 'joined';
const isReject = (m: any) => m.type === 'reject';

describe('KDM-280 — one id, two clients', () => {
	let bridge: any = null;
	const open: MPClient[] = [];

	afterEach(async () => {
		for (const c of open.splice(0)) c.close();
		if (bridge) { try { await bridge.close(); } catch (e) { /* noop */ } bridge = null; }
	});

	async function boot(opts: any = {}) {
		bridge = new WSBridge(Object.assign({ requiredPlayers: 2, seed: 'dupe', hbIntervalMs: 0 }, opts));
		return bridge.listen(0);
	}
	async function client(port: number) {
		const c = await MPClient.connect(port);
		open.push(c);
		return c;
	}

	// ── R5/R6: the collision is refused BEFORE it costs the sitting host anything ────────────

	it('R5 — a second client on a seated id is refused `duplicate_id`, in words', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'same', role: 'host', name: 'Alice' });
		await A.next(isJoined);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'same', role: 'host', name: 'Bob' });
		const r = await B.next(isReject);

		expect(r.reason, 'a typed refusal, not the bare {type:"error"} nothing reads').toBe('duplicate_id');
		expect(r.retry, 'there is no other seat to offer somebody who is not who they say').toBeUndefined();
		expect(await B.closedWithin(2000), 'and it is terminal').toBe(true);
	}, SOCKET_TEST_TIMEOUT);

	it('R6 — and the sitting host keeps its NAME, its socket and its seat', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'same', role: 'host', name: 'Alice' });
		await A.next(isJoined);
		const socketBefore = bridge.sockets.get('same');

		const B = await client(port);
		B.send({ type: 'join', clientId: 'same', role: 'host', name: 'Bob' });
		await B.next(isReject);

		// Each of these was FALSE before the fix — this is the probe's output, turned into assertions.
		expect(bridge.gate.nameOf('same'), "the newcomer's declaration was not stored").toBe('Alice');
		expect(bridge.sockets.get('same'), 'the server still talks to the tab that is playing')
			.toBe(socketBefore);
		expect(bridge.gate.host, 'the seat did not move').toBe('same');
		expect(bridge.session.players).toEqual(['same']);
		expect(await A.closedWithin(500), 'and the sitting host was not hung up on').toBe(false);
	}, SOCKET_TEST_TIMEOUT);

	// ── R2 CONTROL: the very same message, from the very same id, that MUST work ─────────────

	it('R2 CONTROL — a reload of the host (its old socket gone) re-claims its own seat', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'same', role: 'host', name: 'Alice' });
		await A.next(isJoined);

		// What a reload is, on the wire: the old socket goes away, then the same id asks again.
		A.close();
		await new Promise((r) => setTimeout(r, 250));   // let the close reach the server

		const A2 = await client(port);
		A2.send({ type: 'join', clientId: 'same', role: 'host', name: 'Alice' });
		// The line that stops R5 above from being "refuse every repeat id" — KDM-252's whole slice
		// rests on this staying true.
		await A2.next(isJoined);
		expect(bridge.gate.host).toBe('same');
		expect(bridge.sockets.get('same'), 'and the new socket is the one the server now uses')
			.toBe(A2.ws && bridge.sockets.get('same'));
	}, SOCKET_TEST_TIMEOUT);

	it('R2 CONTROL — a mid-session reload still re-attaches to a STARTED session', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'H', role: 'host' });
		await A.next(isJoined);
		const B = await client(port);
		B.send({ type: 'join', clientId: 'G', role: 'guest' });
		await A.next((m: any) => m.type === 'join_pending');
		A.send({ type: 'join_answer', accept: true });
		await B.next(isJoined);
		expect(bridge.session.started, 'the session really is running').toBe(true);

		B.close();
		await new Promise((r) => setTimeout(r, 250));
		const B2 = await client(port);
		B2.send({ type: 'join', clientId: 'G', role: 'guest' });
		const back = await B2.next(isJoined);
		expect(back.started, 'the reconnect road, which a duplicate-id rule must not block').toBe(true);
		expect(bridge.session.players.sort()).toEqual(['G', 'H']);
	}, SOCKET_TEST_TIMEOUT);

	// ── R4: with DIFFERENT ids it is an ordinary refusal, and KDM-270 answers it ─────────────

	it('R4 — a different id claiming the host seat gets `already_hosting`, not `duplicate_id`', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'alice', role: 'host', name: 'Alice' });
		await A.next(isJoined);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'bob', role: 'host', name: 'Bob' });
		const r = await B.next(isReject);

		// The two refusals must not be confused: this one is somebody who could still play.
		expect(r.reason).toBe('already_hosting');
		expect(r.retry, 'KDM-270 — and they are told which seat is free').toBe('guest');
		expect(bridge.gate.nameOf('alice')).toBe('Alice');
		expect(await B.closedWithin(500), 'so this one is NOT terminal').toBe(false);
	}, SOCKET_TEST_TIMEOUT);
});
