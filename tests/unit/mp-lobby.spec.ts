/**
 * Node-layer (Vitest) tests for the KD-080 feature pillars: lobby join (2–4),
 * PvP (effect lands only on the target's instance), and server-side mod loading.
 *
 * Built on the KD-079/081 host + transport. Default in-process transport for
 * speed (a lobby of 4 + world = 5 bundle instances per test).
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Lobby } = require('../../tools/mp-server/lobby');

const BOOT_TIMEOUT = 300_000;

describe('Lobby join (2–4 players)', () => {
	for (const N of [2, 3, 4]) {
		describe(`${N} players`, () => {
			let lobby: any;
			const ids = Array.from({ length: N }, (_, i) => String.fromCharCode(65 + i)); // A,B,C,D

			beforeAll(async () => {
				lobby = new Lobby({ seed: 'lobby-seed' });
				await lobby.start();
				for (const id of ids) await lobby.join(id);
				await lobby.ready();
				// run a few synchronized turns
				for (let turn = 0; turn < 3; turn++) {
					for (const id of ids) await lobby.submitMove(id, { dx: 1, dy: 0 });
				}
			}, BOOT_TIMEOUT);

			afterAll(async () => { if (lobby) await lobby.close(); });

			it(`assigns a distinct instance to each of ${N} clients`, () => {
				expect(lobby.clientIds).toEqual(ids);
				expect(lobby.clients.length).toBe(N);
			});

			it('ticks advance in lockstep across world + all players', () => {
				expect(lobby.turn).toBe(3);
				for (const snap of lobby.history) {
					const vals = [snap.ticks.world, ...ids.map((id) => snap.ticks[id])];
					expect(new Set(vals).size).toBe(1); // all equal
				}
			});

			it('the enemy is consistent across world + all players each turn', () => {
				for (const snap of lobby.history) {
					expect(snap.enemyView.world).toBeTruthy();
					for (const id of ids) expect(snap.enemyView[id]).toEqual(snap.enemyView.world);
				}
			});

			it('world runs enemy AI; every player suppresses it', () => {
				for (const snap of lobby.history) {
					expect(snap.roles.world).toBe(true);
					for (const id of ids) expect(snap.roles[id]).toBe(false);
				}
			});
		});
	}
});

describe('PvP — effect lands only on the target instance', () => {
	let lobby: any;
	let result: any;

	beforeAll(async () => {
		lobby = new Lobby({ seed: 'pvp-seed' });
		await lobby.start();
		await lobby.join('A');
		await lobby.join('B');
		await lobby.ready();
		// A binds + damages B
		result = await lobby.pvp('A', 'B', { restraint: 'DuctTapeHands', damage: 3, damageType: 'pain' });
	}, BOOT_TIMEOUT);

	afterAll(async () => { if (lobby) await lobby.close(); });

	it("the target's restraint count increases", () => {
		expect(result.after.target.restraints).toBeGreaterThan(result.before.target.restraints);
	});

	it("the target's will drops from the damage", () => {
		expect(result.after.target.will).toBeLessThan(result.before.target.will);
	});

	it('the attacker is completely unaffected (per-instance isolation)', () => {
		expect(result.after.attacker).toEqual(result.before.attacker);
	});
});

describe('Server-loaded mod', () => {
	let lobby: any;
	let loaded: any;
	let before: any;

	beforeAll(async () => {
		lobby = new Lobby({ seed: 'mod-seed' });
		await lobby.start();
		await lobby.join('A');
		await lobby.join('B');
		await lobby.ready();
		before = await lobby.getEnemyEverywhere('AngrySkeleton');
		loaded = await lobby.loadMod({ scope: 'all' }); // default Mods/example_enemy/init.ks
	}, BOOT_TIMEOUT);

	afterAll(async () => { if (lobby) await lobby.close(); });

	it('the modded enemy does NOT exist before loading (control)', () => {
		expect(before.world).toBeNull();
		expect(before.A).toBeNull();
		expect(before.B).toBeNull();
	});

	it('the mod loads server-side and its enemy exists in every instance', () => {
		expect(loaded.enemyName).toBe('AngrySkeleton');
		for (const id of Object.keys(loaded.result)) {
			expect(loaded.result[id]).toEqual({ name: 'AngrySkeleton' });
		}
	});
});
