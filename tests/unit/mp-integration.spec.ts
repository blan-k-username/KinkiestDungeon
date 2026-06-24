/**
 * Node-layer (Vitest) tests for KD-082 — real in-game integration.
 *
 * Proves the four deep pillars the earlier PoCs only faked (value-copy reconcile,
 * harness-injected PvP, enemy moving toward a coordinate):
 *  1. Players as REAL KD entities (injected avatars the engine sees).
 *  2. Enemy AI genuinely targets/attacks a player; the hit is routed to that
 *     player's own instance; the other player is unaffected.
 *  3. Player-to-player interaction adjudicated by the authoritative world
 *     (adjacency) and routed to the target's instance.
 *  4. Each player instance holds full, independent params.
 *
 * Imports tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IntegratedSession } = require('../../tools/mp-server/integration');

const BOOT_TIMEOUT = 300_000;

describe('Real entities + enemy attack + independent params', () => {
	let s: any;
	let baseline: any;       // per-client vitals right after ready()
	let worldEntities: any[];
	let aSeesB: any;
	let targetedClients: Set<string>;
	let finalParams: any;

	beforeAll(async () => {
		s = new IntegratedSession({ seed: 'integ-seed' });
		await s.start();
		await s.join('A');
		await s.join('B');
		await s.ready();

		worldEntities = await s.entitiesIn('world');
		// B's avatar as seen inside A's instance (a real entity at B's position)
		const aEnts = await s.entitiesIn('A');
		aSeesB = aEnts.find((e: any) => e.name && e.name.startsWith('RemotePlayer'));

		baseline = {
			A: await s._t('A').request('getVitals'),
			B: await s._t('B').request('getVitals'),
		};

		// run turns with no player movement → the world enemy closes in and attacks
		targetedClients = new Set();
		for (let i = 0; i < 5; i++) {
			await s.submitMove('A', { dx: 0, dy: 0 });
			const r = await s.submitMove('B', { dx: 0, dy: 0 });
			const hit = r.turn?.enemyHit;
			if (hit && hit.applied) targetedClients.add(hit.targetClient);
		}
		finalParams = await s.paramsSnapshot();
	}, BOOT_TIMEOUT);

	afterAll(async () => { if (s) await s.close(); });

	it('gap1: each player is injected as a real Player-faction entity in the world', () => {
		const avatars = worldEntities.filter((e) => e.name && e.name.startsWith('RemotePlayer'));
		expect(avatars.length).toBe(2);
		for (const av of avatars) expect(av.faction).toBe('Player');
	});

	it("gap1: player B appears as a real entity inside player A's instance", () => {
		expect(aSeesB).toBeTruthy();
		expect(aSeesB.faction).toBe('Player');
	});

	it('gap2: the world enemy actually attacks a player (routed to their instance)', () => {
		expect(targetedClients.size).toBeGreaterThanOrEqual(1);
		// the targeted player's will dropped in their OWN instance
		for (const id of targetedClients) {
			expect(finalParams[id].will).toBeLessThan(baseline[id].will);
		}
	});

	it('gap2: a player the enemy did NOT target is unaffected by the enemy', () => {
		const untargeted = ['A', 'B'].find((id) => !targetedClients.has(id));
		expect(untargeted).toBeTruthy();
		expect(finalParams[untargeted as string].will).toBe(baseline[untargeted as string].will);
	});

	it('gap4: the two players hold independent params (diverge where acted on)', () => {
		// the enemy hit one and not the other → their wills differ
		expect(finalParams.A.will).not.toBe(finalParams.B.will);
	});

	it('gap4: params agree where they should (same shared map seed)', () => {
		expect(finalParams.A.seed).toBe(finalParams.B.seed);
		expect(finalParams.A.level).toBe(finalParams.B.level);
	});
});

describe('Routed player-to-player interaction (world-adjudicated)', () => {
	let s: any;
	let authorized: any;
	let rejected: any;

	beforeAll(async () => {
		s = new IntegratedSession({ seed: 'pvp-seed' });
		await s.start();
		await s.join('A');
		await s.join('B');
		await s.ready();

		// authorized path: world avatars made adjacent → A binds + damages B
		await s.forceAdjacentInWorld('A', 'B');
		authorized = await s.routedPvp('A', 'B', { restraint: 'DuctTapeHands', damage: 3 });

		// unauthorized path: move B's world avatar far → world rejects
		const bEid = s.avatarEntities.world['B'];
		await s.world.request('moveAvatar', { entityId: bEid, x: 1, y: 12 });
		rejected = await s.routedPvp('A', 'B', { restraint: 'DuctTapeHands', damage: 3 });
	}, BOOT_TIMEOUT);

	afterAll(async () => { if (s) await s.close(); });

	it('the world authorizes an adjacent interaction', () => {
		expect(authorized.authorized).toBe(true);
	});

	it("the authorized effect lands on the target's instance (B changes)", () => {
		expect(authorized.after.target.restraints).toBeGreaterThan(authorized.before.target.restraints);
		expect(authorized.after.target.will).toBeLessThan(authorized.before.target.will);
	});

	it('the attacker is unaffected (per-instance isolation)', () => {
		expect(authorized.after.attacker).toEqual(authorized.before.attacker);
	});

	it('the world REJECTS a non-adjacent interaction (no effect lands)', () => {
		expect(rejected.authorized).toBe(false);
		expect(rejected.after.target).toEqual(rejected.before.target);
	});
});
