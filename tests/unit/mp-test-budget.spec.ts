/**
 * KDM-290 — no test may wait longer than the runner will let it run.
 *
 * ── THE BUG THIS ENDS ─────────────────────────────────────────────────────────────────────────────
 * `mp-join-one-road.spec.ts` R1 failed once in a full unit run with `Test timed out in 5000ms`, and
 * that message was the whole problem: it names the runner's budget and nothing about what the test
 * was waiting for. It passed alone, passed twice more on the same tree, and the pristine baseline was
 * green — so it read as a flake with no cause.
 *
 * Measured, it is not a race at all. `seatPair` seats the second player, which STARTS the session,
 * and starting a session boots a real headless KD world — map generation, seating, an enemy
 * (`swap-session.js:780-800`). That is 1.25 s of synchronous, legitimate work:
 *
 *     PROBE  listen=4ms host-connect=13ms host-joined=15ms guest-connect=16ms
 *            join_pending=17ms guest-joined=1398ms
 *     PROBE2 join(A)=0ms started=false   join(B)=1253ms started=true
 *     PROBE3 two joins, no start = 0ms
 *
 * Against vitest's DEFAULT 5 s budget — a number nobody in this repo chose — that leaves 3.5 s for
 * scheduling jitter. One competing suite alone stretches R1 from 1.4 s to 2.4 s; a 123-file parallel
 * run is worse. So the budget was mis-sized, and raising it is the fix rather than a cover-up.
 *
 * ── AND THE REASON THE FAILURE SAID NOTHING ───────────────────────────────────────────────────────
 * The second half, which is the part worth guarding. `MPClient.next()` defaulted to a 20 s wait and
 * four specs ask for 30–60 s — all of them LONGER than the 5 s budget, so not one could ever fire.
 * Every missing-frame bug in the MP node layer was therefore destined to report as the runner's
 * opaque timeout instead of "timeout waiting for message". The long waits were not generous, they
 * were inert.
 *
 * That inversion is invisible in review: the wait and the budget live in different files, and neither
 * is wrong on its own. It is the same shape as the other drift guards here (`mp-outbound-fields`, the
 * string table) — a declaration in one place, its users in another, and nothing that fails when the
 * two disagree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MAX_WAIT_MS } from '../helpers/mp-ws-client';

const ROOT = resolve(__dirname, '../..');
const UNIT = resolve(ROOT, 'tests/unit');

/** The runner's real budget, read from the config rather than restated here. */
function testTimeout(): number {
	const src = readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8');
	const m = /testTimeout:\s*([0-9_]+)/.exec(src);
	expect(m, 'vitest.config.ts must set testTimeout explicitly — the 5 s default is what caused '
		+ 'KDM-290, and inheriting it silently is how it would come back').toBeTruthy();
	return Number((m as RegExpExecArray)[1].replace(/_/g, ''));
}

describe('KDM-290 — the runner budget is larger than anything a test asks to wait for', () => {
	it('vitest.config.ts sets a budget, and it is big enough for a real session start', () => {
		const budget = testTimeout();
		// A session start measured at ~1.25 s idle and ~2.4 s against one competing suite. The floor
		// is deliberately well above both: the failure this replaces cost an hour to attribute, and
		// the cost of a generous budget is only paid by a test that is already failing.
		expect(budget, 'too small for a headless KD world boot under a parallel run')
			.toBeGreaterThanOrEqual(20_000);
	});

	it('the ws client waits less long than the runner allows, so IT reports the failure', () => {
		// The whole point. When a frame never arrives, the helper must be the thing that gives up
		// first — it can say which frame. The runner can only say "5000ms".
		expect(MAX_WAIT_MS, 'MPClient.next must give up inside the test budget, not after it')
			.toBeLessThan(testTimeout());
	});

	it('and no spec asks for a wait the runner would kill first', () => {
		// The four that did (60_000 in mp-join-late and mp-solo-teardown, 60_000 in mp-reconnect,
		// 30_000 in mp-heartbeat) were all dead requests under a 5 s budget. This is the check that
		// stops a fifth being written.
		const budget = testTimeout();
		const offenders: string[] = [];
		for (const f of readdirSync(UNIT).filter((n) => n.endsWith('.spec.ts'))) {
			// This file itself carries an over-budget literal ON PURPOSE — the self-check below feeds one
			// to the reader to prove it still matches. Skipping the file is narrower than teaching the
			// scanner to ignore string literals, and it cannot mask a real offender anywhere else.
			if (f === 'mp-test-budget.spec.ts') continue;
			const src = readFileSync(join(UNIT, f), 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, ' ')
				.replace(/(^|[^:])\/\/.*$/gm, '$1 ');
			// Any millisecond literal handed to a waiting helper: `next(pred, N)`, `closedWithin(N)`,
			// `never(pred, N)`.
			for (const m of src.matchAll(/\.(?:next|closedWithin|never)\s*\([^)]*?([0-9][0-9_]{3,})\s*\)/g)) {
				const ms = Number(m[1].replace(/_/g, ''));
				if (ms >= budget) offenders.push(`${f}: waits ${ms}ms, budget is ${budget}ms`);
			}
		}
		expect(offenders,
			'this wait is longer than the runner will let the test live, so it can never fire — the '
			+ 'test dies on the runner\'s opaque timeout instead, naming nothing.').toEqual([]);
	});

	it('SELF-CHECK: the scanner really reads the specs, and really sees a millisecond literal', () => {
		// Without this, a regex that had stopped matching would report "no offenders" forever — the
		// exact silent-empty-oracle failure the repo has been bitten by before.
		const files = readdirSync(UNIT).filter((n) => n.endsWith('.spec.ts'));
		expect(files.length, 'no specs found — the scan is looking in the wrong place')
			.toBeGreaterThan(50);
		const probe = `await A.next(isState, 60_000); await B.closedWithin(9000);`;
		const hits = [...probe.matchAll(/\.(?:next|closedWithin|never)\s*\([^)]*?([0-9][0-9_]{3,})\s*\)/g)]
			.map((m) => Number(m[1].replace(/_/g, '')));
		expect(hits, 'the reader must see both waits').toEqual([60_000, 9000]);
	});
});
