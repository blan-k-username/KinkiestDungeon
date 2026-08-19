/**
 * E2E — REPRODUCTIONS for the two symptoms still open after the KDM-186 fix.
 *
 * Written BEFORE any fix, per the branch's TDD rule: a symptom that cannot be reproduced by a test
 * must not be "fixed", because there is then nothing to prove the fix worked or to stop it returning.
 * Both tests below are expected to be RED when written; each says what red means.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * REPRO 1 — the co-op status overlay tells the player which keys move, and it is WRONG.
 *
 * The overlay claims "[arrows/WASD] move · [space] wait". KD binds movement through
 * `KinkyDungeonKeybindings` (defaults are a roguelike layout: KEY_RIGHT 'KeyX', KEY_LEFT 'KeyC',
 * KEY_UP 'KeyB'), and the string "ArrowRight" appears NOWHERE in the game source. So the overlay
 * sends the player pressing keys the game never listens to — which is exactly what happened in UAT
 * (2026-08-16: "I tried the keyboard, doesn't work too") and cost three wrong hypotheses.
 *
 * Asserts the overlay's claim against the GAME's own bindings, so it cannot drift again — and so the
 * fix cannot be "hardcode the right keys", which would just be a fresh copy of the same coupling.
 */
test('the co-op overlay names keys the game is actually bound to', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);
		const seen = await A.evaluate(() => {
			const el = document.getElementById('coop-overlay');
			// @ts-ignore bare let-global — the game's live binding table
			const kb = (typeof KinkyDungeonKeybindings !== 'undefined' && KinkyDungeonKeybindings) || {};
			return {
				text: (el && el.textContent) || '',
				bindings: Object.values(kb).join(',').toLowerCase(),
				waitKey: kb.Wait || null,   // the GAME's binding for "wait", whatever it currently is
			};
		});

		// 1. Every individual key the overlay NAMES must be bound by the game. "arrows" is not.
		const bound = seen.bindings.split(',');
		const claimed = (seen.text.match(/\[([^\]]+)\]/g) || []).map((s) => s.replace(/[[\]]/g, ''));
		const named = claimed.flatMap((c) => c.split('/')).map((k) => k.trim().toLowerCase());
		// EXACT membership only. A letter-wise "shorthand" allowance was tried and was worse than
		// useless: every letter of "arrows" (a,r,o,w,s) happens to be bound, so the rule green-lit the
		// exact falsehood this test exists to catch. The overlay must therefore NAME the keys it means
		// ("W/A/S/D"), which is what deriving the text from the binding table produces anyway.
		const unbound = named.filter((k) => !bound.includes(k));

		// 2. Where the overlay pairs a key with an ACTION NAME, that pairing must match the game's own
		// binding for that action — read from the live table, so a rebind cannot make the overlay lie.
		const waitClaim = /\[([^\]]+)\]\s*wait/i.exec(seen.text);
		const waitWrong = !!(waitClaim && seen.waitKey &&
			waitClaim[1].trim().toLowerCase() !== String(seen.waitKey).toLowerCase());

		expect({ unbound, waitWrong },
			`overlay text ${JSON.stringify(seen.text)}\n` +
			`names unbound keys ${JSON.stringify(unbound)}; ` +
			`claims wait=${waitClaim && waitClaim[1]} but the game binds Wait to ${seen.waitKey}\n` +
			`game bindings: ${seen.bindings}`)
			.toEqual({ unbound: [], waitWrong: false });
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 2 — one attack must produce its damage message ONCE.
 *
 * UAT (2026-08-16) reported a duplicated damage message and a duplicated cast animation after a
 * single attack. Two candidate causes, and this test does not care which:
 *   - the client's superseded-input REPLAY (KDM-186 Rule 1 v1) firing a held duplicate late — since
 *     removed, so this may already be green;
 *   - `_reconcilePeers` replaying a recorded hit through the victim's own pipeline (KDM-164), which
 *     would be pre-existing and merely invisible while nobody could act at all.
 *
 * GREEN here does NOT prove the symptom is gone — it proves this drive does not reproduce it. Said
 * plainly so a pass is not mistaken for a fix.
 */
test('a single attack logs its damage message exactly once', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);
		const session = null;   // driven through the client, as a player would

		// Put the shared enemy next to A, then bump it exactly once (one action, one turn).
		await A.evaluate(() => { /* @ts-ignore */ KinkyDungeonMessageLog = []; });
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendMove(0, 1));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout: 30_000 })
			.catch(() => { /* assertion reports */ });
		await A.waitForTimeout(1500);

		const log: string[] = await A.evaluate(() => {
			// @ts-ignore bare let-global
			return (KinkyDungeonMessageLog || []).map((m: any) => String((m && (m.text || m.str)) || m));
		});
		// Count exact repeats of any damage-ish line. Duplication is the SAME line twice in one turn.
		const counts: Record<string, number> = {};
		for (const line of log) counts[line] = (counts[line] || 0) + 1;
		const dupes = Object.entries(counts).filter(([, n]) => n > 1);

		expect(dupes, `a single action produced repeated log lines: ${JSON.stringify(dupes)}\n` +
			`full log: ${JSON.stringify(log)}`).toEqual([]);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 3 — floating combat text must not ACCUMULATE across turns (KDM-186, UAT round 3).
 *
 * Reported with screenshots: after PvP attacks, B's screen fills with dozens of stacked
 * "16 Arcane dmg" floaters and persistent ripple animations — "more and more with each attack" —
 * while the underlying game state is correct. So this is a PRESENTATION lifecycle bug, not a
 * gameplay one, and the earlier "duplicated damage message" report is the same thing.
 *
 * Two candidate mechanisms, and this test deliberately distinguishes neither — it only pins the
 * observable, so whichever it is cannot regress silently:
 *   (a) floaters are CREATED more than once per event, because a one-shot EVENT is delivered inside
 *       an idempotent STATE snapshot and replayed on every re-apply;
 *   (b) floaters are never AGED OUT, because ageing is driven by draw delta and the thin client
 *       blocks the game's time advance (`disableLocalSim`) — visual decay is not simulation, but the
 *       block does not distinguish. `KinkyDungeonFloaters` is also excluded from capture with the
 *       comment "already managed per-player by swap-session", which grep shows is FALSE: nothing in
 *       the MP layer touches it.
 *
 * The assertion is on GROWTH, not on an absolute count: a few floaters are correct, an unbounded
 * queue is the bug.
 */

/**
 * REPRO 3 (v2) — floating combat text must not ACCUMULATE across PvP attacks (KDM-186, UAT round 3).
 *
 * Reported with screenshots: after PvP attacks, B's screen fills with dozens of stacked
 * "16 Arcane dmg" floaters and ripple animations that never clear — "more and more with each attack"
 * — while the game state is correct. A presentation-lifecycle bug, not a gameplay one; the earlier
 * "duplicated damage message" report is the same thing.
 *
 * ⚠️ v1 OF THIS TEST WAS VACUOUS AND PASSED. It drove six `wait` turns, so no floater was ever
 * created and "growth < 20" was trivially true. A test whose precondition never fires proves
 * nothing — so v2 attacks for real AND asserts that floaters actually appeared before judging
 * whether they drain.
 *
 * Two candidate mechanisms; the test pins the OBSERVABLE and distinguishes neither, so whichever it
 * is cannot regress silently:
 *   (a) created more than once — a one-shot EVENT delivered inside an idempotent STATE snapshot and
 *       replayed on every re-apply;
 *   (b) never aged out — floaters age by DRAW DELTA, and the thin client blocks the game's time
 *       advance (`disableLocalSim`); visual decay is not simulation, but the block cannot tell them
 *       apart. (Game-side quirk: only the first `max = 40` are aged per frame, so a backlog past 40
 *       can never drain.) Note `KinkyDungeonFloaters` is excluded from capture with the comment
 *       "already managed per-player by swap-session", which grep shows is FALSE — nothing touches it.
 */
test('floating combat text does not accumulate across PvP attacks', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';                       // peers hostile ⇒ the real PvP damage path
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const floaters = (P: typeof A) => P.evaluate(() =>
		// @ts-ignore bare let-global
		(typeof KinkyDungeonFloaters !== 'undefined' && KinkyDungeonFloaters) ? KinkyDungeonFloaters.length : -1);

	try {
		await bootCoopPair(A, B, port);
		const before = await floaters(B);
		let peak = before;

		// B attacks A for real, several times — the exact drive the UAT screenshots came from.
		for (let i = 0; i < 5; i++) {
			const peer = await waitForPeerAvatar(B);
			if (!peer) break;
			await B.evaluate((p) => (window as any).__coop.sendAction(
				{ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick !== p, t0, { timeout: 20_000 })
				.catch(() => { /* count is what matters */ });
			peak = Math.max(peak, await floaters(B));
		}

		// PRECONDITION — if no floater ever appeared, this test is measuring nothing (v1's mistake).
		expect(peak, 'no floating text was ever produced — the drive does not exercise the reported ' +
			'path, so any pass below would be vacuous').toBeGreaterThan(0);

		// Now the real question: do they DRAIN? Transient visuals must expire, not pile up.
		await B.waitForTimeout(4000);
		const settled = await floaters(B);
		expect(settled, `floating text peaked at ${peak} and settled at ${settled} — transient visuals ` +
			`are accumulating rather than expiring (started at ${before})`).toBeLessThan(Math.max(10, peak));
	} finally {
		delete process.env.KD_PVP;
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 4 — applying the SAME state snapshot twice must not produce two visual effects.
 *
 * This is the invariant the UAT pile-up implies, stated so it does not depend on frame rate.
 *
 * Why the frame rate matters: the owner's browser runs at ~95 fps and receives many snapshots per
 * second (measured 268 KB/s while moving the mouse), so a floater spawned per re-apply stacks up
 * visibly. This harness renders at ~4 fps — ~20x fewer applies — which is why REPRO 3 passes here
 * while the screenshots clearly show accumulation. A test that can only fail on fast hardware is not
 * a test, so this one drives the applies DIRECTLY instead of waiting for frames.
 *
 * THE PRINCIPLE: a snapshot is STATE, and state is idempotent — re-applying it must converge, not
 * accumulate. One-shot EVENTS (a damage floater, a cast animation, a log line) do not belong inside
 * it: they must be delivered once, or carry a sequence the client can de-duplicate. This assertion
 * is generic — it names no effect, no input and no game feature, only the idempotence contract.
 */
test('re-applying an identical snapshot is idempotent (no effect is replayed)', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// Land one real PvP hit so the snapshot in flight carries a combat effect.
		// KDM-210: waits for the avatar instead of reading-then-asserting. The null check that used
		// to follow is retired — it can no longer fail, because the helper throws a named error first.
		const peer = await waitForPeerAvatar(B, { label: 'B sees no peer avatar — cannot exercise the combat-effect path' });
		const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate((p) => (window as any).__coop.sendAction(
			{ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick !== p, t0, { timeout: 20_000 })
			.catch(() => { /* the applies below are the measurement */ });

		// Re-apply the LAST snapshot the client received, 20 times, with no new server traffic.
		// Nothing about the world changed, so nothing new may appear on screen.
		const grew = await B.evaluate(() => {
			const w = window as any;
			const snap = w.__coop && w.__coop._lastSnapshot;
			if (!snap) return { skipped: true, before: 0, after: 0 };
			// @ts-ignore bare let-global
			const before = (KinkyDungeonFloaters || []).length;
			for (let i = 0; i < 20; i++) w.KDRenderClient.apply(snap);
			// @ts-ignore bare let-global
			return { skipped: false, before, after: (KinkyDungeonFloaters || []).length };
		});

		expect(grew.skipped, 'the client kept no snapshot to re-apply — test cannot measure').toBe(false);
		expect(grew.after, `re-applying one unchanged snapshot 20x grew the floater queue from ` +
			`${grew.before} to ${grew.after}: state application is NOT idempotent, so every snapshot ` +
			`replays one-shot effects. At ~95 fps this is the UAT pile-up.`).toBeLessThanOrEqual(grew.before);
	} finally {
		delete process.env.KD_PVP;
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 5 — the floater queue must DRAIN when nothing is creating floaters (KDM-186).
 *
 * MEASURED IN THE OWNER'S BROWSER (2026-08-16 HUD): `floaters 0/s   q=84`.
 * Creation rate ZERO, queue depth 84 and holding. So the pile-up is not duplicate CREATION — each
 * floater is made once, for a real event — it is that transient visuals NEVER EXPIRE on the thin
 * client. That measurement is what killed the "one-shot events replayed inside idempotent state"
 * hypothesis; do not resurrect it without new evidence.
 *
 * Mechanism: floaters age inside the DRAW path (`floater.t += floatermult * delta/1000`, and only
 * the first `max = 40` are aged per frame). The thin client disables local simulation, and whatever
 * that suppresses also stops the ageing — visual decay is not simulation, but the block cannot tell
 * them apart.
 *
 * ⚠️ WHY THIS ASSERTION IS STRICT. REPRO 3 v2 asserted `settled < max(10, peak)`, which passes
 * trivially whenever the peak is small — it never tested draining at all. A lenient matcher that
 * passes the bug it was written for is worse than no test; this one requires the queue to actually
 * come back DOWN.
 */
test('the floater queue drains once nothing is creating floaters', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const q = () => B.evaluate(() =>
		// @ts-ignore bare let-global
		(typeof KinkyDungeonFloaters !== 'undefined' && KinkyDungeonFloaters) ? KinkyDungeonFloaters.length : -1);

	try {
		await bootCoopPair(A, B, port);

		// Make floaters the way the game does — many, so the queue is unmistakably non-empty.
		await B.evaluate(() => {
			// @ts-ignore bare let-global — the game's own single creation point
			const p = KinkyDungeonPlayerEntity;
			for (let i = 0; i < 60; i++) {
				// @ts-ignore
				KinkyDungeonSendFloater(p, 16, '#ff5555');
			}
		});
		const peak = await q();
		expect(peak, 'no floaters were created — nothing to measure').toBeGreaterThan(30);

		// Nothing creates floaters from here on. They are transient: they MUST expire.
		await B.waitForTimeout(6000);
		const settled = await q();

		expect(settled, `the floater queue went ${peak} -> ${settled} with NOTHING creating floaters ` +
			`for 6s. Transient visuals never expire on the thin client, so they pile up forever ` +
			`(owner's UAT: 0/s created, q=84 and holding).`).toBeLessThan(peak / 2);
	} finally {
		delete process.env.KD_PVP;
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 6 — a snapshot delivered AFTER a combat event must not re-create that event's visuals.
 *
 * THE OWNER'S TRIGGER, measured 2026-08-16/17: the floater queue "grows only when the window is in
 * focus and I move the mouse in the game zone", and drains to 0 the moment snapshots stop arriving
 * (menu open / idle). Mouse movement changes the stored move direction, so the server sees state
 * CHANGE and sends a full snapshot — and each delivered snapshot spawns another copy of the last
 * combat event's floater. Hence `0/s` while idle and an ever-growing `q` while the mouse moves.
 *
 * This is the same defect the epic keeps circling: the proxy puts ONE-SHOT EVENTS on the same wire
 * as IDEMPOTENT STATE. Re-applying state must converge; re-applying an event duplicates it.
 *
 * Earlier attempts and why they missed it (do not repeat them):
 *   REPRO 3 — played turns; harness runs ~4 fps vs the browser's ~95, ~20x fewer snapshots.
 *   REPRO 4 — re-applied the SAME snapshot; by then it no longer carried the effect.
 *   REPRO 5 — proved the queue DOES drain when nothing arrives, which is the other half of the story.
 * The drive below is the owner's: land a hit, then deliver snapshots by moving, and count.
 */
test('snapshots delivered after a hit do not re-create its floaters', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	process.env.KD_PVP = '1';
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const q = () => B.evaluate(() =>
		// @ts-ignore bare let-global
		(typeof KinkyDungeonFloaters !== 'undefined' && KinkyDungeonFloaters) ? KinkyDungeonFloaters.length : -1);

	try {
		await bootCoopPair(A, B, port);

		// 1. Land one real PvP hit, so there is a combat event to be replayed.
		// KDM-210: waits for the avatar instead of reading-then-asserting. The null check that used
		// to follow is retired — it can no longer fail, because the helper throws a named error first.
		const peer = await waitForPeerAvatar(B, { label: 'B sees no peer avatar — cannot land a PvP hit' });
		const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate((p) => (window as any).__coop.sendAction(
			{ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick !== p, t0, { timeout: 20_000 })
			.catch(() => { /* the count below is the measurement */ });
		const afterHit = await q();

		// 2. Now just "move the mouse": each distinct direction is a state change, so each one brings
		//    back a full snapshot. No new combat happens — nothing new may appear on screen.
		const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
		for (let round = 0; round < 4; round++) {
			for (const [x, y] of dirs) {
				await B.evaluate((d) => (window as any).__coop.sendAction(
					{ kdType: 'setMoveDirection', data: { dir: { x: d[0], y: d[1] }, delta: 1 } }), [x, y]);
			}
			await B.waitForTimeout(150);
		}
		await B.waitForTimeout(500);
		const afterMoving = await q();

		// The fix must not pass by DELETING the feedback: a landed hit still has to show its number.
		expect(afterHit, 'the hit produced no floater at all — a fix that removes the damage feedback ' +
			'would satisfy the growth assertion below while making the game worse').toBeGreaterThan(0);
		const who = await B.evaluate(() => (window as any).__coopFloaters ? (window as any).__coopFloaters.report() : 'no tracer');
		expect(afterMoving, `the floater queue went ${afterHit} -> ${afterMoving} from MOUSE MOVEMENT ` +
			`\nFLOATER SOURCE: ${who}\n` +
			`alone, with no new combat: each delivered snapshot replays the last event's visuals. ` +
			`One-shot events are riding inside idempotent state.`).toBeLessThanOrEqual(afterHit);
	} finally {
		delete process.env.KD_PVP;
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 7 — the move reticule must FOLLOW THE MOUSE (KDM-186, UAT round 4).
 *
 * Reported: "the red square (mouse hover of the next move) is stuck and doesn't rely on the mouse
 * position."
 *
 * `setMoveDirection` sets `KinkyDungeonMoveDirection`, and KD's draw loop emits it every frame — a
 * STREAM. Rule 1 v2 dropped superseded sends, which loses a stream's TAIL: whatever the mouse settles
 * on is exactly the update most likely discarded, so the reticule froze on the first delivered value.
 * (Reproduced: reticule {1,0} while the last direction sent was {-1,1}.) v3 keeps the newest and
 * sends it when the slot frees, so a stream converges; commands are still never sampled.
 *
 * ⚠️ THE FIRST VERSION OF THIS TEST WAS INVALID. It sent its own burst of directions and asserted the
 * reticule equalled the last one — but the GAME emits the real mouse direction every frame, so the
 * test was racing the very stream it measured. The give-away was the observed value carrying
 * `delta: 1.5`, which the test never sends. Drive the real mouse instead and assert it TRACKS.
 */
test('the move reticule follows the mouse', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const dir = () => A.evaluate(() =>
		// @ts-ignore bare let-global — the reticule the player actually sees
		(typeof KinkyDungeonMoveDirection !== 'undefined' && KinkyDungeonMoveDirection)
			? { x: KinkyDungeonMoveDirection.x, y: KinkyDungeonMoveDirection.y } : null);

	try {
		await bootCoopPair(A, B, port);
		const box = await A.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

		// Park the mouse well to one side, let the stream settle, and read the reticule.
		await A.mouse.move(Math.round(box.w * 0.2), Math.round(box.h * 0.5));
		await A.waitForTimeout(2500);
		const left = await dir();

		// Now the opposite side. A reticule that tracks the mouse MUST report a different direction.
		await A.mouse.move(Math.round(box.w * 0.8), Math.round(box.h * 0.5));
		await A.waitForTimeout(2500);
		const right = await dir();

		expect(left, 'no reticule direction at all — cannot tell whether it tracks').not.toBeNull();
		expect(JSON.stringify(right) !== JSON.stringify(left),
			`the reticule read ${JSON.stringify(left)} with the mouse on the LEFT and ` +
			`${JSON.stringify(right)} on the RIGHT — it is not following the mouse.`).toBe(true);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});

/**
 * REPRO 8 — a presentation input must round-trip fast enough to feel immediate (KDM-186, UAT r4).
 *
 * Reported: the move reticule "follows, but with delay, ~half a second" at ~100 fps. That is not a
 * sampling problem (Rule 1 v3 already converges on the newest value) — it is the COST of the round
 * trip itself. Every direction update runs a full server transaction:
 *
 *     restorePlayer → applyInputObserved → capturePlayer → fingerprint(JSON.stringify) → park
 *
 * At ~100 updates/s the server completes only a few, so the newest value waits behind the queue.
 * The client's own telemetry measured it: round-trips of 557 ms, 533 ms, 4854 ms.
 *
 * RATE-INDEPENDENT ON PURPOSE. Five earlier tests in this file failed to discriminate because the
 * harness renders at ~4 fps against a real browser's ~95 — anything whose trigger is input RATE
 * cannot be reproduced here by playing. Latency is not rate-dependent: one input, one measurement.
 *
 * ── THE ORACLE IS IN FRAMES, NOT MILLISECONDS (KDM-214) ────────────────────────────────────────
 * This test asserted `median < 120 ms` and was red at 716–755 ms. That budget was the WRONG UNIT,
 * and [[KDM-206]] proved it while investigating this exact number: server CPU per transaction is
 * ~22 ms, which cannot produce a ~750 ms median, and the samples are quantised in ~250 ms steps
 * (clusters ~245 / ~550 / ~750 / ~950) that match the ~227 ms client frame period [[KDM-205]]
 * measured (`coopFps 4.4`). The page is single-threaded: a reply cannot be dispatched into a draw
 * loop that is mid-frame, so the round-trip is CLIENT-FRAME-BOUND, not payload-bound. 120 ms of
 * wall clock is below one frame of this harness — it asserted the headless frame rate, which is not
 * this layer's to meet, and which the product's ~95 fps browser does not share.
 *
 * So the round-trip is expressed in CLIENT FRAME PERIODS, measured in the SAME run from the same
 * telemetry. That asserts what this layer actually controls — "the transaction is not the
 * bottleneck; it costs a small, bounded number of frames" — and it survives a slower or busier host,
 * because a host that halves the frame rate also halves the budget's unit.
 *
 * A frames-only oracle would however be self-cancelling against a payload regression, which slows the
 * client too and so inflates the very unit the budget is denominated in. The wire cost of the same
 * window is therefore asserted directly alongside it — in reply KINDS and in bytes, both
 * frame-rate-independent by construction. See the payload guard below for what that does and does
 * not cover; the short version is that these inputs move no state, so this window guards KDM-186's
 * "state on CHANGE, not on input" rule, not KDM-206's delta encoding.
 */
test('a presentation input round-trips quickly', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);
		await A.evaluate(() => (window as any).__coopDiag.reset());

		// A handful of DISTINCT direction updates, spaced so each is answered before the next —
		// this measures the cost of one transaction, not queue backlog.
		for (const [x, y] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1]]) {
			await A.evaluate((d) => (window as any).__coop.sendAction(
				{ kdType: 'setMoveDirection', data: { dir: { x: d[0], y: d[1] }, delta: 1 } }), [x, y]);
			await A.waitForTimeout(400);
		}

		/**
		 * TWO READS, ON PURPOSE — they want different windows, and conflating them was wrong in both
		 * directions before this was measured (KDM-214):
		 *
		 *   LATENCY is read at the end of the send loop, because KD's draw loop keeps emitting chatter
		 *   while we wait. Every extra second of waiting deepens the queue those samples are drawn
		 *   from, so a long settle does not measure the round-trip more accurately — it measures a
		 *   backlog we created by waiting. Reading here moved the median from ~5 frame periods back to
		 *   ~3, which is the transaction this test is about.
		 *
		 *   WIRE COST is read after a full settle, because at a ~250 ms frame period a round-trip
		 *   outlives the 400 ms slot that launched it: when the loop ends, the replies to the last
		 *   sends — and their bytes — are still in flight. Reading it at the loop end reported ~0 B
		 *   while full snapshots were crossing the wire, a measurement bug that made the guard vacuous.
		 *
		 * The frame period comes from the LATENCY window, so the unit and the thing it measures are
		 * the same seconds.
		 */
		const readWindow = (page: typeof A) => page.evaluate(() => {
			const d = JSON.parse((window as any).__coopDiag.dump());
			const rolls = d.rollups || [];
			const sum = (f: (r: any) => number) => rolls.reduce((s: number, r: any) => s + (f(r) || 0), 0);
			const ms = (d.recentInputs || []).map((r: any) => r.ms).filter((n: number) => n >= 0).sort((a: number, b: number) => a - b);
			return {
				seconds: rolls.length,
				frames: sum((r) => r.frames),
				bytes: sum((r) => r.recvBytes),
				// Every reply kind counts — 'ui', 'turn' and 'ack' alike. Naming them would make the
				// measurement go quiet the day a fourth kind is added, which is the failure mode this
				// whole epic exists to avoid.
				replies: sum((r) => Object.keys(r.recv || {}).reduce((a, k) => a + r.recv[k], 0)),
				byKind: rolls.reduce((acc: any, r: any) => {
					for (const k of Object.keys(r.recv || {})) acc[k] = (acc[k] || 0) + r.recv[k];
					return acc;
				}, {}),
				samples: ms,
				median: ms.length ? ms[Math.floor(ms.length / 2)] : -1,
			};
		});

		await A.waitForTimeout(600);      // just enough for the loop's own last reply
		const lat = await readWindow(A);
		await A.waitForTimeout(2500);     // now let every reply drain, so the bytes are all counted
		const win = await readWindow(A);

		// No frames observed would make the unit meaningless — fail loudly rather than divide by zero.
		expect(lat.frames, `no client frames were observed in ${lat.seconds}s — the frame period, ` +
			`which is this assertion's unit, could not be measured. ${JSON.stringify({ ...lat, samples: undefined })}`)
			.toBeGreaterThan(0);
		const framePeriod = (lat.seconds * 1000) / lat.frames;
		const inFrames = lat.median / framePeriod;

		// Printed on green too: these are the numbers that justify the unit, and the next person to
		// question this budget should not have to re-instrument the spec to see them (KDM-214).
		console.log(`[KDM-214] round-trip median ${lat.median} ms = ${inFrames.toFixed(2)} client ` +
			`frames (period ${framePeriod.toFixed(0)} ms from ${lat.frames} frames / ${lat.seconds}s); ` +
			`${win.bytes} B over ${win.replies} replies ${JSON.stringify(win.byKind)}; samples ${JSON.stringify(lat.samples)}`);

		// MEASURED, not guessed. A green run reports the samples sitting on a clean staircase of 1–5
		// frame periods (296 / 636 / 913 / 1163 / 1425 ms at a 300 ms period) with the median at ~3.2 —
		// one frame to dispatch the send, the server's turn, one to dispatch the reply, and whatever
		// chatter KD's own draw loop has queued ahead of it. Six frames is above that staircase and
		// below anything the staircase no longer explains, so this goes red when the round-trip stops
		// being a small multiple of the frame period, not when the host has one bad second. The payload
		// regression this test guards is caught in BYTES below, which is why this budget does not have
		// to be tight to be meaningful.
		const BUDGET_FRAMES = 6;
		expect(inFrames, `a presentation input takes ${lat.median} ms to round-trip = ` +
			`${inFrames.toFixed(2)} client frame periods (frame period ${framePeriod.toFixed(0)} ms, ` +
			`measured in this same run). Samples ${JSON.stringify(lat.samples)}. The transaction is ` +
			`no longer merely frame-bound — it has acquired a cost of its own. See KDM-205/206/214 ` +
			`for why this is asserted in frames and not in wall-clock ms.`)
			.toBeLessThan(BUDGET_FRAMES);

		// THE PAYLOAD GUARD — and the assertion that carries this test's regression duty, since the
		// frames budget above cannot. That is measured, not assumed: forcing `_stateFrame` to answer
		// with full snapshots (KDM-214) put the round-trip at 6.4 frames on one attempt and 5.9 —
		// green — on the retry, because a payload blow-up slows the CLIENT too and inflates the very
		// frame period the budget is denominated in. A frames-only oracle partly cancels the
		// regression out. Bytes and reply KINDS do not cancel.
		//
		// WHAT THIS WINDOW ACTUALLY EXERCISES (KDM-214, measured — this was assumed wrong twice). Almost
		// every reply here is a bare `ack`: KD's draw loop emits a direction every frame, those move no
		// captured state, and KDM-186 RULE 2 answers an input that changed nothing with an ack. Measured
		// `{"ui":2,"turn":0,"ack":19}` and `{"ui":4,"turn":0,"ack":37}` — and `{"ui":0,...,"ack":20}` on
		// runs where the client's supersede rule swallowed all five deliberate updates. So `_stateFrame`
		// — and with it KDM-206's delta encoding — is barely reached on this path, and a delta-encoding
		// regression is NOT reliably visible here. It has a guard of its own in
		// `tests/unit/mp-delta-codec.spec.ts` (38.1 KB -> 115 B); this is not that guard, and pretending
		// otherwise would be a vacuous assertion that can only ever pass.
		//
		// What this window CAN guard is Rule 2 itself, which is the invariant that made this path cheap
		// in the first place: KD's draw loop emits an input every frame, and answering each with state
		// cost ~40 KB × ~100/s × 2 clients — 809 MB of egress, one core pegged, and lockstep never
		// completing. Both halves are asserted, because either alone has a hole: the KIND (an input
		// that changed nothing must not be answered with a state frame) catches Rule 2 coming undone
		// even if the reply is a cheap delta, and the BYTES catch a reply growing regardless of how it
		// is labelled.
		expect(win.replies, `no replies were observed in ${win.seconds}s, so the per-reply wire cost ` +
			`could not be measured. ${JSON.stringify({ ...win, samples: undefined })}`).toBeGreaterThan(0);

		// Stated as a SHARE, not as zero. Zero was tried and is wrong: the five deliberate direction
		// updates DO move state and legitimately earn a state frame, so a pristine tree scores 0–4 of
		// ~20–40 replies (0–10%) purely on which of them survive the client's supersede rule. The
		// regression is categorical, not marginal — with Rule 2 undone EVERY reply carries state, and
		// the mutation measured 15/15 and 42/42 (100%). Half separates 10% from 100% with room on both
		// sides, and does not depend on how much chatter the window happened to catch.
		const stateShare = (win.byKind.ui || 0) / win.replies;
		expect(stateShare, `${win.byKind.ui || 0} of ${win.replies} presentation inputs were answered ` +
			`with a STATE frame (${JSON.stringify(win.byKind)}) — ${(stateShare * 100).toFixed(0)}%. ` +
			`KD's draw loop emits an input every frame and almost none of them move state, so almost ` +
			`all of these must be bare acks: KDM-186 RULE 2, "state on CHANGE, not on input". ` +
			`State-per-input is what pegged the server and stalled lockstep entirely.`)
			.toBeLessThan(0.5);

		const bytesPerReply = win.bytes / win.replies;
		expect(bytesPerReply, `each reply to a presentation input carries ` +
			`${Math.round(bytesPerReply)} B (${win.bytes} B over ${win.replies} replies, ` +
			`${JSON.stringify(win.byKind)}) — this window measures ~110 B/reply green, and ~40 KB was ` +
			`the pre-KDM-186 cost of answering every input with a full snapshot. A reply this size ` +
			`means state is riding along with the chatter again.`)
			.toBeLessThan(2000);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
