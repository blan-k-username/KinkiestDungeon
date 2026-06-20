/**
 * Node-layer (Vitest) tests for the headless-safe render-state snapshot — KD-067.
 *
 * The thin client (KD-071) renders the server's state without simulating. Full
 * KinkyDungeonGenerateSaveData() is NOT viable headless (it reads render-derived
 * model Poses — KinkyDungeon.ts:6840). So the host exposes a purpose-built
 * render-state snapshot built directly from the live render globals.
 *
 * These tests prove the snapshot is JSON-safe, excludes model/pose data, and
 * round-trips faithfully onto a FRESH instance (serialize on A → apply on B →
 * B's render-relevant globals match A). The "actually renders a frame" proof is
 * the KD-071 browser spike — node can't run the PIXI draw path.
 *
 * Imports the host harness under tools/mp-server/** only (no Game/src/** source).
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 180_000;

describe('render-state snapshot (KD-067)', () => {
	let A: any;
	let B: any;
	let snap: any;

	beforeAll(() => {
		// A: a real, advanced game with the player placed and an enemy summoned.
		A = new HeadlessHost({ id: 'rs-A' });
		A.boot();
		A.init({ seed: 'render-state-seed' });
		const t = A.findOpenTile();
		A.placePlayer(t.x, t.y);
		A.summonEnemy(t.x + 2, t.y, 'Rat', { rad: 4 });
		A.step(3);
		snap = A.serializeRenderState();

		// B: a DIFFERENT fresh game (other seed) → adopting A's render state must
		// overwrite B's own map/stats/entities. This is the client-adopt path.
		B = new HeadlessHost({ id: 'rs-B' });
		B.boot();
		B.init({ seed: 'a-totally-different-seed' });
		B.applyRenderState(snap);
	}, BOOT_TIMEOUT);

	it('produces a JSON-safe, version-stamped snapshot', () => {
		expect(snap).toBeTruthy();
		expect(snap.version).toBe(1);
		expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow();
	});

	it('excludes render-derived model data (no Poses/appearance leak)', () => {
		const json = JSON.stringify(snap);
		expect(json).not.toContain('Poses');
		expect(json).not.toContain('"appearance"');
		expect(snap.player).not.toHaveProperty('Poses');
	});

	it('carries the camera/viewport globals', () => {
		expect(snap.camera).toBeTruthy();
		expect(typeof snap.camera.gridSizeDisplay).toBe('number');
		expect(B.eval('KinkyDungeonGridSizeDisplay')).toBe(snap.camera.gridSizeDisplay);
	});

	it('round-trips the dungeon map onto a fresh instance', () => {
		expect(typeof snap.map.Grid).toBe('string');
		expect(snap.map.Grid.length).toBeGreaterThan(0);
		expect(B.eval('KDMapData.Grid')).toBe(snap.map.Grid);
		expect(B.eval('KDMapData.GridWidth')).toBe(snap.map.GridWidth);
		expect(B.eval('KDMapData.GridHeight')).toBe(snap.map.GridHeight);
		// B was generated from a different seed → proves the adopt actually replaced it.
		expect(snap.map.Grid).not.toBe('');
	});

	it('round-trips the player position', () => {
		const ap = A.getPlayerPos();
		const bp = B.getPlayerPos();
		expect(bp.x).toBe(ap.x);
		expect(bp.y).toBe(ap.y);
	});

	it('round-trips the HUD stats', () => {
		expect(B.eval('KinkyDungeonStatWill')).toBe(snap.stats.will);
		expect(B.eval('KinkyDungeonStatWillMax')).toBe(snap.stats.willMax);
		expect(B.eval('KinkyDungeonStatStamina')).toBe(snap.stats.stamina);
		expect(B.eval('KinkyDungeonStatDistraction')).toBe(snap.stats.distraction);
	});

	it('round-trips entities incl. the summoned enemy (full KDMapData adopt)', () => {
		expect(Array.isArray(snap.map.Entities)).toBe(true);
		// the full KDMapData clone carries entities WITH their Enemy defs (no re-link).
		expect(snap.map.Entities.some((e: any) => e.Enemy && e.Enemy.name === 'Rat')).toBe(true);
		const bEnt = B.listEntities();
		expect(bEnt.length).toBe(snap.map.Entities.length);
		// the wholesale-adopted entity resolves name/faction on the fresh instance.
		expect(bEnt.some((e: any) => e.name === 'Rat')).toBe(true);
	});

	it('round-trips the current floor', () => {
		expect(B.eval('MiniGameKinkyDungeonLevel')).toBe(snap.level);
	});
});
