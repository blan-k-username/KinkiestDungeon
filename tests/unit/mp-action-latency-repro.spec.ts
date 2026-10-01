/**
 * REPRO + GUARD — a real action landed ~3 s late because every per-frame stream input in a
 * socket read was paid in full.
 *
 * MEASURED IN THE OWNER'S LIVE SESSION (2026-08-17, `[mp-stats]` at 1 Hz, ~100 fps both windows):
 *
 *   B: ui=26/s  apply p50=54-70ms  wait p95=1300-2000ms  batched=25/max26
 *   A: ui=4/s   apply p50=33-79ms  wait p95=~180ms       batched=3/max4
 *   || loopLag avg=1600-2400ms  || writes=30 blocked=0 maxSocketBacklog=0KB
 *
 * ~30 inputs/s x ~60 ms = ~1.8 s of CPU demanded per wall-clock second ⇒ the loop ran ~2 s behind and
 * a turn-consuming action queued behind it landed ~3 s late. NOT write backpressure (`blocked=0`,
 * `maxSocketBacklog=0KB`), NOT the client (fps ~100). The waste is one field: `batched=25/max26` —
 * 26 `setMoveDirection` in ONE read, each applied in full, when only the last can matter.
 *
 * The fix coalesces superseded STREAM inputs within a single socket read. This drives the real bridge
 * over a real socket, because that is the layer the fix lives at — asserting at the session layer
 * would pass while the bug was fully present.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge, decodeFrames } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const net = require('net');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto');

const BOOT_TIMEOUT = 300_000;
const BURST = 26;   // what the owner's session delivered in one read

function maskFrame(str: string) {
	const payload = Buffer.from(str, 'utf8');
	const mask = crypto.randomBytes(4);
	const len = payload.length;
	const header = len < 126
		? Buffer.from([0x81, 0x80 | len])
		: Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
	const masked = Buffer.alloc(len);
	for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
	return Buffer.concat([header, mask, masked]);
}

function connect(port: number): Promise<any> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1', () => {
			sock.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
				+ 'Connection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64')
				+ '\r\nSec-WebSocket-Version: 13\r\n\r\n');
		});
		sock.once('error', reject);
		sock.once('data', () => resolve(sock));
	});
}

const frame = (i: number) => ({
	type: 'input', action: { kdType: 'setMoveDirection', data: { dir: { x: 0, y: i % 2 ? -1 : 1 } } },
});

// One socket read carrying a burst of stream frames, then a real COMMAND behind them — exactly the
// shape the owner's session produced.
const burst = () => Buffer.concat([
	...Array.from({ length: BURST }, (_, i) => maskFrame(JSON.stringify(frame(i)))),
	maskFrame(JSON.stringify({
		type: 'input',
		action: { kdType: 'move', data: { dir: { x: 0, y: 0, delta: 1 }, delta: 1, AllowInteract: true } },
	})),
]);

/** Every message the server sends on `sock`, parsed, in arrival order. */
function collect(sock: any): any[] {
	const got: any[] = [];
	let buf = Buffer.alloc(0);
	sock.on('data', (chunk: Buffer) => {
		const out = decodeFrames(Buffer.concat([buf, chunk]));
		buf = out.rest;
		for (const m of out.messages) { try { got.push(JSON.parse(m)); } catch (e) { /* close frame */ } }
	});
	return got;
}

/** A real bridge with A and B through the join gate and the session started. */
async function startedPair() {
	const bridge: any = new WSBridge({
		requiredPlayers: 2, seed: 'action-latency', autoAdvance: false, idleGraceMs: 0,
		seedInputKinds: true,
	});
	const port = await bridge.listen(0);
	const a = await connect(port);
	const b = await connect(port);
	// Through the join gate, the only road in. The `session.started` precondition below is
	// the proof the handshake actually completed.
	a.write(maskFrame(JSON.stringify({ type: 'join', clientId: 'A', role: 'host' })));
	b.write(maskFrame(JSON.stringify({ type: 'join', clientId: 'B', role: 'guest' })));
	await new Promise((r) => setTimeout(r, 250));
	a.write(maskFrame(JSON.stringify({ type: 'join_answer', accept: true })));
	await new Promise((r) => setTimeout(r, 4000));
	expect(bridge.session.started, 'precondition: session must have started').toBe(true);
	expect(bridge.session.inputKind.get('setMoveDirection'),
		'precondition: the type must be classified a STREAM, or coalescing must not apply').toBe('ui');
	return { bridge, a, b };
}

describe('a burst of per-frame stream input must not cost a transaction each', () => {
	it('coalesces superseded stream inputs within one socket read, and never drops a command', async () => {
		const { bridge, a, b } = await startedPair();
		try {
			collect(a); collect(b);
			a.write(burst());
			await new Promise((r) => setTimeout(r, 4000));

			// Read the EMITTED lines, not the live counters: the 1 Hz ticker drains them (and the lines
			// are what a human actually sees). Asserting on the counters races the ticker.
			const all: string = (bridge._statsLog || []).join("\n");
			expect(all, "precondition: the burst must have reached the session and been reported")
				.toContain("A:");
			// eslint-disable-next-line no-console
			console.log("\nburst of " + BURST + " stream inputs + 1 command:\n  "
				+ (bridge._statsLog || []).join("\n  ") + "\n");

			const uiApplied = [...all.matchAll(/A: ui=(\d+) turn=(\d+)/g)]
				.reduce((acc: any, m: any) => ({ ui: acc.ui + Number(m[1]), turn: acc.turn + Number(m[2]) }),
					{ ui: 0, turn: 0 });
			const coalesced = [...all.matchAll(/coalesced (\d+)/g)]
				.reduce((n: number, m: any) => n + Number(m[1]), 0);

			// THE FIX: superseded readings of the same level are not applied.
			expect(coalesced, "superseded stream inputs must be coalesced, not applied")
				.toBeGreaterThan(BURST / 2);
			expect(uiApplied.ui, "only the newest stream reading needs applying, not all " + BURST)
				.toBeLessThan(5);

			// ANTI-DELETION: coalescing must never swallow a turn-consuming COMMAND, and must never drop
			// the stream entirely — "apply nothing" would satisfy both assertions above.
			expect(uiApplied.turn, "the real command behind the burst must still be applied")
				.toBeGreaterThan(0);
			expect(uiApplied.ui, "the NEWEST stream reading must still be applied — not all dropped")
				.toBeGreaterThan(0);

			a.destroy(); b.destroy();
		} finally {
			bridge.close();
		}
	}, BOOT_TIMEOUT);

	/*
	 * Coalescing must still ANSWER every input it drops.
	 *
	 * The client matches replies to its sends strictly in order, one reply per send (`ackOne`,
	 * `_sentRoute`). A coalesced input used to be skipped with no reply at all, so every later reply was
	 * credited to an EARLIER send: a stream's `ui` ack landed on the `move` behind it, the client learned
	 * `move` was a stream, and click-to-move stopped after a step or two (owner UAT 2026-09-30).
	 */
	it('answers every input in the burst, coalesced or not, once and in order', async () => {
		const { bridge, a, b } = await startedPair();
		try {
			const fromA = collect(a); const fromB = collect(b);
			await new Promise((r) => setTimeout(r, 500));
			fromA.length = 0;                 // only what the burst is answered with
			a.write(burst());
			await new Promise((r) => setTimeout(r, 4000));

			// A reply to an input: its bare ack, its ui state frame, or `waiting` for a lockstep command.
			// A server-initiated `push` frame answers nothing.
			const answers = fromA.filter((m) => m.type === 'ack' || m.type === 'waiting'
				|| (m.type === 'state' && m.kind !== 'push'));
			// eslint-disable-next-line no-console
			console.log('\nreply types: ' + answers.map((m) => m.type + (m.kind ? ':' + m.kind : '')).join(' '));
			expect((bridge._statsLog || []).join('\n'), 'precondition: the burst must actually have been coalesced')
				.toMatch(/coalesced \d+/);
			expect(answers.length, 'one reply per input sent').toBe(BURST + 1);
			expect(answers[answers.length - 1].type, 'the COMMAND is answered last, as the lockstep reply')
				.toBe('waiting');

			// …and the turn the PARTNER then resolves is a reply to the partner's input only. A's frame
			// answers none of A's sends, and must say so, or A credits it to whatever it sent last.
			fromA.length = 0; fromB.length = 0;
			b.write(maskFrame(JSON.stringify({ type: 'input', action: { kind: 'wait' } })));
			await new Promise((r) => setTimeout(r, 4000));
			const turnA = fromA.filter((m) => m.type === 'state' && !m.kind);
			const turnB = fromB.filter((m) => m.type === 'state' && !m.kind);
			expect(turnB.length, 'precondition: the partner resolved exactly one turn').toBe(1);
			expect(turnA.length, 'precondition: A was told about that turn').toBe(1);
			expect(turnB[0].reply, "the resolver's frame answers its own input").toBe(true);
			expect(turnA[0].reply, "the other player's frame answers nothing of theirs").toBeUndefined();

			a.destroy(); b.destroy();
		} finally {
			bridge.close();
		}
	}, BOOT_TIMEOUT);
});
