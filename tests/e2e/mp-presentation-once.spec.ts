/**
 * KDM-196 — in a REAL browser: presentation output is drawn once per game event, not once per snapshot.
 *
 * UAT: *"when I move my mouse very often over Player A (on Player B's screen), I see spam of sound echo
 * animation."* Spam that scales with the SNAPSHOT RATE and not with game events is the signature of
 * one-shot presentation output being replicated as ordinary state — KDM-186's root pattern.
 *
 * The node spec (tests/unit/mp-presentation-once.spec.ts) proves the SERVER no longer replicates the
 * queues and delivers them as sequenced events instead. It proves nothing about the browser, which is
 * where the duplication was actually SEEN, and where the second half of the bug lives:
 *
 *  - `KDEventData.shockwaves` / `.sounddesc` — the ripple and the sound echo. Re-installed by
 *    `adoptBundle` on every snapshot, re-drawn by `afterDrawFrame` every time.
 *  - `KinkyDungeonPlayerEntity.visual_stamina` / `visual_mana` — the SP/MP bar's easing accumulator.
 *    The headless server has no draw loop, so its capture has no such field, and `adoptBundle`'s
 *    wholesale object replace DELETED the client's. The draw then re-seeds from `…StaminaMax` and
 *    eases down again: the drain animation replays once per snapshot.
 *
 * MECHANISM, not timing: re-applying the SAME snapshot is exactly what a moving mouse produced, and a
 * synchronous `evaluate` runs no animation frame in between — so the counts below are deterministic.
 *
 * ⚠️ The anti-deletion assertion is load-bearing: "no duplicates" must not be reachable by drawing
 * nothing at all (the trap KDM-186's REPRO 3 v1 fell into).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('KDM-196: ripples draw once per event, and the SP bar keeps its animation', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	// Both players wait: the world still ticks, and the ripples under test come from the ENEMY-noise
	// path (a sound the player hears but cannot see), not from the player's own movement. A move can
	// be blocked by a wall and then never advances the turn at all.
	const advance = async () => {
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick > p, t0, { timeout: 60_000 });
	};

	try {
		await bootCoopPair(A, B, port);

		// Instrument A: keep the last snapshot, and measure how many ripples each apply ADDS to the
		// game's own draw queue. Wrapping apply() rather than the draw keeps this on the seam the bug
		// was on, and needs no access to PIXI.
		await A.evaluate(() => {
			const w = window as any;
			const rc = w.KDRenderClient;
			const orig = rc.apply.bind(rc);
			w.__p196 = { last: null, addedByRealSnapshots: 0 };
			rc.apply = function (s: any) {
				// @ts-ignore — bundle `let`, resolved up the scope chain
				const before = (typeof KDEventData !== 'undefined' && KDEventData && KDEventData.shockwaves)
					? KDEventData.shockwaves.length : 0;
				const r = orig(s);
				// @ts-ignore
				const after = (typeof KDEventData !== 'undefined' && KDEventData && KDEventData.shockwaves)
					? KDEventData.shockwaves.length : 0;
				w.__p196.addedByRealSnapshots += Math.max(0, after - before);
				w.__p196.last = s;
				return r;
			};
		});

		// Real turns until the world actually produces an off-screen noise (it is a random enemy
		// behaviour, so drive turns until one lands rather than assuming a fixed count does it).
		let delivered = 0;
		for (let i = 0; i < 24 && delivered === 0; i++) {
			await advance();
			delivered = await A.evaluate(() => (window as any).__p196.addedByRealSnapshots);
		}

		// ---- ANTI-DELETION (assert FIRST): the ripples still reach the screen.
		expect(delivered, 'real snapshots must still queue ripples — otherwise the assertions below are vacuous')
			.toBeGreaterThan(0);

		// ---- NO DUPLICATION: re-applying the SAME snapshot (what a moving mouse produced) adds none.
		const addedByRepeats = await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore
			const before = (KDEventData && KDEventData.shockwaves) ? KDEventData.shockwaves.length : 0;
			for (let i = 0; i < 6; i++) w.KDRenderClient.apply(w.__p196.last);
			// @ts-ignore
			const after = (KDEventData && KDEventData.shockwaves) ? KDEventData.shockwaves.length : 0;
			return after - before;
		});
		expect(addedByRepeats, 'six snapshots with no game event must draw no new ripple').toBe(0);

		// ---- The sound echo must not be re-armed either: re-applying must not reset its timers back
		// into the past, which is what made it fire on every snapshot.
		const echoRearmed = await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore
			const list = (KDEventData && KDEventData.sounddesc) ? KDEventData.sounddesc : [];
			const stamps = list.map((sd: any) => sd.lastShockwave);
			for (let i = 0; i < 6; i++) w.KDRenderClient.apply(w.__p196.last);
			// @ts-ignore
			const after = (KDEventData && KDEventData.sounddesc) ? KDEventData.sounddesc : [];
			if (after.length !== stamps.length) return 'length changed';
			for (let i = 0; i < after.length; i++) if (after[i].lastShockwave !== stamps[i]) return 'timer reset';
			return 'stable';
		});
		expect(echoRearmed).toBe('stable');

		// ---- The SP/MP bar's easing accumulator is CLIENT-owned and must survive a snapshot.
		const survived = await A.evaluate(() => {
			const w = window as any;
			// @ts-ignore
			KinkyDungeonPlayerEntity.visual_stamina = 42.5;
			// @ts-ignore
			KinkyDungeonPlayerEntity.visual_mana = 17.25;
			w.KDRenderClient.apply(w.__p196.last);
			// @ts-ignore
			return { st: KinkyDungeonPlayerEntity.visual_stamina, mp: KinkyDungeonPlayerEntity.visual_mana };
		});
		// Was: both `undefined` after every snapshot, so the draw re-seeded from max and re-ran the
		// whole drain animation — the duplicated SP drain from UAT.
		expect(survived.st, 'visual_stamina must not be wiped by adopting a bundle').toBe(42.5);
		expect(survived.mp, 'visual_mana must not be wiped by adopting a bundle').toBe(17.25);

		// The game must still be alive after all that (no crash handler, KD invariant).
		expect(await A.evaluate(() => (window as any).__coop.started)).toBe(true);
		expect(bridge.session.started).toBe(true);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});
