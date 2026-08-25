/**
 * KDM-255 — there is ONE road into a session, and it goes through the gate.
 *
 * `mp-join-gate.spec.ts` proves the gate's rules. `mp-join-approval.spec.ts` proves the protocol
 * that carries them. This spec proves the thing both of those quietly assumed and neither checked:
 * that the gate is the ONLY way in.
 *
 * WHAT WAS WRONG. `ws-bridge._handle` used to branch three ways on `msg.role` — `'host'`,
 * `'guest'`, and *anything else*. The third branch seated the client directly: no `claimHost`, no
 * `requestJoin`, no host asked, and `_roleFor` inventing a role from arrival order. Every gate rule
 * — `already_hosting`, `session_full`, `busy`, `build_mismatch` — was skipped on that road, and it
 * was the road `#coop=<id>` and eleven node-layer specs took. KDM-233 could not remove it because
 * the suite stood on it; KDM-255 is that removal.
 *
 * WHY THESE ASSERTIONS AND NOT "a roleless join is refused" ALONE. A single refusal test is
 * satisfied by a bridge that refuses roleless joins and still admits role-carrying ones through some
 * *other* bypass. So the shape here is: the frames a `#coop=` window actually sends are shown to be
 * subject to gate rules that the old road demonstrably ignored. Each one fails loudly if the branch
 * comes back.
 *
 * Requirement ids refer to the `## Requirements (EARS)` section of KDM-255.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MPClient, seatPair } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

const BUILD = 'one-road-build';

const isJoined = (m: any) => m.type === 'joined';
const isReject = (m: any) => m.type === 'reject';

describe('KDM-255 — one road in', () => {
	let bridge: any = null;
	const open: MPClient[] = [];

	afterEach(async () => {
		for (const c of open.splice(0)) c.close();
		if (bridge) { try { await bridge.close(); } catch (e) { /* noop */ } bridge = null; }
	});

	async function boot(opts: any = {}) {
		bridge = new WSBridge(Object.assign({ requiredPlayers: 2, seed: 'one-road', hbIntervalMs: 0 }, opts));
		return bridge.listen(0);
	}
	async function client(port: number) {
		const c = await MPClient.connect(port);
		open.push(c);
		return c;
	}

	// ── R1/R2: the branch itself is gone ────────────────────────────────────────────────────

	it('R2 — a join with no role is refused, not seated by arrival order', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'A' });

		const r = await A.next(isReject);
		expect(r.reason, 'refused in words, so a stale client learns why').toBe('no_role');
		// The assertion that actually kills the old branch: it used to answer `joined` here and put
		// 'A' in the session. A refusal that still seated the client would pass the line above.
		expect(bridge.session.players, 'nobody was seated').toEqual([]);
		expect(bridge.gate.players(), 'and the gate holds no seat either').toEqual([]);
	});

	it('R1 — a seated pair is seated BY THE GATE, not merely present in the session', async () => {
		const port = await boot();
		const { host, guest } = await seatPair(port);
		open.push(host, guest);

		// `session.players` was true on the old road too. `gate.slotOf` was not: the roleless branch
		// never wrote a slot, so this is the assertion that distinguishes the two roads.
		expect(bridge.gate.slotOf('A'), 'the host holds slot 0').toBe(0);
		expect(bridge.gate.slotOf('B'), 'the guest holds slot 1').toBe(1);
		expect(bridge.gate.players()).toEqual(['A', 'B']);
		expect(bridge.session.players).toEqual(['A', 'B']);
	});

	// ── R5: the gate's rules now apply on the `#coop=` road ─────────────────────────────────

	it('R5 — a second host claim is refused `already_hosting` (the #coop= road hits this)', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'A', role: 'host' });
		await A.next(isJoined);

		// This is precisely what window B does: it asks for the host seat first and is told no. On the
		// old road both windows were simply seated in arrival order and this refusal never existed.
		const B = await client(port);
		B.send({ type: 'join', clientId: 'B', role: 'host' });
		const r = await B.next(isReject);
		expect(r.reason).toBe('already_hosting');
		expect(bridge.gate.host, 'the sitting host was not evicted').toBe('A');
		expect(bridge.session.players, 'and B was not seated by the back door').toEqual(['A']);
	});

	it('R5 — a guest on the wrong build is refused before the host is ever asked', async () => {
		const port = await boot({ build: BUILD });
		const A = await client(port);
		A.send({ type: 'join', clientId: 'A', role: 'host', build: BUILD });
		await A.next(isJoined);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'B', role: 'guest', build: 'a-different-build' });
		const r = await B.next(isReject);
		expect(r.reason).toBe('build_mismatch');
		// N1's whole point: the host is not prompted about a pairing that cannot work.
		await A.never((m: any) => m.type === 'join_pending');
		expect(bridge.gate.pending, 'nothing was parked').toBe(null);
	});

	it('R5 — a third client is refused `session_full`, not admitted as a spectator', async () => {
		const port = await boot();
		const { host, guest } = await seatPair(port);
		open.push(host, guest);

		const C = await client(port);
		C.send({ type: 'join', clientId: 'C', role: 'guest' });
		const r = await C.next(isReject);
		expect(r.reason).toBe('session_full');
		expect(bridge.gate.players(), 'still exactly two seats').toEqual(['A', 'B']);
	});

	// ── R6: arrival order no longer decides anything ────────────────────────────────────────

	it('R6 — the role comes from the declaration, not from who arrived first', async () => {
		const port = await boot();
		// Deliberately inverted against arrival order: the FIRST client to arrive asks to be the
		// GUEST. The old `_roleFor` fallback answered `'host'` for it, because no seat existed yet.
		const G = await client(port);
		G.send({ type: 'join', clientId: 'G', role: 'guest' });
		const r = await G.next(isReject);
		expect(r.reason, 'a guest with nobody to ask is refused, not promoted').toBe('no_host');

		const H = await client(port);
		H.send({ type: 'join', clientId: 'H', role: 'host' });
		await H.next(isJoined);
		expect(bridge.presence.roleOf('H'), 'the second arrival is the host, because it said so').toBe('host');
	});

	// ── R8: the shared helper is not itself a bypass ─────────────────────────────────────────

	it('R8 — seatPair really makes the host answer; a guest is not seated before that', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'A', role: 'host' });
		await A.next(isJoined);

		const B = await client(port);
		B.send({ type: 'join', clientId: 'B', role: 'guest' });
		await A.next((m: any) => m.type === 'join_pending' && m.clientId === 'B');
		// The window the whole gate exists to protect: asked, but not yet answered.
		expect(bridge.gate.guest, 'a pending request holds no seat').toBe(null);
		expect(bridge.session.players).toEqual(['A']);

		A.send({ type: 'join_answer', accept: true });
		await B.next(isJoined);
		expect(bridge.gate.guest).toBe('B');
	});
});
