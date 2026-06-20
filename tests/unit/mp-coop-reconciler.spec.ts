/**
 * Node-layer (Vitest) tests for the co-op reconciler — KD-070 (the core design).
 *
 * Drives a SessionOrchestrator (KD-069) + CoopReconciler over a scripted scenario
 * and asserts the protocol's acceptance criteria:
 *   1. the world transmits its ONE authoritative map+enemies (players don't regen);
 *   2. the shared enemy is consistent across world + both player instances;
 *   3. an enemy attack lands on the targeted player ONLY (real, routed), via the
 *      enemy's actual def-derived attack profile;
 *   4. player A's move is visible to player B next turn (as a real avatar entity).
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SessionOrchestrator } = require('../../tools/mp-server/session-orchestrator');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CoopReconciler } = require('../../tools/mp-server/coop-reconciler');

const BOOT_TIMEOUT = 240_000;

function build() {
	const recon = new CoopReconciler({ enemyType: 'Rat' });
	const orch = new SessionOrchestrator({
		seed: 'coop-reconciler-seed',
		playerIds: ['A', 'B'],
		reconcile: recon.hook(),
	});
	orch.setup();
	return { orch, recon };
}

describe('CoopReconciler — authoritative shared world (KD-070)', () => {
	let orch: any;
	let recon: any;

	beforeAll(() => {
		({ orch, recon } = build());
	}, BOOT_TIMEOUT);

	it('transmits the world map to every player (no same-seed parallel regen)', () => {
		const worldGrid = orch.world.eval('KDMapData.Grid');
		for (const id of orch.playerIds) {
			expect(orch.players.get(id).eval('KDMapData.Grid')).toBe(worldGrid);
		}
	});

	it('puts the world-owned enemy into each player instance (proves transmission)', () => {
		// The Rat was summoned ONLY in the world. If players see it, it was transmitted.
		for (const id of orch.playerIds) {
			const names = orch.players.get(id).listEntities().map((e: any) => e.name);
			expect(names).toContain('Rat');
		}
	});

	it('each player sees the OTHER player as a real avatar entity', () => {
		expect(recon.avatarAsSeenBy(orch, 'A', 'B')).toBeTruthy();
		expect(recon.avatarAsSeenBy(orch, 'B', 'A')).toBeTruthy();
		// ...and does NOT carry its own avatar as a separate entity (it IS the player).
		expect(recon.avatarAsSeenBy(orch, 'A', 'A')).toBeNull();
	});

	it('keeps the shared enemy consistent across instances after a turn', () => {
		orch.submit('A', { dx: 0, dy: 0 });
		orch.submit('B', { dx: 0, dy: 0 });
		const w = recon.enemyView(orch);
		const a = recon.enemyAsSeenBy(orch, 'A');
		const b = recon.enemyAsSeenBy(orch, 'B');
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		expect({ x: a.x, y: a.y }).toEqual({ x: w.x, y: w.y });
		expect({ x: b.x, y: b.y }).toEqual({ x: w.x, y: w.y });
	});
});

describe('CoopReconciler — routed enemy attack hits the right player', () => {
	let orch: any;
	let recon: any;
	let baseA: any;
	let baseB: any;

	beforeAll(() => {
		({ orch, recon } = build());
		baseA = orch.players.get('A').getVitals();
		baseB = orch.players.get('B').getVitals();
		// Deterministically engage the enemy with player A, run a few turns.
		recon.forceEngagePlayer = 'A';
		for (let i = 0; i < 3; i++) {
			orch.submit('A', { dx: 0, dy: 0 });
			orch.submit('B', { dx: 0, dy: 0 });
		}
	}, BOOT_TIMEOUT);

	it('routes the hit to the targeted player (A changes)', () => {
		const a = orch.players.get('A').getVitals();
		// pain damage lands on Will; some vital must have moved on A.
		const changed =
			a.will < baseA.will || a.stamina < baseA.stamina ||
			a.distraction !== baseA.distraction || a.restraints > baseA.restraints;
		expect(changed).toBe(true);
	});

	it('leaves the non-targeted player (B) untouched', () => {
		const b = orch.players.get('B').getVitals();
		expect(b.will).toBe(baseB.will);
		expect(b.stamina).toBe(baseB.stamina);
		expect(b.restraints).toBe(baseB.restraints);
	});

	it('uses the enemy\'s REAL def-derived attack profile (not a fixed constant)', () => {
		expect(recon.lastHits.length).toBeGreaterThan(0);
		const hit = recon.lastHits.find((h: any) => h.player === 'A');
		expect(hit).toBeTruthy();
		expect(hit.player).toBe('A');
		// Rat def: attack "MeleeWill", power 1, dmgType "pain".
		expect(hit.profile.attack).toBe('MeleeWill');
		expect(hit.profile.power).toBe(1);
		expect(hit.profile.type).toBe('pain');
		// no hit was routed to B this turn
		expect(recon.lastHits.some((h: any) => h.player === 'B')).toBe(false);
	});
});

describe('CoopReconciler — player movement is visible to the other player', () => {
	let orch: any;
	let recon: any;

	beforeAll(() => {
		({ orch, recon } = build());
	}, BOOT_TIMEOUT);

	it('A moving is reflected in B\'s view of A\'s avatar next turn', () => {
		const before = recon.avatarAsSeenBy(orch, 'B', 'A');
		expect(before).toBeTruthy();
		// A steps; B submits a no-op. Barrier completes → reconcile broadcasts.
		orch.submit('A', { dx: 1, dy: 0 });
		orch.submit('B', { dx: 0, dy: 0 });
		const aPos = orch.players.get('A').getPlayerPos();
		const after = recon.avatarAsSeenBy(orch, 'B', 'A');
		expect(after).toBeTruthy();
		expect({ x: after.x, y: after.y }).toEqual({ x: aPos.x, y: aPos.y });
		// and it actually moved from where it was
		expect(after.x !== before.x || after.y !== before.y).toBe(true);
	});
});
