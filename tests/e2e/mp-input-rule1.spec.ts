/**
 * E2E — KDM-198: the guard for KDM-186 RULE 1 v3 (STREAM vs COMMAND input).
 *
 * Rule 1 v3 is shipped and working, and it is the THIRD design in a row. Each earlier one fixed a
 * real UAT regression and caused another:
 *
 *   v1  deferred-and-replayed the superseded input → a double-emitted attack fired late as a
 *       DUPLICATE (UAT: duplicated damage + cast animation).
 *   v2  dropped the superseded input → a stream lost its TAIL, so the move reticule froze on
 *       whichever direction happened to be delivered first (UAT: "the red square is stuck").
 *   v3  splits them: a STREAM may be sampled but MUST converge on its newest value; a COMMAND is
 *       always delivered and never touched. The kind is LEARNED from the server's reply, never
 *       enumerated — an input answered without consuming a turn (`ui`) is presentation; anything
 *       else is a command; anything not yet observed is a command, because delivering is the safe
 *       default.
 *
 * Nothing tested it. Given that history, an untested v3 is one refactor away from silently becoming
 * v1 or v2 again, and both failure modes are user-visible.
 *
 * ── WHY THESE TESTS ASSERT ON THE WIRE ─────────────────────────────────────────────────────────
 * Rule 1 is a CLIENT-SIDE sampling rule: it decides what is sent. The wire is therefore the deciding
 * layer and the only oracle that can discriminate. Two earlier attempts prove the point:
 *
 *   - `mp-uat-repro` REPRO 7 asserts on the reticule (`KinkyDungeonMoveDirection`), which KD's own
 *     draw loop recomputes locally from the mouse EVERY FRAME whether or not anything was sent. It
 *     passes with the fix and without it.
 *   - REPRO 7's first version raced its own subject: it asserted the reticule equalled the last
 *     direction IT sent, while the game emits the real mouse direction every frame. The tell was an
 *     observed `delta: 1.5` — a value the test never sent.
 *
 * ── AND WHY THEY DO NOT "PLAY" THE GAME ────────────────────────────────────────────────────────
 * The harness renders ~4 fps against a real browser's ~95, so a RATE-triggered behaviour cannot be
 * reproduced by playing — that is what defeated the earlier attempts. The condition Rule 1 turns on
 * is not a rate but a STATE: "a send arrives while this type's slot is still busy". Each test drives
 * that state directly, by issuing two or more sends inside ONE synchronous `page.evaluate`. A reply
 * takes ~250 ms (it is frame-bound, KDM-214), so the later sends are guaranteed to land on a busy
 * slot. Deterministic, and independent of how fast the host renders.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, captureCoopWire, clearCoopWire, readCoopWire, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * A type the client cannot possibly have a verdict for. Unknown ⇒ COMMAND on both sides: the client
 * defaults to delivering, and the server sends an unrecognised `kdType` to lockstep (the safe
 * default — `swap-session.js`, "unknown type (first time) → lockstep").
 */
const NOVEL = 'kdm198NovelCommand';

/**
 * Silence the GAME's own stream, then wait for the type's slot to drain — so a burst measures only
 * what the test sent.
 *
 * Without this the test races its own subject, and the failure is not subtle: KD's draw loop emits
 * `setMoveDirection` from the real mouse EVERY FRAME, so the wire fills with the game's value and
 * the last send is the game's, not the test's. (Observed while writing this: a wire of
 * `[[-1,-1],[1,0],[-1,-1],…]` where `[-1,-1]` was never sent by the test — the same tell, an
 * unsent value, that exposed REPRO 7 v1.)
 *
 * `suppressHover` is KDM-204's diagnostic gate. It drops the game's hover input inside the
 * `KDSendInput` routing wrapper (`render-client.js:522`), BEFORE `submit()`, so Rule 1 itself is
 * untouched and the test's own `__coop.sendAction` calls still travel the full path. It is a
 * measurement isolator, not a stub of the thing under test.
 */
async function silenceGameStream(P: any, type = 'setMoveDirection') {
	await P.evaluate(() => (window as any).__coopDiag.suppressHover(true));
	// The chatter already in flight must land before the burst, or the burst's first send meets a
	// busy slot and is itself stashed — which would test something other than what it claims.
	await P.waitForFunction((t: string) => {
		const d = JSON.parse((window as any).__coopDiag.dump());
		return !(d.inFlight || {})[t] && (d.pending || []).indexOf(t) < 0;
	}, type, { timeout: 30_000 });
}

/** The client's learned verdicts + supersede counters, straight from its own telemetry. */
async function ruleState(P: any) {
	return await P.evaluate(() => {
		const d = JSON.parse((window as any).__coopDiag.dump());
		const skips = (d.rollups || []).reduce((acc: any, r: any) => {
			for (const k of Object.keys(r.skipTypes || {})) acc[k] = (acc[k] || 0) + r.skipTypes[k];
			return acc;
		}, {});
		return { kinds: d.kinds || {}, inFlight: d.inFlight || {}, pending: d.pending || [], skips };
	});
}

/**
 * T1 — a COMMAND is delivered IMMEDIATELY, and never deferred (guards against v1).
 *
 * v1's bug was not a lost input, it was a LATE one: the superseded send was held and replayed after
 * the slot freed, so a second attack landed as a duplicate long after the player pressed it. A test
 * that only counts sends cannot see that — v1 and v3 both end at two. What separates them is WHEN:
 * under v3 both are on the wire before any reply comes back; under v1 the second waits for the ack.
 *
 * So the assertion is on the wire read SYNCHRONOUSLY after the burst, plus the absence of any later
 * send of that type.
 */
test('a command is delivered immediately and never deferred', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);
		await captureCoopWire(A);

		// The type must be UNCLASSIFIED for this to be a command test at all — if a verdict already
		// existed the burst would prove nothing about the command path.
		const before = await ruleState(A);
		expect(before.kinds[NOVEL], `${NOVEL} already has a learned verdict (${JSON.stringify(before.kinds)}) ` +
			`— this test needs an unclassified type to exercise the "unknown ⇒ command" default.`).toBeUndefined();

		// Two DISTINCT commands back to back, AND the wire snapshot, inside ONE evaluate.
		//
		// The snapshot must be taken in the same synchronous block as the sends. Reading it from a
		// second `page.evaluate` is not "immediate": that is another round-trip, the page keeps
		// running across it, and a v1 replay slips in before the read. Measured against a deliberate
		// v1 mutation — the deferred command was replayed 377 ms after the first (t=387 → t=764),
		// well inside the gap — so the two-evaluate version of this test PASSED against v1 and
		// discriminated nothing. No page time may pass between the sends and the observation.
		const immediate = await A.evaluate((t) => {
			const w = window as any;
			w.__coop.sendAction({ kdType: t, data: { seq: 1 } });
			w.__coop.sendAction({ kdType: t, data: { seq: 2 } });
			return (w.__coopWire || []).filter((s: any) => s.type === t).map((s: any) => s.data && s.data.seq);
		}, NOVEL);

		expect(immediate,
			`both commands must be on the wire before the page can breathe, in order. Observed ` +
			`${JSON.stringify(immediate)}. A command held back until the slot frees is Rule 1 v1, ` +
			`whose late replay is what duplicated the attack in UAT.`).toEqual([1, 2]);

		// ...and nothing may arrive LATE. v1's duplicate showed up after the ack, so wait past a few
		// round-trips (a reply is ~250 ms) and confirm the wire has not grown.
		await A.waitForTimeout(3000);
		const settled = await readCoopWire(A, NOVEL);
		expect(settled.map((s) => s.data && s.data.seq),
			`a command was replayed after the fact — the wire grew to ${JSON.stringify(settled)} ` +
			`once replies landed. Commands must be delivered exactly once, when issued.`).toEqual([1, 2]);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * T2 — a STREAM converges on the NEWEST value (guards against v2).
 *
 * v2 dropped a superseded send outright. For a stream that is the TAIL — and the tail is exactly the
 * value that matters, because it is where the mouse came to rest. The reticule froze on whichever
 * direction happened to be delivered first (reproduced: reticule {1,0} while the last direction sent
 * was {-1,1}).
 *
 * Sampling the middle out is ALLOWED and is the point of the rule, so this does not assert that
 * every value is sent. It asserts convergence: the last thing on the wire is the last thing asked
 * for.
 */
test('a stream converges on its newest value', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// The stream path only engages once the server has TAUGHT the client that this type is 'ui'.
		// Waiting for the verdict (rather than assuming it) is also what keeps this test honest about
		// criterion 3: if the kind were enumerated instead of learned, this wait would be pointless.
		await A.waitForFunction(() => {
			const d = JSON.parse((window as any).__coopDiag.dump());
			return (d.kinds || {}).setMoveDirection === 'ui';
		}, undefined, { timeout: 30_000 });

		await silenceGameStream(A);
		await captureCoopWire(A);
		await clearCoopWire(A);

		// Four distinct directions in one evaluate. D1 takes the free slot; D2/D3 are superseded by
		// D4, which must be held and sent when the slot frees.
		const DIRS = [[1, 0], [0, 1], [-1, 0], [-1, 1]];
		await A.evaluate((dirs) => {
			const w = window as any;
			for (const d of dirs) {
				w.__coop.sendAction({ kdType: 'setMoveDirection', data: { dir: { x: d[0], y: d[1] }, delta: 1 } });
			}
		}, DIRS);

		const last = DIRS[DIRS.length - 1];
		// Give the slot time to free and flush the held value — several round-trips at ~250 ms each.
		await A.waitForTimeout(3000);

		const wire = await readCoopWire(A, 'setMoveDirection');
		const dirOf = (s: any) => s && s.data && s.data.dir ? [s.data.dir.x, s.data.dir.y] : null;
		const sent = wire.map(dirOf);
		const tail = sent.length ? sent[sent.length - 1] : null;

		expect(sent.length, `nothing reached the wire at all — the burst never left the client. ` +
			`${JSON.stringify(wire)}`).toBeGreaterThan(0);

		// THE ASSERTION. Not "everything was sent" (sampling is legitimate) but "the newest won".
		expect(tail, `the stream settled on ${JSON.stringify(tail)} but the last value asked for was ` +
			`${JSON.stringify(last)}. Full wire: ${JSON.stringify(sent)}. A stream that ends on a stale ` +
			`value is Rule 1 v2 — this is the frozen reticule from UAT.`).toEqual(last);

		// Sampling must actually have happened, or the burst never exercised the busy-slot path and
		// the test above proved nothing. (4 sends in, fewer than 4 out.)
		const st = await ruleState(A);
		expect(sent.length, `all ${sent.length} sends went straight out, so no send ever met a busy ` +
			`slot and the supersede path was never exercised. skips=${JSON.stringify(st.skips)}`)
			.toBeLessThan(DIRS.length);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * T3 — the kind is LEARNED from the server's reply, never enumerated.
 *
 * This is the criterion that keeps the design generic, and it is the epic's whole thesis: ask the
 * game, do not classify for it. A per-feature list would work today and break on the first modded or
 * newly-added input — the exact failure this epic exists to remove.
 *
 * It cannot be asserted by reading the source for a list (absence of one string proves nothing), so
 * it is asserted BEHAVIOURALLY: two types travel the same code path and receive OPPOSITE treatment,
 * and the only input to that decision is what the server replied. A novel type invented by this test
 * — which no shipped enumeration could contain — is delivered in full, while a type the server has
 * taught the client is `ui` gets sampled.
 */
test('the stream/command verdict is learned from the reply, not enumerated', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);
		await captureCoopWire(A);

		// 1. A type nobody has classified starts with NO verdict...
		const before = await ruleState(A);
		expect(before.kinds[NOVEL], `an unseen type must start with no verdict — the client may not ` +
			`presume one. kinds=${JSON.stringify(before.kinds)}`).toBeUndefined();

		// ...and is therefore DELIVERED in full, because "unknown" must fall back to command.
		// Snapshotted inside the burst for the same reason as T1: a deferred send replayed ~377 ms
		// later would otherwise be indistinguishable from one sent immediately.
		const novelWire = await A.evaluate((t) => {
			const w = window as any;
			w.__coop.sendAction({ kdType: t, data: { seq: 1 } });
			w.__coop.sendAction({ kdType: t, data: { seq: 2 } });
			return (w.__coopWire || []).filter((s: any) => s.type === t);
		}, NOVEL);
		expect(novelWire.length, `an unclassified type was sampled — ${JSON.stringify(novelWire)}. ` +
			`Unknown must default to COMMAND (deliver), never to stream (sample), or the first modded ` +
			`input the client meets gets silently dropped.`).toBe(2);

		// 2. A type the SERVER has taught the client is presentation gets the opposite treatment,
		//    through the same code, with no per-type knowledge anywhere in the client.
		await A.waitForFunction(() => {
			const d = JSON.parse((window as any).__coopDiag.dump());
			return (d.kinds || {}).setMoveDirection === 'ui';
		}, undefined, { timeout: 30_000 });

		await silenceGameStream(A);
		await clearCoopWire(A);
		await A.evaluate(() => {
			const w = window as any;
			for (const d of [[1, 0], [0, 1], [-1, 0], [-1, 1]]) {
				w.__coop.sendAction({ kdType: 'setMoveDirection', data: { dir: { x: d[0], y: d[1] }, delta: 1 } });
			}
		});
		const streamWire = await readCoopWire(A, 'setMoveDirection');

		const after = await ruleState(A);
		expect(after.kinds.setMoveDirection, `the verdict must come from the server's reply. ` +
			`kinds=${JSON.stringify(after.kinds)}`).toBe('ui');
		expect(streamWire.length, `a learned-'ui' type was NOT sampled (${streamWire.length}/4 sent) ` +
			`while the unclassified type was delivered in full. The two must differ, and the only ` +
			`difference between them is what the server replied — that is what makes this learned ` +
			`rather than enumerated. kinds=${JSON.stringify(after.kinds)}`).toBeLessThan(4);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
