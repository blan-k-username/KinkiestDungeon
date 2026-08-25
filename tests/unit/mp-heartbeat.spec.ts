/**
 * KDM-250 — the heartbeat and the drop report, over the real socket.
 *
 * `mp-presence.spec.ts` proves the rules; this proves the protocol that carries them. The failure
 * this file exists for is the one the epic shipped: a player leaves, nothing notices, the departed
 * client stays in `session._joined`, `waitingOn()` names them forever, and the survivor's game sits
 * frozen with no explanation. After this slice the survivor is TOLD.
 *
 * TWO KINDS OF DEATH, and only one of them is a closed socket:
 *
 *   1. the tab closes            → `socket.on('close')`  → reported in the same event-loop turn
 *   2. the tab WEDGES            → nothing at all fires  → only a heartbeat can see it
 *
 * (2) is why the heartbeat is at the APPLICATION level rather than RFC6455 ping opcodes: a browser
 * answers a protocol ping from its network stack, so a protocol pong proves the socket is alive and
 * says exactly nothing about a frozen JS main loop. See KDM-234 A2.
 *
 * MOST OF THIS SPEC DOES NOT BOOT A WORLD. Presence is bridge-level bookkeeping and is independent of
 * whether the session has started, so the timing cases run with `requiredPlayers: 3` — two seats fill,
 * the session never starts, and no ~30 s bundle boot happens. The last describe pays for one real
 * booted session, because "the heartbeat adds no traffic" is only worth asserting in the real config.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-250 (EARS text in KDM-234).
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { MPClient, seatPair } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');

const BOOT_TIMEOUT = 240_000;

/** Fast enough to test, slow enough that a busy event loop does not false-positive. */
const HB_INTERVAL = 40;
const HB_TIMEOUT = 200;

const isMissing = (m: any) => m.type === 'peer_missing';
const isPing = (m: any) => m.type === 'ping';
const isState = (m: any) => m.type === 'state';

describe('KDM-250 — heartbeat and the drop report', () => {
	let bridge: any = null;
	const open: MPClient[] = [];

	afterEach(() => {
		for (const c of open.splice(0)) c.close();
		if (bridge) { try { bridge.close(); } catch (e) { /* noop */ } bridge = null; }
	});

	/** Two seats, no session start, no world boot — presence does not depend on either. */
	async function seatTwo(opts: any = {}) {
		bridge = new WSBridge(Object.assign({
			requiredPlayers: 3, seed: 'heartbeat', hbIntervalMs: HB_INTERVAL, hbTimeoutMs: HB_TIMEOUT,
		}, opts));
		const port = await bridge.listen(0);
		// KDM-255 — through the join gate, the only road in. `bPong` wedges the GUEST only: the host
		// has to keep answering, because it is the one that must notice.
		const { host: A, guest: B } = await seatPair(port, { guestPong: opts.bPong !== false });
		open.push(A, B);
		return { A, B, port };
	}

	describe('a closed socket is reported at once (E2, E3)', () => {
		it('the survivor is told WHO left', async () => {
			const { A, B } = await seatTwo();
			B.close();
			const m = await A.next(isMissing);
			expect(m.clientId).toBe('B');
		});

		it('...and in WHICH ROLE — host and guest are not symmetric (D5)', async () => {
			const { A, B } = await seatTwo();
			B.close();
			const m = await A.next(isMissing);
			expect(m.role, 'the second seat is the guest').toBe('guest');
		});

		it('a host drop is reported as a HOST drop', async () => {
			const { A, B } = await seatTwo();
			A.close();
			const m = await B.next(isMissing);
			expect(m.clientId).toBe('A');
			expect(m.role).toBe('host');
		});

		it('is reported once, not once per heartbeat', async () => {
			const { A, B } = await seatTwo();
			B.close();
			await A.next(isMissing);
			await new Promise((r) => setTimeout(r, HB_TIMEOUT + HB_INTERVAL * 3));
			expect(A.seen(isMissing), 'no second report').toBe(false);
		});
	});

	describe('a WEDGED peer — socket open, nobody home (E1)', () => {
		it('is caught by the heartbeat, with its socket still open', async () => {
			const { A, B } = await seatTwo();
			B.stopPong();
			const m = await A.next(isMissing, 5_000);
			expect(m.clientId).toBe('B');
			// The whole point: `close` never fired. If this is not 1 (OPEN) the test proved nothing
			// beyond what the close-handler tests already cover.
			expect(B.ws.readyState, 'the socket never closed — only the heartbeat could see this').toBe(1);
		});

		it('does NOT fire while the peer is still answering', async () => {
			const { A } = await seatTwo();
			await A.never(isMissing, HB_TIMEOUT * 3);
		});

		/**
		 * Control for the absence oracle above. "No `peer_missing` arrived" passes just as well on a
		 * bridge that never sends one at all, which is the vacuous shape. This is the SAME wait, on
		 * the SAME pair, with the one input changed — so a bridge that cannot report a drop fails here.
		 */
		it('control — the same window DOES report a peer that stops answering', async () => {
			const { A, B } = await seatTwo();
			B.stopPong();
			await A.never(isMissing, HB_TIMEOUT / 2);      // not yet
			const m = await A.next(isMissing, 5_000);       // but it does come
			expect(m.clientId).toBe('B');
		});
	});

	describe('the server actually pings (A2)', () => {
		it('sends pings on its own, without being asked', async () => {
			const { A } = await seatTwo();
			const first = await A.next(isPing, 5_000);
			const second = await A.next(isPing, 5_000);
			expect(typeof first.t).toBe('number');
			expect(second.t, 'the stamp advances, so a reply can be attributed').toBeGreaterThan(first.t);
		});

		it('is OFF when disabled, so an operator can turn it off deliberately', async () => {
			const { A } = await seatTwo({ hbIntervalMs: 0 });
			await A.never(isPing, 200);
		});
	});

	describe('N2 — a peer that never arrived is not a peer that left', () => {
		it('a lone host dropping reports nothing to nobody', async () => {
			bridge = new WSBridge({
				requiredPlayers: 3, seed: 'hb-latch', hbIntervalMs: HB_INTERVAL, hbTimeoutMs: HB_TIMEOUT,
			});
			const port = await bridge.listen(0);
			const A = await MPClient.connect(port);
			const W = await MPClient.connect(port);       // a watcher socket that never joins
			open.push(A, W);
			A.send({ type: 'join', clientId: 'A', role: 'host' });   // KDM-255: the gate is the road in
			await A.next((m) => m.type === 'joined');
			A.close();
			await W.never(isMissing, HB_TIMEOUT * 2);
		});
	});

	/**
	 * The only describe that pays for a real ~30 s world boot, so it boots ONCE in `beforeAll` and
	 * both cases share it. It deliberately keeps its own bridge and clients out of the outer
	 * `afterEach` bookkeeping: that hook closes everything between tests, which is right for the
	 * cheap unstarted-session cases above and would tear this one down halfway through.
	 */
	describe('S1 — with both peers healthy, nothing else changes', () => {
		let live: any = null;
		let A: MPClient; let B: MPClient;

		beforeAll(async () => {
			// A GENEROUS timeout here, unlike the detection cases above. This describe asserts that a
			// healthy heartbeat is QUIET, not how fast it notices a death — so a tight window buys it
			// nothing and costs it robustness. Learned the hard way: with 200 ms it went red in the
			// full suite, where the server's own event loop stalls (measured `loopLag max=1469.6ms`)
			// and every seat looks silent at once. Presence now credits that stall back
			// (`presence.js` `sweep`), and this window no longer sits on the edge of it either.
			live = new WSBridge({
				requiredPlayers: 2, seed: 'hb-live', hbIntervalMs: HB_INTERVAL, hbTimeoutMs: 30_000,
			});
			const port = await live.listen(0);
			({ host: A, guest: B } = await seatPair(port));   // KDM-255: the gate is the road in
			await A.next(isState);                        // both in → initial render-state
			await B.next(isState);
		}, BOOT_TIMEOUT);

		afterAll(() => {
			A?.close(); B?.close();
			try { live && live.close(); } catch (e) { /* noop */ }
		});

		it('a heartbeat round-trip produces no state frame (KDM-186 rule 2)', async () => {
			const t0 = live.session.turn;
			await A.next(isPing, 5_000);                  // at least one full ping/pong happened
			await A.next(isPing, 5_000);
			expect(A.seen(isState), 'a pong is not a change').toBe(false);
			expect(live.session.turn, 'and it certainly is not a turn').toBe(t0);
		}, BOOT_TIMEOUT);

		/** Control: the same `seen(isState)` oracle must be able to go true, or it proves nothing. */
		it('control — a real turn DOES produce a state frame', async () => {
			const t0 = live.session.turn;
			A.send({ type: 'input', action: { kind: 'wait' } });
			B.send({ type: 'input', action: { kind: 'wait' } });
			const s = await A.next(isState, 30_000);
			expect(s.tick).toBe(t0 + 1);
		}, BOOT_TIMEOUT);
	});
});
