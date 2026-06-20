/**
 * KD-075 — PoC integration capstone (node-layer Vitest).
 *
 * One end-to-end run that exercises EVERY pillar of the server-authoritative MP
 * concept together, asserting each. Pure assembly of KD-079/081/080/082; the
 * human-readable version is tools/mp-server/demo.js.
 *
 * Imports tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IntegratedSession } = require('../../tools/mp-server/integration');

const BOOT_TIMEOUT = 300_000;
const PLAYERS = ['A', 'B', 'C'];
const MOD_ENEMY = 'AngrySkeleton';

describe('PoC capstone — maximal-concept end-to-end run', () => {
	let s: any;
	let modBefore: any;
	let modResult: any;
	let turns: any[];
	let pvp: any;
	let params: any;

	beforeAll(async () => {
		s = new IntegratedSession({ seed: 'capstone-seed' });
		await s.start();
		modBefore = await s.getEnemyEverywhere(MOD_ENEMY);
		for (const id of PLAYERS) await s.join(id);
		await s.ready();

		modResult = await s.loadMod();

		turns = [];
		for (let t = 0; t < 6; t++) {
			let snap: any;
			for (const id of PLAYERS) {
				const r = await s.submitMove(id, { dx: 0, dy: 0 });
				if (r.turn) snap = r.turn;
			}
			turns.push(snap);
		}

		await s.forceAdjacentInWorld('A', 'B');
		pvp = await s.routedPvp('A', 'B', { restraint: 'DuctTapeHands', damage: 3 });

		params = await s.paramsSnapshot();
	}, BOOT_TIMEOUT);

	afterAll(async () => { if (s) await s.close(); });

	it('lobby: 3 players are assigned distinct instances', () => {
		expect(s.clientIds).toEqual(PLAYERS);
		expect(Object.keys(s.avatarEntities.world).sort()).toEqual([...PLAYERS].sort());
	});

	it('mod: the server-loaded enemy is absent before and present in every instance after', () => {
		expect(modBefore.world).toBeNull();
		for (const id of Object.keys(modResult.result)) {
			expect(modResult.result[id]).toEqual({ name: MOD_ENEMY });
		}
	});

	it('turn clock: ticks advance in lockstep across world + all players each turn', () => {
		turns.forEach((snap, i) => {
			const vals = [snap.ticks.world, ...PLAYERS.map((p) => snap.ticks[p])];
			expect(new Set(vals).size).toBe(1);
			expect(snap.ticks.world).toBe(i + 1);
		});
	});

	it('enemy: at least one routed enemy hit landed on a player (their will dropped)', () => {
		const hits = turns.map((t) => t.enemyHit).filter((h: any) => h && h.applied);
		expect(hits.length).toBeGreaterThan(0);
		const victims = new Set(hits.map((h: any) => h.targetClient));
		// the victim's will is below the 10 baseline in the final params
		for (const v of victims) expect(params[v as string].will).toBeLessThan(10);
	});

	it('PvP: world authorizes A→B; B is affected, A is unchanged', () => {
		expect(pvp.authorized).toBe(true);
		expect(pvp.after.target.restraints).toBeGreaterThan(pvp.before.target.restraints);
		expect(pvp.after.target.will).toBeLessThan(pvp.before.target.will);
		expect(pvp.after.attacker).toEqual(pvp.before.attacker);
	});

	it('params: the three players hold independent state but share the map seed', () => {
		const seeds = new Set(PLAYERS.map((id) => params[id].seed));
		expect(seeds.size).toBe(1);
		// not all wills equal — they diverged via different events
		const wills = PLAYERS.map((id) => params[id].will);
		expect(new Set(wills).size).toBeGreaterThan(1);
	});
});
