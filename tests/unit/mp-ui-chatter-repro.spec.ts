/**
 * KDM-163 — ISOLATION of the `mp-coop-demo.spec.ts:108` failure, at the node layer.
 *
 * With the client's hardcoded lists deleted and the static seed ON, the browser spec's routed
 * bump-attack stopped damaging the world enemy:
 *
 *     expect(enemyAfter == null || enemyAfter.hp < enemyHp0).toBe(true)   // Expected: true, Received: false
 *
 * The handoff recorded an UNVERIFIED hypothesis (seeded KDRandom drift shifting enemy AI). This file
 * tests a DIFFERENT, measured mechanism instead, so the answer comes from a run rather than a guess.
 *
 * The mechanism under test: deleting the lists does not merely route "a few more inputs". It routes
 * `KinkyDungeonSetMoveDirection` (Game/src/base/game/KinkyDungeonDraw.ts:3045), which fires
 * `KDSendInput("setMoveDirection", …)` from the DRAW path — i.e. once per FRAME, off the mouse
 * position. Every one of those becomes a server-side immediate `ui` apply
 * (restorePlayer → dispatch → capturePlayer → parkGlobalPlayer) interleaved with lockstep.
 *
 * Two candidate consequences, both asserted below:
 *   1. the per-frame `ui` applies disturb the world enough that a queued bump-attack no longer lands;
 *   2. a turn-classified input arriving while an action is already pending SILENTLY REPLACES it
 *      (`_pending` is one slot per player, swap-session.js:309) — a silent drop, which AC3 forbids.
 *
 * Deliberately NO browser: `mp-coop-demo` needs a quiet host and two co-op boots, which is how this
 * failure stayed un-isolated. If it reproduces here it is a server-side defect, full stop.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** One frame of the client's draw loop, as the deleted lists would now route it. */
const CHATTER = { kdType: 'setMoveDirection', data: { dir: { x: 0, y: -1 } } };

const BUMP = { kdType: 'move', data: { dir: { x: 0, y: 1 }, delta: 1, AllowInteract: true } };

function makeSession(seed: string) {
	const s = new SwapSession({ requiredPlayers: 2, seed, seedInputKinds: true });
	s.join('A');
	s.join('B');
	return s;
}

/** Place the shared enemy directly below A's avatar, exactly as mp-coop-demo.spec.ts:101 does. */
function armBump(s: any) {
	const aAv = s.posOf('A');
	s.world.moveAvatar(s.enemyId, aAv.x, aAv.y + 1);
	return { aAv, hp0: s.enemyView()?.hp };
}

/**
 * Each test gets its OWN session on the SAME seed. The first version shared one, and the control's
 * bump KILLED the shared Rat — every later test then read `enemyView() === null` and asserted nothing,
 * which is a vacuous green. Same seed keeps the runs comparable; separate sessions keep them honest.
 */
describe('KDM-163 — per-frame UI chatter vs the routed bump-attack', () => {

	/**
	 * CONTROL. No chatter — the same sequence the hand-list client produces. If this is red the
	 * scenario itself is wrong and nothing below means anything.
	 */
	it('CONTROL: a bump-attack with no UI chatter damages the world enemy', () => {
		const s = makeSession('chatter-repro-seed');
		const { hp0 } = armBump(s);
		expect(hp0, 'the shared enemy must be alive to be attacked').toBeGreaterThan(0);

		s.apply('A', BUMP);
		s.apply('B', { kind: 'wait' });

		const after = s.enemyView();
		expect(after == null || after.hp < hp0, `enemy hp ${hp0} -> ${after ? after.hp : 'dead'}`).toBe(true);
	}, BOOT_TIMEOUT);

	/**
	 * THE REPRODUCTION. Identical, except the client also emits per-frame `setMoveDirection` — which
	 * is what deleting `LOCAL_UI_INPUTS` actually does, since that input is sent from the draw loop.
	 */
	it('REPRO: the same bump-attack still lands with per-frame setMoveDirection chatter', () => {
		const s = makeSession('chatter-repro-seed');
		const { hp0 } = armBump(s);
		expect(hp0, 'the shared enemy must be alive to be attacked').toBeGreaterThan(0);

		for (let i = 0; i < 10; i++) s.apply('A', CHATTER);   // frames before the click
		s.apply('A', BUMP);
		for (let i = 0; i < 10; i++) s.apply('A', CHATTER);   // frames while waiting for the peer
		s.apply('B', { kind: 'wait' });

		const after = s.enemyView();
		expect(after == null || after.hp < hp0, `enemy hp ${hp0} -> ${after ? after.hp : 'dead'}`).toBe(true);
	}, BOOT_TIMEOUT);

	/** Chatter must never be able to end a turn or displace the acting player's queued action. */
	it('UI chatter neither advances the turn nor clears the pending action', () => {
		const s = makeSession('chatter-repro-seed');
		const turn0 = s.turn;
		s.apply('A', BUMP);
		expect(s.waitingOn(), 'A has acted; the turn waits on B').toEqual(['B']);
		for (let i = 0; i < 5; i++) s.apply('A', CHATTER);
		expect(s.turn, 'UI chatter must not advance the lockstep turn').toBe(turn0);
		expect(s.waitingOn(), "UI chatter must not un-submit or re-submit A's turn").toEqual(['B']);
		s.apply('B', { kind: 'wait' });
		expect(s.turn).toBe(turn0 + 1);
	}, BOOT_TIMEOUT);

	/**
	 * AC3 at the lockstep layer. `_pending` is ONE slot per player (swap-session.js:309), so a second
	 * turn-consuming input replaces the first with no record that anything was lost. That is a silent
	 * drop of a real action — the exact failure mode this task exists to remove — and it is reachable
	 * as soon as the client stops filtering what it sends.
	 */
	it('AC3: a queued action replaced by a later one is REPORTED, never silently discarded', () => {
		const s = makeSession('chatter-repro-seed');
		const { hp0 } = armBump(s);
		s.apply('A', BUMP);                                    // the real action
		s.apply('A', { kdType: 'crouch', data: {} });          // arrives before the turn resolves
		s.apply('B', { kind: 'wait' });

		const after = s.enemyView();
		const attackLanded = after == null || after.hp < hp0;
		const reported = typeof s.replacedInputReport === 'function' ? s.replacedInputReport() : [];
		expect(attackLanded || reported.length > 0,
			'either the queued attack still landed, or the displacement was reported').toBe(true);
	}, BOOT_TIMEOUT);
});

/**
 * KDM-163 — the OTHER candidate for `mp-coop-demo.spec.ts:108`, and the one that survives reading.
 *
 * `_advanceTurn` learns from a real application (swap-session.js): `seen = obs.advanced > 0 ? 'turn' : 'ui'`.
 * That treats ONE occurrence as proof about the TYPE. But turn-consuming inputs routinely no-op:
 * `KinkyDungeonMove` returns false for a blocked move without ever calling `KinkyDungeonAdvanceTime`
 * (KinkyDungeonInput.ts:11 — "move" returns "nomove"). One walk into a wall therefore DEMOTES `move`
 * to `ui`, and from then on every move is applied immediately, outside lockstep.
 *
 * `mp-coop-demo` walks A into blocked tiles on purpose — its own comment says "A starts adjacent to
 * B's avatar (an ally blocks that tile), so not every direction is open" — and only THEN performs the
 * routed bump-attack that the spec found undamaged.
 *
 * The classifier is deliberately CONSERVATIVE for exactly this reason (over-approximate: a `ui` verdict
 * means the whole resolved call graph is clean). This runtime demotion undoes that guarantee from a
 * single negative sample, in the dangerous direction.
 */
describe('KDM-163 — runtime demotion of a turn-consuming type', () => {

	it('a BLOCKED move must not reclassify `move` as a non-turn input', () => {
		const s = makeSession('demotion-seed');
		expect(s.inputKind.get('move'), 'seeded from the bundle: move can advance time').toBe('turn');

		// Walk A into every direction until one is genuinely blocked (no position change, no advance) —
		// exactly what mp-coop-demo does while hunting for an open tile.
		let blocked = false;
		for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
			const before = s.posOf('A');
			s.apply('A', { kdType: 'move', data: { dir: { x: dx, y: dy }, delta: 1, AllowInteract: true } });
			s.apply('B', { kind: 'wait' });
			const after = s.posOf('A');
			if (before && after && before.x === after.x && before.y === after.y) { blocked = true; break; }
		}
		expect(blocked, 'the scenario needs at least one blocked direction to be meaningful').toBe(true);

		expect(s.inputKind.get('move'),
			'a move that happened to be blocked says nothing about whether `move` consumes turns')
			.toBe('turn');
	}, BOOT_TIMEOUT);

	/**
	 * The consequence, stated as behaviour rather than as internal state: once demoted, a move is
	 * applied immediately on `apply()` and never reaches lockstep — so the peer's turn resolves with
	 * the acting player recorded as having done nothing.
	 */
	it('a move always resolves through lockstep, never immediately', () => {
		const s = makeSession('demotion-seed');
		for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
			const res = s.apply('A', { kdType: 'move', data: { dir: { x: dx, y: dy }, delta: 1, AllowInteract: true } });
			expect(res.kind, `move (${dx},${dy}) must enter lockstep, not apply immediately`).toBe('turn');
			s.apply('B', { kind: 'wait' });
		}
	}, BOOT_TIMEOUT);
});
