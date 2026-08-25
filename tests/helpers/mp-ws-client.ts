/**
 * tests/helpers/mp-ws-client.ts  (extracted KDM-233)
 *
 * ONE test-side WebSocket client for the mp-server bridge, shared by every node-layer spec that
 * drives `tools/mp-server/ws-bridge.js`.
 *
 * WHY IT EXISTS. This class was hand-rolled twice — `mp-ws-bridge.spec.ts` and
 * `mp-lockstep-idle.spec.ts` carried near-identical copies that had already drifted (only one
 * merged deltas, only the other had `seen`). A third copy was about to be written for the join-gate
 * protocol, so it was extracted instead. Drifting test clients are especially expensive here: a spec
 * whose client does not merge deltas asserts against a stale base and goes quietly, wrongly green.
 *
 * IT MERGES LIKE THE BROWSER DOES. The bridge sends a full `snapshot` on the first state and a
 * `delta` thereafter (KDM-206). This client merges with the SAME `kdMerge` the browser uses, not a
 * second implementation that could drift from it, and re-exposes the merged result as `m.snapshot`
 * so assertions read the property they always read.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { kdMerge } = require('../../tools/mp-server/kd-delta');

export class MPClient {
	ws: any;
	private buf: any[] = [];
	private waiters: { pred: (m: any) => boolean; res: (m: any) => void; rej: (e: any) => void; timer: any }[] = [];
	private _base: any = null;
	private _pong = true;

	/**
	 * KDM-250: IT ANSWERS THE HEARTBEAT, like a live browser does.
	 *
	 * The server now pings periodically and marks a silent seat `missing`. A test client that did not
	 * answer would be declared dead partway through every OTHER spec in the suite — so answering is
	 * the default, and not answering is the thing you opt into. `{pong:false}` (or `stopPong()`
	 * mid-test) is how a spec plays a WEDGED peer: socket still open, nobody home.
	 */
	static async connect(port: number, opts: { pong?: boolean } = {}): Promise<MPClient> {
		const c = new MPClient();
		c._pong = opts.pong !== false;
		// eslint-disable-next-line no-undef
		c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
		c.ws.addEventListener('message', (e: any) => {
			const m = JSON.parse(e.data);
			if (m && m.type === 'ping' && c._pong) { try { c.send({ type: 'pong', t: m.t }); } catch (err) { /* closing */ } }
			c.buf.push(c._resolve(m));
			c._pump();
		});
		await new Promise<void>((res) => c.ws.addEventListener('open', () => res()));
		return c;
	}

	/** Play dead without closing the socket — the failure a socket-close handler cannot see. */
	stopPong() { this._pong = false; }

	send(obj: any) { this.ws.send(JSON.stringify(obj)); }

	/** Has a matching message ALREADY arrived? Non-consuming, unlike `next`. */
	seen(pred: (m: any) => boolean) { return this.buf.some(pred); }

	/** Wait for the next matching message, consuming it. */
	next(pred: (m: any) => boolean, timeout = 20_000): Promise<any> {
		return new Promise((res, rej) => {
			const timer = setTimeout(() => rej(new Error('timeout waiting for message')), timeout);
			this.waiters.push({ pred, res, rej, timer });
			this._pump();
		});
	}

	/**
	 * Assert that NO matching message arrives within `ms`. Absence oracles are easy to write
	 * vacuously, so this is deliberately explicit about the window it watched.
	 */
	async never(pred: (m: any) => boolean, ms = 250): Promise<void> {
		await new Promise((r) => setTimeout(r, ms));
		const hit = this.buf.find(pred);
		if (hit) throw new Error(`expected no matching message within ${ms}ms, got ${JSON.stringify(hit)}`);
	}

	close() { try { this.ws.close(); } catch (e) { /* noop */ } }

	private _resolve(m: any) {
		if (m && m.type === 'state') {
			if (m.snapshot) this._base = m.snapshot;
			else if (m.delta && this._base) m.snapshot = this._base = kdMerge(this._base, m.delta);
		}
		return m;
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
}

/**
 * KDM-255 — seat a host/guest PAIR through the join gate, which is now the only road in.
 *
 * WHY IT EXISTS. Eleven node-layer specs used to open their clients with a bare
 * `{ type: 'join', clientId: 'A' }`. That frame took the roleless branch of `ws-bridge._handle`,
 * which seated a client by ARRIVAL ORDER without ever consulting `join-gate.js` — a second
 * implementation of joining that existed only because the tests depended on it. KDM-255 removed the
 * branch, so every spec has to go through the gate, and hand-editing eleven copies of the four-frame
 * handshake is exactly the duplication `MPClient` itself was extracted to stop (see this file's
 * header).
 *
 * IT IS NOT A BYPASS, and that is the point. It sends the same frames a browser sends and waits for
 * the same replies; the host really does answer `join_answer`. A spec using it is subject to every
 * gate rule — `already_hosting`, `session_full`, `busy`, `build_mismatch` — which is what
 * `mp-join-one-road.spec.ts` asserts about this helper directly. If it ever grows a shortcut that
 * skips `gate.accept()`, every spec that leans on it goes quietly, wrongly green.
 *
 * `build` is deliberately NOT sent. The bridges these specs construct configure none, so
 * `gate.buildCheckActive()` is false and the check stands down — a spec that wants to exercise N1
 * configures a build and sends its own frames.
 *
 * `hostPong` / `guestPong` are SEPARATE because the heartbeat specs wedge exactly one side and watch
 * the other notice. A single shared flag would silence both, and "nobody is home" is not a test of
 * "your peer is not home".
 */
export async function seatPair(
	port: number,
	opts: { host?: string; guest?: string; hostPong?: boolean; guestPong?: boolean } = {},
): Promise<{ host: MPClient; guest: MPClient }> {
	const hostId = opts.host || 'A';
	const guestId = opts.guest || 'B';
	const host = await MPClient.connect(port, { pong: opts.hostPong });
	host.send({ type: 'join', clientId: hostId, role: 'host' });
	await host.next((m) => m.type === 'joined');

	const guest = await MPClient.connect(port, { pong: opts.guestPong });
	guest.send({ type: 'join', clientId: guestId, role: 'guest' });
	// The host is ASKED before anyone is seated — a pending request holds no seat, so waiting for the
	// question before answering it is not politeness, it is the protocol.
	await host.next((m) => m.type === 'join_pending' && m.clientId === guestId);
	host.send({ type: 'join_answer', accept: true });
	await guest.next((m) => m.type === 'joined');
	return { host, guest };
}
