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
