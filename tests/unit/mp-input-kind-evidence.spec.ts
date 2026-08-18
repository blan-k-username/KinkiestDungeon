/**
 * KDM-197 — an input type's kind must be backed by EVIDENCE, not by one observation.
 *
 * `SwapSession` learns, per input type, whether it consumes a shared turn. Before this task the rule
 * was `seen = obs.advanced > 0 ? 'turn' : 'ui'`: ONE non-advancing occurrence demoted a type to `ui`
 * for the rest of the session, after which every later occurrence was applied immediately, OUTSIDE
 * lockstep — a desync per input until the `ui`→`turn` safety net happened to fire.
 *
 * MEASURED producer (this task, 2026-08-18): in co-op (PvP off, the default) the peer's avatar is an
 * ALLIED, non-hostile entity — `_armPeerEnemies` skips it — and both players spawn adjacent. A move
 * into it takes KD's `KinkyDungeonLaunchAttack` branch, which does nothing to an ally and never calls
 * `KinkyDungeonAdvanceTime`: `{advanced: 0, result: "nomove"}`. So the very first bump into your
 * co-op partner used to take `move` out of lockstep for the whole session. That is the third known
 * producer of a non-advancing move, after the KDM-208 contested-tile veto and any early-returning
 * handler — which is why the fix here is a rule, not a fourth special case:
 *
 *   1. a `turn` verdict the CLASSIFIER PROVED (AdvanceTime reachable through resolved callees only)
 *      is never demoted by observation — the type demonstrably can advance, it just declined here;
 *   2. everything else needs CORROBORATION (`uiDemotionEvidence` non-advancing observations), and any
 *      type ever observed to advance is pinned to `turn` for good.
 *
 * Lockstep is always the safe side, so both rules err toward it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { classifyInputs } = require('../../tools/mp-server/input-classifier');
const { loadSources } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

describe('KDM-197 static confidence', () => {
	it('separates a PROVEN turn-consuming type from a conservatively-guessed one', () => {
		const { kinds, confidence, report } = classifyInputs(loadSources().bundle);

		expect(report.found, 'the KDInputTypes registry must still be parseable').toBe(true);
		expect(confidence, 'every classified type carries a confidence').toBeTruthy();
		for (const t of Object.keys(kinds)) {
			expect(['proven-turn', 'assumed-turn', 'proven-ui'],
				`${t} has an unknown confidence "${confidence[t]}"`).toContain(confidence[t]);
			expect(confidence[t] === 'proven-ui' ? 'ui' : 'turn',
				`${t}: confidence and kind must agree`).toBe(kinds[t]);
		}

		// `move` reaches KinkyDungeonAdvanceTime through KinkyDungeonMove — resolved, no guessing.
		expect(kinds.move).toBe('turn');
		expect(confidence.move, 'move is PROVEN turn-consuming, so observation must never demote it')
			.toBe('proven-turn');

		// …and the distinction is not vacuous: the conservative bucket must be non-empty, because
		// repairing exactly that bucket is what runtime demotion is FOR.
		const assumed = Object.keys(kinds).filter((t) => confidence[t] === 'assumed-turn');
		expect(assumed.length, 'if nothing is "assumed", the confidence split measures nothing')
			.toBeGreaterThan(0);
		expect(report.provenTurn, 'the report exposes the split').toBeGreaterThan(0);
		expect(report.provenTurn + report.assumedTurn, 'the two turn buckets partition the turn verdict')
			.toBe(report.turn);
	}, BOOT_TIMEOUT);
});

/**
 * `seedInputKinds` gates whether the classifier's VERDICTS are applied — a client-routing decision
 * (KDM-163 § CORRECTION 2), still off by default. Its CONFIDENCE is a different question, and every
 * session needs it: without it, a default-configured session has no static evidence for any type and
 * `move` becomes demotable again by the same bump this task is about.
 */
describe('KDM-197 protection does not depend on the seeding opt-in', () => {
	it('a session with seedInputKinds OFF still knows move is proven turn-consuming', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'apply-commit-seed' });
		s.join('A');
		s.join('B');
		await s.ready();

		expect(s.seedInputKinds, 'this is the DEFAULT configuration').toBe(false);
		expect(s.inputSeedReport.applied, 'the verdicts are deliberately not applied').toBe(false);
		expect(s.inputKind.get('move'), 'so nothing is pre-classified').toBeUndefined();
		expect(s.inputConfidence.get('move'), '…but the confidence is still known').toBe('proven-turn');

		const a0 = s.posOf('A'), b0 = s.posOf('B');
		s.apply('A', { kdType: 'move', data: { dir: { x: b0.x - a0.x, y: b0.y - a0.y }, delta: 1, AllowInteract: true } });
		s.apply('B', { kind: 'wait' });
		expect(s.posOf('A'), 'the ally blocked the move').toEqual(a0);
		expect(s.inputKind.get('move'), 'and it stayed in lockstep').toBe('turn');
	}, BOOT_TIMEOUT);
});

describe('KDM-197 runtime learning', () => {
	let s: any;

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'apply-commit-seed', seedInputKinds: true });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	/**
	 * The measured producer, end to end, on the production path (`seedInputKinds: true`, PvP off).
	 * Nothing is stubbed: a real lockstep turn in which A walks into B.
	 */
	it('a move blocked by the co-op peer does not take "move" out of lockstep', () => {
		expect(s.inputKind.get('move'), 'seeded from the bundle').toBe('turn');

		const a0 = s.posOf('A'), b0 = s.posOf('B');
		const dx = b0.x - a0.x, dy = b0.y - a0.y;
		expect(Math.max(Math.abs(dx), Math.abs(dy)),
			'setup: the two players must spawn adjacent for this bump to happen').toBe(1);

		const turn0 = s.turn;
		s.apply('A', { kdType: 'move', data: { dir: { x: dx, y: dy }, delta: 1, AllowInteract: true } });
		s.apply('B', { kind: 'wait' });
		expect(s.turn, 'the bump went through lockstep').toBe(turn0 + 1);
		// it really was a no-op — otherwise there is nothing to learn from and the test is vacuous
		expect(s.posOf('A'), 'A did not move: the ally blocks and KD returns "nomove"').toEqual(a0);
		expect(s.cancelledMoveReport().length,
			'and it was NOT the KDM-208 veto — that guard is already covered elsewhere').toBe(0);

		expect(s.inputKind.get('move'),
			'ONE non-advancing bump must not demote the type that KD proves can advance').toBe('turn');

		// the consequence that actually matters: the NEXT move still goes through lockstep
		const turn1 = s.turn;
		const res = s.apply('A', { kdType: 'move', data: { dir: { x: -dx, y: -dy }, delta: 1, AllowInteract: true } });
		expect(res.kind, 'a move must never be applied outside lockstep').toBe('turn');
		expect(s.turn, 'it is waiting on B, exactly like any turn-consuming input').toBe(turn1);
		s.apply('B', { kind: 'wait' });
		expect(s.turn).toBe(turn1 + 1);
	}, BOOT_TIMEOUT);

	/**
	 * The learning RULE, isolated from the game. `applyInputObserved` is stubbed for one synthetic
	 * type so the observation sequence is exact — a mod-registered handler cannot be used here,
	 * because KDM-161's divergence capture restores any global it mutates, so the "later calls do
	 * nothing" arm would silently reset itself and pass for the wrong reason.
	 */
	function observations(type: string, advancedSeq: number[]) {
		const real = s.world.applyInputObserved.bind(s.world);
		let i = 0;
		const calls: number[] = [];
		s.world.applyInputObserved = (t: string, d: any) => {
			if (t !== type) return real(t, d);
			const advanced = advancedSeq[Math.min(i++, advancedSeq.length - 1)];
			calls.push(advanced);
			return { advanced, result: null, error: null, unknownType: false };
		};
		return {
			calls,
			turn: () => { s.apply('A', { kdType: type, data: {} }); s.apply('B', { kind: 'wait' }); },
			restore: () => { delete s.world.applyInputObserved; },
		};
	}

	/** AC1: a type with no static proof still needs more than one observation to leave lockstep. */
	it('an unproven type is demoted only after corroborating observations', () => {
		const need = s.uiDemotionEvidence;
		expect(need, 'the evidence threshold is configurable and > 1').toBeGreaterThan(1);

		const o = observations('kdm197Inert', [0]);
		try {
			for (let i = 1; i <= need; i++) {
				o.turn();
				if (i < need) {
					expect(s.inputKind.get('kdm197Inert'),
						`observation ${i}/${need} is not enough evidence to leave lockstep`).toBe('turn');
				}
			}
			expect(o.calls, 'the stub really was consulted, once per turn').toEqual(new Array(need).fill(0));
			expect(s.inputKind.get('kdm197Inert'),
				'corroborated: it has never advanced, so stop charging a turn for it').toBe('ui');

			const turn0 = s.turn;
			expect(s.apply('A', { kdType: 'kdm197Inert', data: {} }).kind).toBe('ui');
			expect(s.turn, 'a learned UI type consumes no turn').toBe(turn0);
		} finally { o.restore(); }
	}, BOOT_TIMEOUT);

	/** AC2/AC4: a type that VARIES is pinned to the safe side by its first advancing observation. */
	it('a type observed to advance is never demoted again, however often it later does nothing', () => {
		const need = s.uiDemotionEvidence;
		const o = observations('kdm197Vary', [1, 0]);
		try {
			o.turn();
			expect(s.inputKind.get('kdm197Vary'), 'it advanced → turn').toBe('turn');

			for (let i = 0; i < need + 2; i++) {
				const res = s.apply('A', { kdType: 'kdm197Vary', data: {} });
				expect(res.kind, 'a type that has ever advanced stays in lockstep').toBe('turn');
				s.apply('B', { kind: 'wait' });
			}
			expect(o.calls.slice(1).every((a) => a === 0),
				'the later observations really were non-advancing').toBe(true);
			expect(o.calls.length).toBe(need + 3);
			expect(s.inputKind.get('kdm197Vary'),
				'a SOMETIMES turn-consuming type must keep the safe classification').toBe('turn');
		} finally { o.restore(); }
	}, BOOT_TIMEOUT);
});
