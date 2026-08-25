/**
 * KDM-233 — the join APPROVAL round-trip, over the real socket.
 *
 * `mp-join-gate.spec.ts` proves the rules; this proves the protocol that carries them: a guest asks,
 * the HOST is asked, and nothing happens to the session until the host answers. Approval-only is the
 * whole gate (R2 — no join code, LAN-only per KDM-226), so the failure that matters most here is a
 * guest who gets in without the host ever saying yes.
 *
 * Requirement ids refer to the `## Requirements (EARS)` section of KDM-233.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

const BOOT_TIMEOUT = 240_000;
const BUILD = 'test-build-1';

const isJoined = (m: any) => m.type === 'joined';
const isPending = (m: any) => m.type === 'join_pending';
const isReject = (m: any) => m.type === 'reject';

describe('KDM-233 — join approval over the wire', () => {
	let bridge: any = null;
	const open: MPClient[] = [];

	afterEach(async () => {
		for (const c of open.splice(0)) c.close();
		if (bridge) { try { await bridge.close(); } catch (e) { /* noop */ } bridge = null; }
	});

	async function boot(opts: any = {}) {
		bridge = new WSBridge(Object.assign({ requiredPlayers: 2, seed: 'join-approval', build: BUILD }, opts));
		const port = await bridge.listen(0);
		return port;
	}
	async function client(port: number) {
		const c = await MPClient.connect(port);
		open.push(c);
		return c;
	}

	/** Host claims slot 0 and is in the session alone — S1: no guest, nothing multiplayer yet. */
	async function hostUp(port: number) {
		const H = await client(port);
		H.send({ type: 'join', clientId: 'H', role: 'host', build: BUILD });
		const joined = await H.next(isJoined);
		expect(joined.started, 'one player is not a session').toBe(false);
		return H;
	}

	it('a guest request reaches the HOST and admits nobody until answered (E1)', async () => {
		const port = await boot();
		const H = await hostUp(port);
		const G = await client(port);

		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: BUILD });

		const ask = await H.next(isPending);
		expect(ask.name, 'the host judges by name — it is all approval-only gives them').toBe('Ada');
		expect(ask.clientId).toBe('G');

		// The heart of it: asking is not joining.
		await G.never(isJoined);
		expect(bridge.session.players, 'a pending guest is not in the session').toEqual(['H']);
	});

	it('accept admits the guest and starts the session (E2)', async () => {
		const port = await boot();
		const H = await hostUp(port);
		const G = await client(port);
		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: BUILD });
		await H.next(isPending);

		H.send({ type: 'join_answer', accept: true });

		const joined = await G.next(isJoined, BOOT_TIMEOUT);
		expect(joined.started).toBe(true);
		expect(bridge.session.players).toEqual(['H', 'G']);
	}, BOOT_TIMEOUT);

	it('decline refuses the guest with a stated reason and leaves the host untouched (E3)', async () => {
		const port = await boot();
		const H = await hostUp(port);
		const G = await client(port);
		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: BUILD });
		await H.next(isPending);

		H.send({ type: 'join_answer', accept: false });

		const rej = await G.next(isReject);
		expect(rej.reason).toBe('declined');
		await G.never(isJoined);
		expect(bridge.session.players, 'the host keeps playing, alone').toEqual(['H']);
		expect(bridge.session.started).toBe(false);
	});

	it('a second request while one is pending is refused, not queued (E7)', async () => {
		const port = await boot();
		const H = await hostUp(port);
		const G = await client(port);
		const G2 = await client(port);
		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: BUILD });
		await H.next(isPending);

		G2.send({ type: 'join', clientId: 'G2', role: 'guest', name: 'Bob', build: BUILD });

		expect((await G2.next(isReject)).reason).toBe('busy');
		// The host must not be asked twice — that is how you answer about Ada and admit Bob.
		await H.never(isPending);
	});

	it('a build mismatch is refused and the host is never even asked (N1)', async () => {
		const port = await boot();
		const H = await hostUp(port);
		const G = await client(port);

		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: 'some-other-build' });

		const rej = await G.next(isReject);
		expect(rej.reason).toBe('build_mismatch');
		expect(rej.hostBuild, 'the guest is told WHICH side is behind').toBe(BUILD);
		expect(rej.guestBuild).toBe('some-other-build');
		await H.never(isPending);
	});

	it('a guest asking with nobody hosting is refused in words, not left hanging (E6)', async () => {
		const port = await boot();
		const G = await client(port);

		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: BUILD });

		expect((await G.next(isReject)).reason).toBe('no_host');
	});

	it('a requester who drops withdraws the question — the host is not left staring at a ghost', async () => {
		const port = await boot();
		const H = await hostUp(port);
		const G = await client(port);
		G.send({ type: 'join', clientId: 'G', role: 'guest', name: 'Ada', build: BUILD });
		await H.next(isPending);

		G.close();
		await new Promise((r) => setTimeout(r, 200));

		expect(bridge.gate.pending, 'a requester who left is no longer asking').toBe(null);
	});

	/*
	 * KDM-255 — this used to be `'legacy join with no role still works — the #coop= entry path is
	 * not broken'`, and it asserted that a roleless `join` was seated WITHOUT the gate. That was
	 * honest at the time: KDM-233 shipped the gate beside the old road rather than in place of it,
	 * because the suite and `#coop=` both stood on the old one.
	 *
	 * The road is gone. `#coop=` now asks for the host seat and comes back as a guest if someone
	 * already has it, so the entry path is not broken — it goes through here. Its successor lives in
	 * `mp-join-one-road.spec.ts`, which owns the removal and its regression guards; this file keeps
	 * only the assertion that belongs to the approval protocol.
	 */
	it('a join that names no seat is refused, so the gate cannot be walked around', async () => {
		const port = await boot();
		const A = await client(port);
		A.send({ type: 'join', clientId: 'A' });
		expect((await A.next(isReject)).reason).toBe('no_role');
		expect(bridge.session.players, 'and nobody was seated on the way out').toEqual([]);
	});
});
