/**
 * E2E — the co-op client's round-trip diagnostic pairs each reply with the send it ANSWERS.
 *
 * `mp-uat-repro`'s "a presentation input round-trips quickly" budget is read off
 * `__coopDiag.recentInputs`. Those samples used to come from a clock started when the game ASKED to send
 * (`submit`) and stopped by the next frame of certain kinds — not by the transport's own pairing. A
 * stream input that the client supersedes is never sent, yet it started a clock; the next reply was then
 * credited to it, so the "round-trip" grew with how much was superseded, i.e. with how slow the page was.
 * That reported a budget breach on a loaded host for a transaction that had not slowed down at all.
 *
 * The transport already knows the true pairing: the bridge answers each input exactly once and in
 * order, and `unwindOne` is where every reply consumes its send. This spec pins the diagnostic to it.
 *
 * ⚠️ DETERMINISTIC BY CONSTRUCTION. One page, no server world, no second player: the socket is a fake the
 * test answers, and `performance.now` is a hand-advanced clock — the whole scenario runs inside ONE
 * synchronous evaluate, so no page time (and no frame of KD's own) can land between a send and its reply.
 * Every expected sample is therefore an exact number, not a tolerance.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** A socket that is open at once, records what the client sends, and is answered by the test. */
function installFakeSocket() {
	class FakeSocket {
		url: string; readyState = 1; sent: any[] = [];
		onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
		constructor(url: string) { this.url = url; (window as any).__fakeWs = this; }
		send(s: string) { try { this.sent.push(JSON.parse(s)); } catch (e) { this.sent.push(s); } }
		close() { this.readyState = 3; }
	}
	(window as any).WebSocket = FakeSocket;
}

test('each round-trip sample is the time from a WIRE send to the reply that answers it', async ({ browser }) => {
	test.setTimeout(120_000);
	const { server, port } = await start(0);
	const ctx = await browser.newContext();
	await ctx.addInitScript(installFakeSocket);
	const page = await ctx.newPage();
	try {
		await page.goto(`http://127.0.0.1:${port}/`);
		await page.waitForFunction(() => typeof (window as any).__coopConnect === 'function'
			// @ts-ignore bundle global
			&& typeof KinkyDungeonStartNewGame === 'function' && typeof (window as any).KDRenderClient === 'object',
		undefined, { timeout: 90_000 });

		const out = await page.evaluate(() => {
			const w = window as any;
			w.__coopConnect({ role: 'host' });
			const ws = w.__fakeWs;
			ws.onopen && ws.onopen();
			w.__coop.started = true;
			// KD's own per-frame direction stream is not ours; nothing else may share the wire.
			w.__coopDiag.suppressHover(true);
			w.__coopDiag.reset();

			const realNow = performance.now;
			let now = 0;
			(performance as any).now = () => now;
			const at = (t: number) => { now = t; };
			const reply = (m: any) => ws.onmessage({ data: JSON.stringify(m) });
			const stream = (x: number) => w.__coop.sendAction(
				{ kdType: 'kdmpDiagProbe', data: { dir: { x, y: 0 }, delta: 1 } });
			const before = ws.sent.length;
			try {
				at(1000); stream(1);                 // A — first of its type: sent
				at(1100); reply({ type: 'ack' });    // A answered in 100; the client learns the type is a stream
				at(2000); stream(2);                 // B — sent, now in flight
				at(2010); stream(3);                 // C — superseded while B is in flight: NEVER sent
				at(2020); stream(4);                 // D — supersedes C; waits for B's reply
				at(2300); reply({ type: 'ack' });    // B answered in 300; D goes on the wire NOW
				at(2700); reply({ type: 'ack' });    // D answered in 400 (from its wire send, not its submit)
				at(3000); w.__coop.sendAction({ kind: 'wait' });          // E — a command: sent
				at(3250); reply({ type: 'blocked', reason: 'peace-offer' }); // refused — still an answer
			} finally {
				(performance as any).now = realNow;
			}
			const wire = ws.sent.slice(before).filter((m: any) => m && m.type === 'input');
			const d = JSON.parse(w.__coopDiag.dump());
			return {
				wire: wire.map((m: any) => (m.action.data && m.action.data.dir) ? m.action.data.dir.x : m.action.kind),
				samples: d.recentInputs.map((r: any) => r.ms),
				pendingSends: d.pendingSends,
			};
		});

		// Precondition: the supersede really happened, or this spec measures nothing.
		expect(out.wire, 'the wire carries A, B, D and E — C was superseded and never sent').toEqual([1, 2, 4, 'wait']);
		expect(out.samples, `one sample per WIRE send, each timed from that send to its own reply ` +
			`(A 100, B 300, D 400 from its flush at 2300, E 250 — answered by a refusal). Got ${JSON.stringify(out.samples)}`)
			.toEqual([100, 300, 400, 250]);
		expect(out.pendingSends, 'every send was answered, so nothing is left in flight').toBe(0);
	} finally {
		await ctx.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
