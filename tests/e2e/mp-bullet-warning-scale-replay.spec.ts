/**
 * In a REAL browser: an AOE warning tile's grow-in overlay must not replay on mouse movement alone.
 *
 * UAT: "the rope trap animation and affected cells are replayed again and again on my mouse
 * movements." Expected: the tile overlay grows in once when the trap/spell fires and lasts only as
 * long as the game's own effect; moving the mouse changes neither.
 *
 * The node spec (tests/unit/mp-bullet-warning-scale-replay.spec.ts) proves `KDRenderClient.apply()`
 * itself does not regress an already-eased `KDGameData.BulletWarnings[].scale`. This proves the same
 * thing in a REAL browser, over the REAL coop wire, with REAL `page.mouse` moves — the layer the owner
 * actually saw the bug on.
 *
 * The trigger is forced directly on the world (`bridge.session.world.eval`), same technique
 * `mp-presentation-once.spec.ts` uses for its enemy-noise trigger: a real cast is a long, RNG-gated
 * setup for exercising the SAME code path (`KinkyDungeonUpdateBullets`'s warning-tile push,
 * `KinkyDungeonFight.ts` ~2124) a rope trap or any other aoe spell already goes through.
 *
 * MECHANISM, not timing: the browser's own draw loop easing `scale` toward 1 is simulated directly
 * (same technique `mp-presentation-once.spec.ts` uses for the SP/MP bar's `visual_stamina`), so the
 * assertion is deterministic rather than frame-rate-dependent.
 *
 * ⚠️ The CONTROL assertion is load-bearing: the tile must actually be shown on the triggering reply,
 * or "no replay" below would be trivially true because nothing is ever presented at all.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, captureCoopWire, readCoopWire, MP_TEST_TIMEOUT } from './helpers/coop';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const pos = (P: any) => P.evaluate(() => ({
	// @ts-ignore bare let-globals
	x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y,
}));

test('an AOE warning tile\'s grow-in does not replay on mouse movement alone', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	try {
		await bootCoopPair(A, B, port);

		// Instrument A: count every REGRESSION of an already-eased warning tile's `scale` across an
		// apply() — the replay signature. Count occurrences, not samples (reference_decaying_queue_oracle):
		// a single post-hoc read of `scale` could get lucky and land between regressions.
		await A.evaluate(() => {
			const w = window as any;
			const rc = w.KDRenderClient;
			const orig = rc.apply.bind(rc);
			w.__kdm319 = { regressions: 0, applies: 0 };
			rc.apply = function (s: any) {
				const before: Record<string, number> = {};
				// @ts-ignore bare let-global
				if (typeof KDGameData !== 'undefined' && KDGameData && Array.isArray(KDGameData.BulletWarnings)) {
					// @ts-ignore
					for (const t of KDGameData.BulletWarnings) {
						if (t && t.scale !== undefined) before[t.x + ',' + t.y] = t.scale;
					}
				}
				const r = orig(s);
				w.__kdm319.applies++;
				// @ts-ignore
				if (typeof KDGameData !== 'undefined' && KDGameData && Array.isArray(KDGameData.BulletWarnings)) {
					// @ts-ignore
					for (const t of KDGameData.BulletWarnings) {
						if (t && t.scale !== undefined) {
							const key = t.x + ',' + t.y;
							if (before[key] !== undefined && t.scale < before[key]) w.__kdm319.regressions++;
						}
					}
				}
				return r;
			};
		});

		const p = await pos(A);
		const tileX = p.x + 1;
		const tileY = p.y;

		// Trigger the AOE warning exactly as a rope trap's `TrapRope*` spell would push one
		// (`KinkyDungeonUpdateBullets`, aoe branch): one tile next to A, at its creation-time scale 0.
		//
		// Pushed onto A's own CAPTURED bundle (`SwapSession.bundles`, not `world.eval` on the live
		// world directly): `BulletWarnings` is not a declared world key, so A's next action — even a
		// UI-only hover — restores A's bundle into the world slot FIRST (`_restorePlayer`), which would
		// silently overwrite a trigger written onto the live world with A's own last-captured (empty)
		// copy before any snapshot is ever taken. Writing it into the bundle itself is what a real
		// trap turn would have left behind.
		const s = bridge.session;
		const bundle = s.bundles.get('A');
		expect(bundle, 'precondition: A has a captured bundle to trigger the warning on').toBeTruthy();
		bundle.gameData.BulletWarnings = bundle.gameData.BulletWarnings || [];
		bundle.gameData.BulletWarnings.push({ x: tileX, y: tileY, x_orig: tileX, y_orig: tileY, scale: 0, color: '#ff0000' });

		// CONTROL: a real mouse move picks up the freshly-triggered tile, at its trigger-time scale.
		// Polled, not a single timed read: it takes one real round trip for the hover to reach the
		// server and the reply to apply(), and a single move is not guaranteed to be the one that does
		// it (boot settling, scheduling). Several distinct positions give KD's own mousemove listener
		// something to actually notice as a direction change.
		const readTriggerScale = () => A.evaluate((tile) => {
			// @ts-ignore
			const t = (KDGameData.BulletWarnings || []).find((w: any) => w.x === tile.x && w.y === tile.y);
			return t ? t.scale : undefined;
		}, { x: tileX, y: tileY });
		let triggerScale: number | undefined;
		await expect.poll(async () => {
			await A.mouse.move(140 + Math.random() * 20, 140 + Math.random() * 20);
			triggerScale = await readTriggerScale();
			return triggerScale;
		}, { timeout: 15_000, message: 'control: the warning tile must reach the client within a few real round trips' })
			.not.toBeUndefined();
		expect(triggerScale, 'control: the warning tile really is presented on the trigger').toBe(0);

		// The browser's own draw loop (`KinkyDungeonDrawFight`) would ease `scale` toward 1 over the
		// next real frames — simulated directly, as `mp-presentation-once.spec.ts` does for the SP bar.
		await A.evaluate((tile) => {
			// @ts-ignore
			const t = (KDGameData.BulletWarnings || []).find((w: any) => w.x === tile.x && w.y === tile.y);
			if (t) t.scale = 1;
		}, { x: tileX, y: tileY });

		await captureCoopWire(A);

		// Several REAL mouse moves over the canvas — no turn passes (nobody calls `sendAction`).
		for (let i = 0; i < 8; i++) {
			await A.mouse.move(200 + i * 37, 180 + (i % 3) * 55);
			await A.waitForTimeout(70);
		}

		// Precondition: the moves really did reach the server as hover input, or the assertion below
		// would be vacuous (nothing to replay from).
		await expect.poll(async () => (await readCoopWire(A, 'setMoveDirection')).length, {
			timeout: 10_000,
			message: 'the mouse moves must actually reach the server as hover (setMoveDirection) input',
		}).toBeGreaterThan(0);

		const result = await A.evaluate((tile) => {
			const w = window as any;
			// @ts-ignore
			const t = (KDGameData.BulletWarnings || []).find((wt: any) => wt.x === tile.x && wt.y === tile.y);
			return { scale: t ? t.scale : undefined, regressions: w.__kdm319.regressions, applies: w.__kdm319.applies };
		}, { x: tileX, y: tileY });

		expect(result.applies, 'precondition: the mouse moves actually drove at least one apply()').toBeGreaterThan(0);
		expect(result.regressions, 'a UI-only reply must never regress an already-eased warning tile').toBe(0);
		expect(result.scale, 'the overlay must still be at its eased value, not restarted from 0').toBe(1);

		// The game must still be alive after all that (no crash handler, KD invariant).
		expect(await A.evaluate(() => (window as any).__coop.started)).toBe(true);
		expect(bridge.session.started).toBe(true);
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
