/**
 * In a REAL browser: a bullet that exists in the co-op world is DRAWN on the client, and goes away
 * when the world drops it.
 *
 * Suspected from code: KD draws bullets ONLY from `KinkyDungeonBulletsVisual`
 * (`Game/src/fight/KinkyDungeonFight.ts:53`, a module-scope Map, NOT part of `KDMapData`), and the only
 * writer of that Map is `KinkyDungeonUpdateSingleBulletVisual` — called from the turn simulation
 * (bullet launch, update and hit). A co-op client does not simulate, and the snapshot carries
 * `KDMapData.Bullets` but not the visual Map, so a projectile or spell in co-op is in the world and
 * never on screen. Expected: it looks the same as in single-player.
 *
 * The bullet is launched directly on the world (`bridge.session.world.eval`), the same technique
 * `mp-bullet-warning-scale-replay.spec.ts` uses: KD's own `KinkyDungeonLaunchBullet`, stationary, long
 * lived and harmless, on a free tile beside A — a real cast is a long, RNG-gated setup for the SAME
 * `KDMapData.Bullets` entry.
 *
 * ⚠️ Two CONTROLS are load-bearing:
 *  - the bullet must actually reach A's `KDMapData.Bullets`, or "not drawn" proves nothing;
 *  - a bullet visual registered by hand on A's page must be drawn by A's own draw loop, or a "drawn"
 *    assertion could fail for a reason that is not this bug (camera, vision, a dead recorder).
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, recordDrawnSprites, readDrawnSprites, resetDrawnSprites, restoreDrawnSprites,
	drewSprite, MP_TEST_TIMEOUT,
} from './helpers/coop';
import { freeNeighbour } from '../helpers/session-tiles';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** KD's own launch, stationary and harmless — returns the bullet's `spriteID`. */
const launchSource = (x: number, y: number) => `(function(){
	var b = KinkyDungeonLaunchBullet(${x}, ${y}, 0, 0, 0, {
		name: 'Fireball', width: 1, height: 1, lifetime: 999, passthrough: true, noEnemyCollision: true,
		spell: { name: 'Fireball' },
	}, false, ${x}, ${y});
	return { id: b.spriteID, visual: KinkyDungeonBulletsVisual.has(b.spriteID) };
})()`;

/** Nudge the mouse so A sends hover input and the server answers with a fresh snapshot. */
const hover = (P: any) => P.mouse.move(140 + Math.random() * 40, 140 + Math.random() * 40);

test('a bullet in the co-op world is drawn on the client, and leaves when the world drops it', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	try {
		await bootCoopPair(A, B, port);
		const s = bridge.session;
		const tile = freeNeighbour(s, 'A');
		expect(tile, 'precondition: a free tile beside A to put the bullet on').toBeTruthy();

		await recordDrawnSprites(A, { match: 'Bullets/' });

		// ---- CONTROL 1: A's own draw loop draws a bullet visual that IS registered ----------------
		const probe = await A.evaluate((t: { x: number; y: number }) => {
			const id = 'probeBullet_' + Date.now();
			// @ts-ignore bare let-global / bundle function
			KinkyDungeonBulletsVisual.set(id, {
				end: false, zIndex: 0, temporary: false, spinAngle: 0, name: 'Icebolt', spriteID: id,
				size: 1, vx: 0, vy: 0, xx: t.x, yy: t.y, visual_x: t.x, visual_y: t.y,
				updated: true, scale: 1, alpha: 1,
			});
			return id;
		}, { x: tile!.x, y: tile!.y });
		await expect.poll(async () => drewSprite(await readDrawnSprites(A), new RegExp('^' + esc(probe) + '$'), /Bullets\/Icebolt\.png$/),
			{ timeout: 15_000, message: 'control: a registered bullet visual beside A is drawn by A\'s own frame loop' })
			.toBe(true);
		await A.evaluate((id: string) => {
			// @ts-ignore
			KinkyDungeonBulletsVisual.delete(id);
		}, probe);
		await resetDrawnSprites(A);

		// ---- the bullet, launched in the WORLD --------------------------------------------------
		const launched = s.world.eval(launchSource(tile!.x, tile!.y));
		expect(launched.visual, 'control: KD itself registers a visual for the bullet it launched').toBe(true);
		const id: string = launched.id;

		// CONTROL 2: the bullet reaches A's map — polled, because it takes a real round trip.
		await expect.poll(async () => {
			await hover(A);
			return A.evaluate((bid: string) => {
				// @ts-ignore bare let-global
				return !!(KDMapData && KDMapData.Bullets || []).find((b: any) => b && b.spriteID === bid);
			}, id);
		}, { timeout: 20_000, message: 'control: the world\'s bullet reaches A\'s KDMapData.Bullets' }).toBe(true);

		// THE BUG: in the map, but is it on screen?
		await expect.poll(async () => {
			await hover(A);
			return drewSprite(await readDrawnSprites(A), new RegExp('^' + esc(id) + '$'), /Bullets\/Fireball\.png$/);
		}, { timeout: 15_000, message: 'a bullet in the co-op world must be DRAWN on the client' }).toBe(true);
		expect((await readDrawnSprites(A)).calls, 'liveness: the recorder saw KDDraw calls').toBeGreaterThan(0);

		// ---- the world drops it: the client's sprite must not stay on screen --------------------
		s.world.eval(`(function(){
			KDMapData.Bullets = KDMapData.Bullets.filter(function(b){ return b.spriteID !== ${JSON.stringify(id)}; });
		})()`);
		// KD's own fade-out: the visual is marked `end`, its alpha eases to 0 over a few frames and the
		// draw loop stops painting it (the Map entry itself is only swept on the next real turn, by KD's
		// `KinkyDungeonUpdateBulletVisuals`). So the user-visible fact is "no longer PAINTED".
		await expect.poll(async () => {
			await hover(A);
			return A.evaluate((bid: string) => {
				// @ts-ignore bare let-globals
				return !(KDMapData.Bullets || []).some((b: any) => b && b.spriteID === bid);
			}, id);
		}, { timeout: 20_000, message: 'precondition: A adopted a map without the dropped bullet' }).toBe(true);
		await A.waitForTimeout(3_000);               // KD's alpha fade, a handful of frames
		await resetDrawnSprites(A);
		for (let i = 0; i < 4; i++) { await hover(A); await A.waitForTimeout(500); }
		const after = await readDrawnSprites(A);
		expect(after.calls, 'liveness: A kept painting during the window').toBeGreaterThan(0);
		expect(drewSprite(after, new RegExp('^' + esc(id) + '$'), /Bullets\//),
			'a bullet the world dropped must leave the client\'s screen (no stuck sprite)').toBe(false);

		// The game must still be alive (KD crash-handler invariant).
		expect(await A.evaluate(() => (window as any).__coop.started)).toBe(true);
		expect(bridge.session.started).toBe(true);
	} finally {
		await restoreDrawnSprites(A).catch(() => {});
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
