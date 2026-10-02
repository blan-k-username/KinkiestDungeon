/**
 * Node-layer (Vitest) — click-to-move (`KDFastMoveTo`) must route around an immobile NPC the
 * same way before and after the render-state round trip the thin client performs.
 *
 * UAT: clicking a tile beyond a row of standing NPCs (a prison/shop room) walked the route
 * straight onto one of them and opened its interaction, instead of detouring around it the way
 * single player does. Single player's own rule is in `KinkyDungeonPathfinding.ts`: a tile held by
 * an `Enemy.immobile` entity is excluded from the path outright (not just cost-weighted), so
 * `KDFastMoveTo` always detours around one when the room has room to.
 *
 * This proves the pathfinder keeps that rule once the entities have been through exactly what
 * `applyRenderState` does to them (the same wholesale `KDMapData` swap + enemy-cache invalidation
 * `render-client.js`'s `apply()` performs in the browser) — i.e. that an immobile NPC is still
 * seen as blocking AFTER a server snapshot has replaced the map, not only on the world that
 * spawned it.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 180_000;

/**
 * Carve a floor-only rectangle around a map CENTRE (never near the edge — `KinkyDungeonMapSet`
 * silently refuses the outer ring, so a corridor anchored on whatever `findOpenTile` picks can run
 * into the map border a few tiles in and look "blocked" for a reason that has nothing to do with
 * the NPC). Returns the centre so the caller can summon/place relative to it.
 */
function carveOpenRoom(host: any) {
	const dims = host.eval('({ gw: KDMapData.GridWidth, gh: KDMapData.GridHeight })');
	const cx = Math.floor(dims.gw / 2) - 3;
	const cy = Math.floor(dims.gh / 2);
	host.eval(`(function(){
		for (var dx = -3; dx <= 6; dx++)
			for (var dy = -3; dy <= 3; dy++)
				KinkyDungeonMapSet(${cx} + dx, ${cy} + dy, "0");
	})()`);
	return { cx, cy };
}

/** Run KD's own click-to-move and return the path it queued, without taking any step. */
function fastMoveRoute(host: any, tx: number, ty: number) {
	return host.eval(`(function(){
		// KDFastMoveTo refuses to path to a tile neither seen nor remembered — the per-frame
		// vision/fog pass that the real client runs before a click never runs headless. Called
		// with no CamX, KDUpdateVision computes the vision/fog grid only: it skips the PIXI
		// light-sprite draw entirely (that whole block is gated on CamX !== undefined).
		KDUpdateDoorNavMap();
		KDUpdateVision();
		KinkyDungeonFastMovePath = [];
		KDFastMoveTo(${tx | 0}, ${ty | 0});
		var path = KinkyDungeonFastMovePath ? KinkyDungeonFastMovePath.slice() : [];
		KinkyDungeonFastMovePath = [];
		return path;
	})()`);
}

/** Summon an immobile NPC near (x,y) and place the player/target symmetrically around where it
 *  actually landed — `KinkyDungeonSummonEnemy`'s placement is itself randomised within its radius,
 *  so asserting against the REPORTED position (rather than the requested one) is what keeps this
 *  deterministic regardless of that placement. */
function summonNpcAndFlank(host: any, cx: number, cy: number) {
	host.placePlayer(cx, cy);   // clear of the summon slot (cx+2,cy) before it is claimed
	const npc = host.summonEnemy(cx + 2, cy, 'PrisonerBandit', { rad: 1 });
	host.placePlayer(npc.x - 2, npc.y);
	return { npc, player: { x: npc.x - 2, y: npc.y }, target: { x: npc.x + 2, y: npc.y } };
}

describe('KDFastMoveTo vs an immobile NPC, across a render-state round trip', () => {
	it('single-player ground truth: the route detours around the NPC, never steps on it', () => {
		const h = new HeadlessHost({ id: 'fastmove-ground-truth' });
		h.boot();
		h.init({ seed: 'kdm315-fastmove-a' });
		const { cx, cy } = carveOpenRoom(h);
		const { npc, target } = summonNpcAndFlank(h, cx, cy);
		expect(npc).toBeTruthy();

		const path = fastMoveRoute(h, target.x, target.y);
		expect(path.length, 'KD must find a route at all in open floor').toBeGreaterThan(0);
		expect(path.some((pt: any) => pt.x === npc.x && pt.y === npc.y)).toBe(false);
	}, BOOT_TIMEOUT);

	it('after a render-state snapshot is adopted (the thin-client path), the route still detours', () => {
		const server = new HeadlessHost({ id: 'fastmove-server' });
		server.boot();
		server.init({ seed: 'kdm315-fastmove-b' });
		const { cx, cy } = carveOpenRoom(server);
		const { npc, target } = summonNpcAndFlank(server, cx, cy);
		expect(npc).toBeTruthy();

		const snap = server.serializeRenderState();
		snap.bundle = server.capturePlayer();

		// A SEPARATE instance stands in for the browser: booted on an unrelated seed/map, then made
		// to adopt the server's snapshot exactly the way the thin client does (`applyRenderState`
		// is the production function `render-client.js`'s `apply()` mirrors in the browser).
		const client = new HeadlessHost({ id: 'fastmove-client' });
		client.boot();
		client.init({ seed: 'unrelated-seed-for-the-client' });
		const applied = client.applyRenderState(snap);
		expect(applied.ok).toBe(true);

		const path = fastMoveRoute(client, target.x, target.y);
		expect(path.length, 'the client must still find a route at all').toBeGreaterThan(0);
		expect(path.some((pt: any) => pt.x === npc.x && pt.y === npc.y)).toBe(false);
	}, BOOT_TIMEOUT);
});
