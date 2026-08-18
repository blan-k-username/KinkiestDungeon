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

		const lat = await A.evaluate(() => {
			const d = JSON.parse((window as any).__coopDiag.dump());
			const ms = (d.recentInputs || []).map((r: any) => r.ms).filter((n: number) => n >= 0).sort((a: number, b: number) => a - b);
			return { samples: ms, median: ms.length ? ms[Math.floor(ms.length / 2)] : -1 };
		});

		expect(lat.median, `a presentation input takes ${lat.median} ms to round-trip ` +
			`(samples ${JSON.stringify(lat.samples)}). At ~100 updates/s that is what makes the move ` +
			`reticule lag ~half a second behind the mouse.`).toBeLessThan(120);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
