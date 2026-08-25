/**
 * KDM-186 — the ws-bridge queue-timing instrumentation must actually MEASURE, not just exist.
 *
 * The 2026-08-17 profile put a `ui` transaction at ~16-20 ms of server CPU against the owner's
 * measured 1067 ms round-trip. The wait is therefore not the work, and the instrumentation added to
 * `ws-bridge.js` exists to say WHICH of the four remaining places holds the message: the transaction
 * (`apply`), same-batch queueing (`wait`/`batch`), event-loop theft (`loopLag`), or the reply sitting
 * in Node's socket buffer (`writes/blocked/maxSocketBacklog`).
 *
 * This is the anti-vacuity guard for that telemetry (test-validity lesson 1: five earlier tests in
 * this task passed while the bug was present, one of them because the precondition never fired).
 * A probe that silently reports zeros would send the owner into a UAT round that proves nothing.
 * So: drive real inputs through the real bridge over a real socket, and assert each field is
 * populated and self-consistent — never a latency threshold, which would be flake.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const net = require('net');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto');

const BOOT_TIMEOUT = 300_000;

/** Minimal RFC6455 client: the bridge only speaks masked text frames. */
function maskFrame(str: string) {
	const payload = Buffer.from(str, 'utf8');
	const mask = crypto.randomBytes(4);
	const len = payload.length;
	let header: Buffer;
	if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
	else header = Buffer.concat([Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff])]);
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
		sock.once('data', () => resolve(sock));   // the 101 handshake response
	});
}

describe('KDM-186 — ws-bridge queue-timing instrumentation', () => {
	it('populates every latency field from real traffic over a real socket', async () => {
		// Strict lockstep + idleGraceMs 0 — the DEMO's configuration, and the one under which a turn can
		// stall indefinitely waiting on a human. That stall is what the barrier line must report.
		const bridge: any = new WSBridge({ requiredPlayers: 2, seed: 'queue-timing', autoAdvance: false, idleGraceMs: 0 });
		const port = await bridge.listen(0);
		try {
			const a = await connect(port);
			const b = await connect(port);
			a.on('data', () => {}); b.on('data', () => {});
			/*
			 * KDM-255 — through the join gate, which is now the only road in. This spec reads nothing
			 * off its sockets on purpose (it is timing the raw wire, not the protocol), so the host's
			 * answer is written blind after a short settle rather than on seeing `join_pending`. The
			 * `session.started` precondition two lines down is what proves the handshake completed —
			 * if the answer were mistimed, that assertion fails rather than the spec passing hollow.
			 */
			a.write(maskFrame(JSON.stringify({ type: 'join', clientId: 'A', role: 'host' })));
			b.write(maskFrame(JSON.stringify({ type: 'join', clientId: 'B', role: 'guest' })));
			await new Promise((r) => setTimeout(r, 250));
			a.write(maskFrame(JSON.stringify({ type: 'join_answer', accept: true })));
			await new Promise((r) => setTimeout(r, 4000));   // both boots + session start
			expect(bridge.session.started, 'precondition: the session must have started').toBe(true);

			// Fire a burst in ONE write, exactly as a ~100 fps draw loop does: the frames land in the
			// same socket read, which is what produces a batch > 1 on the server.
			const burst = Buffer.concat(Array.from({ length: 40 }, (_, i) => maskFrame(JSON.stringify({
				type: 'input', action: { kdType: 'setMoveDirection', data: { dir: { x: 0, y: i % 2 ? -1 : 1 } } },
			}))));
			a.write(burst);
			// B submits a REAL turn-consuming action while A submits none: the barrier is now half
			// satisfied, which is exactly the state the demo sits in when the owner plays one window.
			b.write(maskFrame(JSON.stringify({
				type: 'input', action: { kdType: 'move', data: { dir: { x: 0, y: 0, delta: 1 }, delta: 1, AllowInteract: true } },
			})));
			await new Promise((r) => setTimeout(r, 3500));   // let the 1 Hz ticker fire at least twice

			// Assert on the EMITTED LINES, not the raw counters: the 1 Hz ticker drains the counters, and
			// the lines are what actually reaches the owner. Testing the artifact the human reads is the
			// point — a counter that is correct but never surfaces would still have wasted a UAT round.
			expect(bridge._statsTimer, "the 1 Hz stats ticker must be running").toBeTruthy();
			const lines: string[] = bridge._statsLog || [];
			expect(lines.length, "the ticker must have emitted lines for the browser").toBeGreaterThan(0);
			const all = lines.join("\n");
			// eslint-disable-next-line no-console
			console.log("\nKDM-186 [mp-stats] as the owner will see it:\n  " + lines.join("\n  ") + "\n");

			for (const field of ["apply p50=", "wait p95=", "batched=", "loopLag", "writes=", "maxSocketBacklog="]) {
				expect(all, "the emitted line must report " + field).toContain(field);
			}
			// A stalled turn must NAME who it waits on, or "nothing is happening" is indistinguishable
			// from "the transport is broken" — a confusion that already cost this task several hypotheses.
			expect(all, "a half-satisfied barrier must name the player it waits on").toContain("waiting on: A");
			expect(all, "the barrier line must state the lockstep setting that causes the wait")
				.toContain("idleGraceMs=0");

			// Non-vacuity: the burst must have been SEEN as a batch, and apply must be a real duration.
			const m = all.match(/batched=(\d+)\/max(\d+)/);
			expect(m, "the batched=N/maxM field must be parseable").toBeTruthy();
			expect(Number(m![1]), "messages behind a predecessor must be counted").toBeGreaterThan(0);
			expect(Number(m![2]), "a 40-frame burst in one write must be seen as a batch > 1").toBeGreaterThan(1);
			const ap = all.match(/apply p50=([\d.]+)ms/);
			expect(Number(ap![1]), "applyMs must be a real duration, not 0").toBeGreaterThan(0);

			// Draining must RESET, or every later reading is cumulative and unreadable.
			expect(bridge._drainInputStats(), "a drain with no new traffic must be empty").toBeNull();

			a.destroy(); b.destroy();
		} finally {
			bridge.close();
		}
	}, BOOT_TIMEOUT);
});
