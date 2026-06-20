/**
 * Node-layer (Vitest) tests for the headless KD host — KD-079 / KD-067 PoC.
 *
 * These drive the stock out/main.js bundle in plain Node behind the shim layer
 * (no Chromium). They cover the host foundation and serverMode suppression
 * (R3/AC4: a world instance runs shared-entity AI, a player instance suppresses it).
 *
 * NOTE: these import the host harness under tools/mp-server/** (test/tooling
 * code), NOT any Game/src/** or Scripts/** source — per the test invariants.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 180_000;

describe('HeadlessHost — boot & step', () => {
	let host: any;

	beforeAll(() => {
		host = new HeadlessHost({ id: 'spec-host' });
		host.boot();
		host.init({ seed: 'host-spec-seed' });
	}, BOOT_TIMEOUT);

	it('boots the stock bundle in plain Node and exposes KD globals', () => {
		expect(typeof host.eval('typeof KinkyDungeonStartNewGame')).toBe('string');
		expect(host.eval('typeof KinkyDungeonStartNewGame')).toBe('function');
		expect(host.eval('typeof KDFactionRelation')).toBe('function');
	});

	it('generates a real dungeon map (R6 — init produces a playable world)', () => {
		const grid = host.eval('KDMapData.Grid');
		expect(typeof grid).toBe('string');
		expect(grid.length).toBeGreaterThan(0);
		expect(host.eval('KDMapData.GridWidth')).toBeGreaterThan(0);
	});

	it('step(n) advances KinkyDungeonCurrentTick in lockstep with n (R2)', () => {
		const t0 = host.tick();
		host.step(3);
		expect(host.tick()).toBe(t0 + 3);
	});

	it('getState() returns a JSON-safe snapshot of the sim (R6)', () => {
		const s = host.getState();
		expect(typeof s.tick).toBe('number');
		expect(s.player).toBeTruthy();
		expect(typeof s.player.x).toBe('number');
		// JSON round-trip must not throw (the reconciler ships snapshots, not pixels).
		expect(() => JSON.parse(JSON.stringify(s))).not.toThrow();
	});

	// NOTE: full KinkyDungeonGenerateSaveData() is NOT supported headless — the
	// save path reads KDCurrentModels.get(player).Poses, which only exists once the
	// model/draw pipeline runs (we neuter rendering). Full save/load round-trip is
	// production host scope (KD-067), tracked as tech debt for this PoC.
});

describe('serverMode suppression (R3/AC4)', () => {
	let world: any;
	let player: any;
	let worldTrace: any[];
	let playerTrace: any[];

	beforeAll(() => {
		const STEPS = 12;

		// Identical stimulus for both roles: the player walks a fixed path each
		// step so a world-role enemy has a moving target to chase. The only
		// difference between the two runs is the serverMode — so any divergence in
		// the enemy trace is attributable to AI suppression.
		const PATH = [
			{ dx: 1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: 1 },
			{ dx: -1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: -1 },
			{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 },
		];

		const make = (mode: 'world' | 'player') => {
			const h = new HeadlessHost({ id: `supp-${mode}` });
			h.boot();
			h.init({ seed: 'suppression-seed' });
			h.setServerMode(mode);
			const t = h.findOpenTile();
			h.placePlayer(t.x, t.y);
			h.summonEnemy(t.x + 2, t.y, 'Rat', { rad: 4 });
			const trace: any[] = [h.getRealEnemy(0)];
			for (let i = 0; i < STEPS; i++) {
				const p = h.applyMove(PATH[i].dx, PATH[i].dy);
				h.setEnemyTarget(p.x, p.y);
				h.step(1);
				trace.push(h.getRealEnemy(0));
			}
			return { h, trace };
		};

		const w = make('world');
		const p = make('player');
		world = w.h; player = p.h;
		worldTrace = w.trace; playerTrace = p.trace;
	}, BOOT_TIMEOUT);

	it('world role runs shared-entity AI; player role does not', () => {
		expect(world.runsEnemyAI()).toBe(true);
		expect(player.runsEnemyAI()).toBe(false);
	});

	it('world enemy moves under AI over the run', () => {
		const start = worldTrace[0];
		const moved = worldTrace.some((e) => e && (e.x !== start.x || e.y !== start.y));
		expect(moved).toBe(true);
	});

	it('player-role enemy stays frozen (AI suppressed)', () => {
		const start = playerTrace[0];
		const everMoved = playerTrace.some((e) => e && (e.x !== start.x || e.y !== start.y));
		expect(everMoved).toBe(false);
	});
});
