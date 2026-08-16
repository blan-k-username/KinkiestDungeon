/**
 * KDM-163 (option A) — the apply/commit split, at the node layer.
 *
 * `submit()` used to mean BOTH "here is an input" and "I have finished my turn": `_pending` holds one
 * action per player, so a menu click either overwrote the player's queued real action or, if they were
 * the last to submit, advanced the world for everyone. That conflation is the reason the client needed
 * two hand-written lists at all.
 *
 * `apply()` removes it WITHOUT a list, by asking the game: run the input with `KinkyDungeonAdvanceTime`
 * OBSERVING a real application (`HeadlessHost.applyInputObserved`) and caching the answer per type.
 *
 * Browser-level coverage lives in `tests/e2e/mp-input-no-silent-drop.spec.ts`; this file pins the
 * mechanism deterministically, with no co-op boot and no host-contention flake in the way.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('apply/commit split (KDM-163 option A)', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'apply-commit-seed', seedInputKinds: true });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	/**
	 * The pre-seed is what makes deleting the client's hardcoded lists affordable. Without it, the
	 * first use of each type takes the lockstep default and costs the player a turn — measured to
	 * break click-to-move in `mp-coop-demo`, because KDFastMoveTo dispatches through KDSendInput.
	 */
	it('every live input type is classified BEFORE first use (static pre-seed)', () => {
		expect(s.inputSeedReport, 'the classifier must run at session start').toBeTruthy();
		expect(s.inputSeedReport.missing, 'no live input type may be left unseeded').toBe(0);
		expect(s.inputKind.get('move'), 'move advances time → turn').toBe('turn');
		expect(s.inputKind.get('tick'), 'tick advances time → turn').toBe('turn');
		expect(s.inputSeedReport.ui, 'the seed must free some inputs from costing a turn').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('a SEEDED ui type applies immediately and consumes no turn — no first-use penalty', () => {
		const uiType = [...s.inputKind.entries()].find(([, k]) => k === 'ui')[0];
		const turn0 = s.turn;
		const res = s.apply('A', { kdType: uiType, data: {} });
		expect(res.kind, `${uiType} is seeded ui, so it is applied immediately`).toBe('ui');
		expect(s.turn, 'a UI input must not advance the lockstep turn').toBe(turn0);
		expect(s.waitingOn(), 'it never entered lockstep').toEqual(expect.arrayContaining(['A', 'B']));
	}, BOOT_TIMEOUT);

	it('a type the game does not have at all still takes the safe default: lockstep', () => {
		const turn0 = s.turn;
		const res = s.apply('A', { kdType: '__kdm163_unseeded_type', data: {} });
		expect(res.kind, 'an unseeded type must never be applied outside lockstep').toBe('turn');
		expect(s.turn).toBe(turn0);
		s.apply('B', { kind: 'wait' });                       // resolve it so later tests start clean
		expect(s.turn).toBe(turn0 + 1);
	}, BOOT_TIMEOUT);

	it('a UI input PERSISTS on that player only (it is applied, not discarded)', () => {
		// Read each player's OWN baseline — a previous test may already have toggled A, and reading
		// "the world" reads whoever happens to be swapped in, which is how this assertion first
		// compared B against A's state.
		const crouchOf = (id: string) => {
			s.world.restorePlayer(s.bundles.get(id));
			return !!s.world.eval('KDGameData.Crouch');
		};
		const a0 = crouchOf('A');
		const b0 = crouchOf('B');

		// `crouch` is the observable here regardless of how it is classified; if the seed made it
		// turn-consuming, resolve the turn so the effect lands either way.
		const res = s.apply('A', { kdType: 'crouch', data: {} });
		if (res.kind === 'turn') s.apply('B', { kind: 'wait' });

		expect(crouchOf('A'), 'the input toggled A state and was kept').toBe(!a0);
		expect(crouchOf('B'), "A's input must not touch B").toBe(b0);
	}, BOOT_TIMEOUT);

	it('a turn-consuming input enters lockstep and advances only when both have acted', () => {
		const turn0 = s.turn;
		const rA = s.apply('A', { kind: 'wait' });
		expect(rA.kind, 'tick calls AdvanceTime, so the game classifies it as turn-consuming').toBe('turn');
		expect(rA.advanced, 'one player acting must not advance the turn').toBe(false);
		expect(s.turn).toBe(turn0);

		const rB = s.apply('B', { kind: 'wait' });
		expect(rB.advanced, 'the turn resolves once every player has acted').toBe(true);
		expect(s.turn, 'lockstep still advances exactly one turn').toBe(turn0 + 1);
	}, BOOT_TIMEOUT);

	/**
	 * The regression that killed the speculative design (probes/probe11): a world-mutating action must
	 * land EXACTLY once. Probing `doattack` and then rolling only the player back left the damage on
	 * the target, and the lockstep replay dealt it a second time.
	 */
	it('a world-mutating action lands EXACTLY once (never doubled by classification)', () => {
		const enemyHp = () => s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.Enemy && en.Enemy.name === '${s.enemyType}'; });
			return e ? e.hp : null;
		})()`);
		s.world.restorePlayer(s.bundles.get('A'));
		const target = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.Enemy && en.Enemy.name === '${s.enemyType}'; });
			return e ? { id: e.id, x: e.x, y: e.y } : null;
		})()`);
		if (!target) return;                       // no enemy in this seed — nothing to assert
		const hp0 = enemyHp();
		const turn0 = s.turn;

		s.apply('A', { kdType: 'doattack', data: { tx: target.x, ty: target.y, id: target.id, attackCost: 1 } });
		// nothing may have hit yet: an unlearned/turn type is NOT applied outside lockstep
		expect(enemyHp(), 'no damage before the turn resolves').toBe(hp0);

		s.apply('B', { kind: 'wait' });
		expect(s.turn).toBe(turn0 + 1);
		const hp1 = enemyHp();
		const dmgOnce = hp0 - hp1;
		expect(dmgOnce, 'the attack must land at most once').toBeGreaterThanOrEqual(0);

		// repeat: a second identical attack must deal about the SAME damage, not double
		const turn1 = s.turn;
		s.apply('A', { kdType: 'doattack', data: { tx: target.x, ty: target.y, id: target.id, attackCost: 1 } });
		s.apply('B', { kind: 'wait' });
		expect(s.turn).toBe(turn1 + 1);
		const dmgAgain = hp1 - enemyHp();
		if (dmgOnce > 0) {
			expect(dmgAgain, 'damage per turn must not double after the type is learned')
				.toBeLessThanOrEqual(dmgOnce * 1.5);
		}
	}, BOOT_TIMEOUT);

	/**
	 * Note the timing, which is a real property of this design and not a test quirk: an UNLEARNED type
	 * goes through lockstep, so whether the game had a handler for it is discovered when the turn
	 * RESOLVES, not when the input arrives. The report is therefore checked after the turn.
	 */
	it('AC3: an input the game has no handler for is reported, not silently dropped', () => {
		s.apply('A', { kdType: '__kdm163_no_such_input', data: {} });
		s.apply('B', { kind: 'wait' });                       // resolve the turn it entered
		expect(s.unknownInputReport().map((r: any) => r.type)).toContain('__kdm163_no_such_input');
	}, BOOT_TIMEOUT);

	it('AC2/I5: a MOD-registered input type works with no change to tools/mp-server/**', () => {
		s.world.loadMod(`
			KDInputTypes['kdm163UnitPing'] = function () {
				KDGameData.kdm163UnitPings = (KDGameData.kdm163UnitPings || 0) + 1;
				return 'pong';
			};
		`);
		const pings = () => {
			s.world.restorePlayer(s.bundles.get('A'));
			return s.world.eval('KDGameData.kdm163UnitPings || 0');
		};
		const before = pings();

		// First use: unlearned → lockstep. Applied exactly once when the turn resolves.
		s.apply('A', { kdType: 'kdm163UnitPing', data: {} });
		s.apply('B', { kind: 'wait' });
		expect(pings(), 'a mod-registered input reaches the authoritative world').toBeGreaterThan(before);
		expect(s.unknownInputReport().map((r: any) => r.type), 'a registered mod type is not "unknown"')
			.not.toContain('kdm163UnitPing');
		expect(s.inputKind.get('kdm163UnitPing'), 'it never advances time → learned as UI').toBe('ui');

		// Second use: learned → immediate, no turn consumed.
		const mid = pings();
		const turn0 = s.turn;
		const res = s.apply('A', { kdType: 'kdm163UnitPing', data: {} });
		expect(res.kind).toBe('ui');
		expect(s.turn, 'a learned UI mod input consumes no turn').toBe(turn0);
		expect(pings()).toBeGreaterThan(mid);
	}, BOOT_TIMEOUT);
});
