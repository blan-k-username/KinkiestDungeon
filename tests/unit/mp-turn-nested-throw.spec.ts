/**
 * Node-layer (Vitest) — an exception thrown inside a NESTED player apply is contained: blamed on the
 * player whose apply threw, the round's state is put back consistently, and the session carries on.
 *
 * THE SHAPE. With nested ticks (`SwapSession._applyOne`), player B's whole apply runs INSIDE player
 * A's own engine call: A's dispatch reaches `KinkyDungeonUpdateEnemies`, whose `installTurnModel` wrap
 * fires the one-shot nested-dispatch callback, which recurses into B's apply. B's own DISPATCH is
 * guarded by B's own `applyInputObserved` try/catch — but everything B's apply does AROUND that
 * dispatch (swap-in, peer arming, owner tagging, the slot-switch bookkeeping, the swap-out commit) is
 * host-side code with no guard of its own. A throw there unwinds straight through A's
 * `KinkyDungeonAdvanceTime` into A's `applyInputObserved` catch, which:
 *   - records the failure against A (wrong player);
 *   - lets A's own swap-out run with B still in the slot, so A's bundle and avatar take B's state;
 *   - leaves B's avatar parked off-board (B never reached its own swap-out);
 *   - can leave session-control flags armed (the slot switch, if the throw follows B's dispatch).
 *
 * THE INJECTION. Two host-side seams, one either side of B's real dispatch, stubbed on the INSTANCE
 * (never on the prototype) so nothing leaks to another spec:
 *   - `before`: `SwapSession._armPeerEnemies` — runs after B is swapped in, before B dispatches;
 *   - `after`:  `HeadlessHost.tagOwnedBullets` — runs after B's dispatch (and, for the round's last
 *               apply, after the one real tick) but before B's slot-switch disarm.
 * Each stub records `__kdInTick` at the moment it throws: > 0 proves the throw really happened while an
 * OUTER player's engine call was on the stack — i.e. that this spec exercises nesting at all.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;
const BOOM = 'kdm332 injected nested-apply failure';

type Seam = 'before' | 'after';

/** Make `victim`'s NEXT apply throw at `seam`, once. Answers a probe the test reads back. */
function armHostThrow(s: any, victim: string, seam: Seam) {
	const probe = { fired: false, inTick: -1 };
	const fire = () => {
		probe.fired = true;
		probe.inTick = s.world.eval('globalThis.__kdInTick') | 0;
		throw new Error(BOOM);
	};
	if (seam === 'before') {
		const orig = s._armPeerEnemies.bind(s);
		s._armPeerEnemies = (id: string) => { if (id === victim && !probe.fired) fire(); return orig(id); };
	} else {
		const orig = s.world.tagOwnedBullets.bind(s.world);
		s.world.tagOwnedBullets = (id: string) => { if (id === victim && !probe.fired) fire(); return orig(id); };
	}
	return probe;
}

/** The player position stored in a client's own BUNDLE (not its avatar) — read without disturbing it. */
function bundlePos(s: any, id: string) {
	s.world.restorePlayer(s.bundles.get(id));
	const p = s.world.getPlayerPos();
	s.world.parkGlobalPlayer(1, 1);   // PARK, as `_advanceTurn` leaves it
	return { x: p.x, y: p.y };
}

/** The session-control flags a round must leave behind clean. */
function roundFlags(s: any) {
	return s.world.eval(`({
		inTick: globalThis.__kdInTick | 0,
		nested: typeof globalThis.__kdNestedDispatch,
		slotSwitch: !!globalThis.__kdSlotSwitch,
		muted: !!globalThis.__kdWorldMuted,
	})`);
}

function submitAll(s: any, ids: string[]) { for (const id of ids) s.submit(id, { kind: 'wait' }); }

async function boot(ids: string[], seed: string) {
	const s = new SwapSession({ requiredPlayers: ids.length, seed, pvp: false });
	for (const id of ids) s.join(id);
	await s.ready();
	s._shuffle = () => ids.slice();    // deterministic order: ids[0] applies first, the last hosts the tick
	return s;
}

/**
 * The whole contract for one throw: blame, consistent state, clean flags, next round resolves.
 * `ids` is the apply order; `victim` is whose nested apply throws.
 */
function expectContained(s: any, ids: string[], victim: string, probe: { fired: boolean, inTick: number },
	before: Record<string, { avatar: any, bundle: any }>, turn0: number) {
	expect(probe.fired, 'premise: the injected throw fired').toBe(true);
	expect(probe.inTick, "premise: it fired NESTED, inside an outer player's engine call").toBeGreaterThan(0);

	// BLAME — exactly one record, the victim's, carrying the error.
	const failed = s.failedInputReport();
	expect(failed.map((f: any) => f.clientId), 'the failure is blamed on the player whose apply threw')
		.toEqual([victim]);
	expect(String(failed[0].error)).toContain(BOOM);
	expect(failed[0].turn).toBe(turn0);
	expect(s.turn, 'the round still completed').toBe(turn0 + 1);

	// CONSISTENT STATE — every player still owns their OWN state. A wait moves nobody, so each
	// avatar and each bundle must be exactly where that player stood before the round.
	for (const id of ids) {
		expect(s.posOf(id), `${id}'s avatar is back on its own tile (not parked, not someone else's)`)
			.toEqual(before[id].avatar);
		expect(bundlePos(s, id), `${id}'s bundle still holds ${id}'s own position`).toEqual(before[id].bundle);
	}

	// CLEAN FLAGS — nothing from the aborted apply survives into the next round.
	expect(roundFlags(s)).toEqual({ inTick: 0, nested: 'object', slotSwitch: false, muted: false });
	expect(s.world.eval('globalThis.__kdNestedDispatch'), 'no armed nested callback left behind').toBeNull();
}

function snapshotPositions(s: any, ids: string[]) {
	const out: Record<string, { avatar: any, bundle: any }> = {};
	for (const id of ids) out[id] = { avatar: s.posOf(id), bundle: bundlePos(s, id) };
	// Control for the oracle: the players stand on DIFFERENT tiles, so "A took B's state" is visible.
	const tiles = new Set(ids.map((id) => `${out[id].bundle.x},${out[id].bundle.y}`));
	expect(tiles.size, 'setup: every player stands on a distinct tile').toBe(ids.length);
	return out;
}

/** The next round resolves normally: no new failure, every player applied, the clock moves. */
function expectNextRoundResolves(s: any, ids: string[]) {
	const turn1 = s.turn;
	const failedBefore = s.failedInputReport().length;
	const tick0 = s.world.eval('KinkyDungeonCurrentTick');
	submitAll(s, ids);
	expect(s.turn, 'the next round advanced').toBe(turn1 + 1);
	expect(s.failedInputReport().length, 'the next round records no failure').toBe(failedBefore);
	expect(s.lastTurn.applied.map((a: any) => a && a.id), 'every player applied in the next round').toEqual(ids);
	expect(s.world.eval('KinkyDungeonCurrentTick'), 'the world clock advanced exactly one round').toBe(tick0 + 1);
	expect(roundFlags(s)).toEqual({ inTick: 0, nested: 'object', slotSwitch: false, muted: false });
}

describe('a throw inside a nested player apply is contained', () => {
	for (const seam of ['before', 'after'] as Seam[]) {
		it(`2 players — B (nested in A) throws ${seam} its dispatch: blamed on B, A untouched`, async () => {
			const ids = ['A', 'B'];
			const s = await boot(ids, `nested-throw-2-${seam}`);
			const before = snapshotPositions(s, ids);
			const turn0 = s.turn;
			const probe = armHostThrow(s, 'B', seam);
			submitAll(s, ids);
			expectContained(s, ids, 'B', probe, before, turn0);
			expectNextRoundResolves(s, ids);
		}, BOOT_TIMEOUT);
	}

	it('3 players — C (nested two deep, in B in A) throws: blamed on C, A and B untouched', async () => {
		const ids = ['A', 'B', 'C'];
		const s = await boot(ids, 'nested-throw-3-deep');
		const before = snapshotPositions(s, ids);
		const turn0 = s.turn;
		const probe = armHostThrow(s, 'C', 'after');
		submitAll(s, ids);
		expect(probe.inTick, 'premise: two outer engine calls (A, B) were on the stack').toBeGreaterThanOrEqual(2);
		expectContained(s, ids, 'C', probe, before, turn0);
		expectNextRoundResolves(s, ids);
	}, BOOT_TIMEOUT);

	it('3 players — B (the middle, non-host) throws before dispatching: the rest of the round still runs', async () => {
		const ids = ['A', 'B', 'C'];
		const s = await boot(ids, 'nested-throw-3-mid');
		const before = snapshotPositions(s, ids);
		const turn0 = s.turn;
		const tick0 = s.world.eval('KinkyDungeonCurrentTick');
		const probe = armHostThrow(s, 'B', 'before');
		submitAll(s, ids);
		expectContained(s, ids, 'B', probe, before, turn0);
		// B never dispatched, so it never handed the round on — C (the host) must still have applied and
		// hosted the round's one real tick.
		expect(s.lastTurn.applied[2] && s.lastTurn.applied[2].id, 'C still applied').toBe('C');
		expect(s.world.eval('KinkyDungeonCurrentTick'), "the round's one real tick still ran").toBe(tick0 + 1);
		expectNextRoundResolves(s, ids);
	}, BOOT_TIMEOUT);

	/** CONTROL — the same 3-player nesting with no injection records nothing and stays clean. */
	it('control: a clean 3-player nested round records no failure', async () => {
		const ids = ['A', 'B', 'C'];
		const s = await boot(ids, 'nested-throw-3-control');
		snapshotPositions(s, ids);
		expectNextRoundResolves(s, ids);
		expect(s.failedInputReport()).toEqual([]);
	}, BOOT_TIMEOUT);
});
