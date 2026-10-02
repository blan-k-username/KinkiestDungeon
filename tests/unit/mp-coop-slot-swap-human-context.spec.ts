/**
 * Node-layer (Vitest) — two per-human facts must be RE-DERIVED for the incoming human on every
 * mid-pass per-enemy slot switch, not just once per outer per-player apply.
 *
 * THE BUG. Inside the round's one real engine tick, `_advanceTurn` (`swap-session.js`) pushes two
 * per-human facts right before each OUTER apply's own dispatch:
 *   - the `KDEventMapGeneric` party-gate registry (`_pushPartyGate`) — "who else is in the party and
 *     where", read from `data.cancelevent`'s `beforeStairCancel` handler;
 *   - `globalThis.__kdCoopPartnerFree` (`_anyPartnerFree`) — "is anybody ELSE still up", the whole
 *     input to `kd-coop-capture.js`'s jail-vs-held decision.
 * Both used to be computed relative to the OUTER applying human (`id`) and never re-derived when the
 * per-enemy slot switch (`_slotSwapTo`, armed by `headless-host.js`'s `installTurnModel` for the
 * round's one unmuted apply) puts a DIFFERENT human in the slot mid-pass — an enemy engaged with that
 * other human would decide using the outer applicant's view of both facts, not its own. Found by the
 * slot-swap global-write audit and flagged there as a residual gap; fixed here by also re-deriving both
 * from inside `_slotSwapTo` itself, for whichever human the switch just brought in.
 *
 * ORACLE for the partner-free fact: `kd-coop-capture.js`'s own wrap around `KinkyDungeonDefeat` reads
 * `globalThis.__kdCoopPartnerFree` at the moment a capture lands and picks the jail branch (map
 * regenerates, `KinkyDungeonCreateMap`) when it is `false`, or the held branch (map unchanged, the
 * proxy's own "has been overpowered" line) when `true` — exactly the signal `mp-coop-capture-held.spec.ts`
 * already reads.
 *
 * NON-VACUITY. `__kdCoopPartnerFree` is not blacklisted from the generic per-player capture/restore, so
 * a mid-pass `_restorePlayer` of the engaged human can ALSO change its live value by accident — either
 * by carrying whatever (possibly stale) value that human's own bundle happens to hold, or, when their
 * bundle does not carry it at all, by resetting it to its post-init baseline default. Both of those are
 * a different bug (the same un-blacklisted-global clobber class `__kdWorldMuted`/`KDCustomDefeat` were
 * found as) and can coincidentally land on the right-looking answer for a simple, unchanging up/down
 * state — which is exactly why the two tests below PIN a known, explicit, WRONG value into the engaged
 * human's own bundle first (`pokeStaleBundleOnNextSwapTo`): only a FRESH, correct recompute at the moment of the
 * mid-pass switch — the fix — can produce the correct decision from there, regardless of what either of
 * those accidents would otherwise have produced.
 *
 * WHAT IS FAKED, AND WHY — same recipe as `mp-defeat-routing.spec.ts` / `mp-slot-swap-global-audit.spec.ts`:
 * `KinkyDungeonEnemyLoop` is wrapped to override only the returned `defeat`/`defeatEnemy` fields for one
 * chosen, already-engaged enemy, one shot; everything downstream (`KDRunDefeatForEnemy`,
 * `KDRunRegularJailDefeatAttempt`, `KinkyDungeonDefeat`, `kd-coop-capture.js`'s own wrap) runs for real.
 * `KDRunRegularJailDefeatAttempt` is stubbed to succeed immediately — room selection is not under test.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';
import { mapId as worldMapId } from './helpers/world';

const BOOT_TIMEOUT = 240_000;

/** `KDGameData.TimesJailed` off a player's own captured bundle — 0 if never jailed. */
function timesJailed(s: any, cid: string): number {
	const b = s.bundles.get(cid);
	return (b && b.gameData && b.gameData.TimesJailed) || 0;
}

/** The proxy's own "your partner is held" line — counted, never sliced by a saved index. */
const HELD = /has been overpowered/i;
function heldLines(s: any, cid: string): number {
	return (s.logs.get(cid) || []).map((m: any) => String(m.text || m))
		.filter((t: string) => HELD.test(t)).length;
}

/** Move a joined player's authoritative position (bundle + avatar) to (x,y) directly. */
function moveClientTo(s: any, cid: string, x: number, y: number) {
	s.world.restorePlayer(s.bundles.get(cid));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0}; })()`);
	s.bundles.set(cid, s.world.capturePlayer());
	s.world.moveAvatar(s.avatars.get(cid), x, y);
}

/** A free tile at least `min` (Chebyshev) steps from `from` — found, never assumed. */
function farTile(s: any, from: { x: number, y: number }, min: number) {
	return s.world.eval(`(function(){
		for (var r = ${min | 0}; r < ${min | 0} + 30; r++)
			for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
				var x = ${from.x | 0} + dx, y = ${from.y | 0} + dy;
				if (x <= 0 || y <= 0 || x >= KDMapData.GridWidth || y >= KDMapData.GridHeight) continue;
				if (KinkyDungeonMovableTilesEnemy.includes(KinkyDungeonMapGet(x, y)) && !KinkyDungeonEntityAt(x, y)) return { x: x, y: y };
			}
		return null;
	})()`);
}

/** Place a REAL shared enemy (by id) on a free tile beside `cid`, so "nearest" engagement picks them. */
function placeEnemyBeside(s: any, enemyId: number, cid: string) {
	const nb = freeNeighbour(s, cid);
	if (!nb) throw new Error(`setup invalid: no free tile beside ${cid}`);
	s.world.moveAvatar(enemyId, nb.x, nb.y);
}

/**
 * Force exactly ONE enemy's next real `KinkyDungeonEnemyLoop` call to report a defeat, without
 * changing anything else that call computes — same one-shot technique `mp-defeat-routing.spec.ts` and
 * `mp-slot-swap-global-audit.spec.ts` use, duplicated here (test-local, not product code) rather than
 * imported: neither file exports it.
 *
 * Also forces KD's own `LeashToPrison` flag on (`KinkyDungeonEnemies.ts:5083`,
 * `let putInJail = KinkyDungeonFlags.has("LeashToPrison")`) so `KDRunDefeatForEnemy` always chooses the
 * jail branch of `KinkyDungeonDefeat` — the thing under test is whether that jail gets downgraded to a
 * "held" (`kd-coop-capture.js`'s own wrap reading `__kdCoopPartnerFree`), not whether KD would have
 * attempted a jail in the first place.
 */
function armForcedDefeat(s: any, enemyId: number) {
	s.world.eval(`(function(){
		if (!globalThis.__kdForceDefeatWrapped) {
			var _prev = KinkyDungeonEnemyLoop;
			KinkyDungeonEnemyLoop = function(enemy){
				var ret = _prev.apply(this, arguments);
				if (enemy && enemy.id === globalThis.__kdForceDefeatEnemyId) {
					globalThis.__kdForceDefeatEnemyId = null;
					KinkyDungeonSetFlag("LeashToPrison", 10);
					return Object.assign({}, ret, { defeat: true, defeatEnemy: enemy });
				}
				return ret;
			};
			globalThis.__kdForceDefeatWrapped = true;
		}
		globalThis.__kdForceDefeatEnemyId = ${enemyId};
		return true;
	})()`);
}

/**
 * One-shot test-local hook (not product code): the FIRST time `_slotSwapTo` is called with `cid` as
 * the target this round, poke `cid`'s OWN just-captured bundle to carry an explicit, WRONG
 * `__kdCoopPartnerFree` value immediately before the real restore runs.
 *
 * WHY NOT JUST WRITE THE BUNDLE BEFORE THE ROUND. `cid` gets their OWN outer per-player apply every
 * round too (`_advanceTurn`'s loop runs `_pushPartyGate`/`_anyPartnerFree` for every joined human, not
 * only the last) — so by the time the mid-pass switch is reached, `cid`'s bundle has ALREADY been
 * re-captured with a freshly, correctly computed value from `cid`'s own apply a moment earlier in the
 * SAME round. A poke written before the round starts would be overwritten by that correct value before
 * the mid-pass switch ever reads it, making the test pass for the wrong reason regardless of the fix.
 * Hooking the exact moment `_slotSwapTo` is about to restore `cid` is what actually exercises restore
 * with a value that disagrees with the correct one — the one case that distinguishes "re-derived fresh
 * for `cid`" (the fix) from "whatever the restore happens to carry" (anything else, including the
 * generic per-player capture/restore's own clobber of this un-blacklisted global, which this scenario's
 * own round shape would otherwise coincidentally self-heal).
 */
function pokeStaleBundleOnNextSwapTo(s: any, cid: string, value: boolean) {
	const origSwap = s._slotSwapTo.bind(s);
	let armed = true;
	// eslint-disable-next-line no-param-reassign
	s._slotSwapTo = (targetId: string) => {
		if (armed && targetId === cid) {
			armed = false;
			const bundle = s.bundles.get(cid);
			if (!bundle || !bundle.globals) throw new Error(`setup invalid: ${cid} has no captured bundle yet`);
			bundle.globals.__kdCoopPartnerFree = value;
		}
		return origSwap(targetId);
	};
}

/** Stub `KDRunRegularJailDefeatAttempt` to succeed immediately — room selection is not under test. */
function stubJailRoomSelection(s: any) {
	s.world.eval(`(function(){
		if (globalThis.__kdStubJailAttempt) return true;
		KDRunRegularJailDefeatAttempt = function(){ return true; };
		globalThis.__kdStubJailAttempt = true;
		return true;
	})()`);
}

describe('mid-pass slot switch re-derives per-human context for the engaged human', () => {
	describe('the partner-free fact (jail-vs-held capture decision)', () => {
		it('an enemy capturing the non-driving human decides by THAT human\'s own partner-free view, '
			+ 'not the driving human\'s', async () => {
			const s = new SwapSession({ requiredPlayers: 2, seed: 'slot-ctx-driver-down', enemyType: 'Rat', pvp: false });
			s.join('A'); s.join('B');
			await s.ready();
			expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

			// B applies FIRST (muted); A applies LAST (drives the one real tick) and is DOWN. B's OWN
			// fact ("is anybody other than B free?" = "is A free?") is NO — A is down — so the correct
			// decision for B's capture is JAIL (nobody left to be rescued by). B's bundle is poked to
			// carry the OPPOSITE, WRONG value (`true`) — exactly what an un-re-derived restore would
			// read if it happened to carry a stale "somebody's free" from an earlier, different moment —
			// so only a FRESH recompute for B at the mid-pass switch can produce the correct JAIL here.
			s._shuffle = () => ['B', 'A'];
			s.defeated.add('A');

			const far = farTile(s, s.posOf('B'), 12);
			expect(far, 'setup: a tile far from B').not.toBeNull();
			moveClientTo(s, 'A', far.x, far.y);

			placeEnemyBeside(s, s.enemyId, 'B');
			armForcedDefeat(s, s.enemyId);
			stubJailRoomSelection(s);
			pokeStaleBundleOnNextSwapTo(s, 'B', true);

			const before = worldMapId(s);
			s.submit('B', { kind: 'wait' });
			s.submit('A', { kind: 'wait' });

			expect(timesJailed(s, 'B'), 'the engaged human really was defeated').toBe(1);
			expect(worldMapId(s), 'nobody is left free to rescue B — this must JAIL, not hold')
				.not.toBe(before);
			expect(heldLines(s, 'B'), 'must not be announced as "held" when nobody is actually free')
				.toBe(0);
		}, BOOT_TIMEOUT);

		it('symmetric: an enemy capturing an already-down human must still check the DRIVING human\'s '
			+ 'own free status, not the driving human\'s stale view of the engaged human', async () => {
			const s = new SwapSession({ requiredPlayers: 2, seed: 'slot-ctx-engaged-down', enemyType: 'Rat', pvp: false });
			s.join('A'); s.join('B');
			await s.ready();
			expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

			// B applies FIRST (muted); A applies LAST (drives, and is UP). B is already marked down (a
			// second capture lands on them here) — B's OWN fact ("is anybody other than B free?" =
			// "is A free?") is YES, A is up, so the correct decision is HOLD (A could still rescue). B's
			// bundle is poked to carry the OPPOSITE, WRONG value (`false`) — the mirror of the test
			// above — so only a FRESH recompute for B at the mid-pass switch can produce the correct
			// HOLD here.
			s._shuffle = () => ['B', 'A'];
			s.defeated.add('B');

			const far = farTile(s, s.posOf('B'), 12);
			expect(far, 'setup: a tile far from B').not.toBeNull();
			moveClientTo(s, 'A', far.x, far.y);

			placeEnemyBeside(s, s.enemyId, 'B');
			armForcedDefeat(s, s.enemyId);
			stubJailRoomSelection(s);
			pokeStaleBundleOnNextSwapTo(s, 'B', false);

			const before = worldMapId(s);
			s.submit('B', { kind: 'wait' });
			s.submit('A', { kind: 'wait' });

			expect(timesJailed(s, 'B'), 'the engaged human really was defeated').toBe(1);
			expect(worldMapId(s), 'A is still free to rescue — this must HOLD, not jail').toBe(before);
			expect(heldLines(s, 'B'), 'must be announced as "held" — A is still free').toBe(1);
		}, BOOT_TIMEOUT);
	});

	describe('the party-gate registry', () => {
		it('lists peers relative to whoever the mid-pass switch just put in the slot, not the '
			+ 'outer applicant', async () => {
			const s = new SwapSession({ requiredPlayers: 2, seed: 'slot-ctx-party-gate', enemyType: 'Rat', pvp: false });
			s.join('A'); s.join('B');
			await s.ready();
			expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

			// B applies FIRST (muted); A applies LAST (drives). Nobody is down — this isolates the
			// party-gate fact from the partner-free fact tested above.
			s._shuffle = () => ['B', 'A'];

			const far = farTile(s, s.posOf('B'), 12);
			expect(far, 'setup: a tile far from B').not.toBeNull();
			moveClientTo(s, 'A', far.x, far.y);

			placeEnemyBeside(s, s.enemyId, 'B');
			armForcedDefeat(s, s.enemyId);
			stubJailRoomSelection(s);

			// Test-local wrap (not product code): snapshot `__KD_PARTY_GATE` right after any swap INTO
			// B fires — the moment a mid-pass switch has put B in the slot.
			const origSwap = s._slotSwapTo.bind(s);
			let gateWhenB: any = null;
			// eslint-disable-next-line no-param-reassign
			s._slotSwapTo = (targetId: string) => {
				origSwap(targetId);
				if (targetId === 'B' && gateWhenB === null) {
					gateWhenB = s.world.eval('globalThis.__KD_PARTY_GATE');
				}
			};

			s.submit('B', { kind: 'wait' });
			s.submit('A', { kind: 'wait' });

			expect(gateWhenB, 'setup: the mid-pass switch to B must actually have fired').not.toBeNull();
			const names = (gateWhenB.peers || []).map((p: any) => p.name);
			expect(names, 'relative to B, the only peer is A — not B itself')
				.toEqual([s.displayNameOf('A')]);
		}, BOOT_TIMEOUT);
	});

	describe('one-player parity', () => {
		it('a solo session\'s capture is unaffected — there is no second human to re-derive context for', async () => {
			const s = new SwapSession({ requiredPlayers: 1, seed: 'slot-ctx-solo', enemyType: 'Rat', pvp: false });
			s.join('A');
			await s.ready();
			expect(s.enemyId, 'setup: the shared enemy exists').not.toBeNull();

			placeEnemyBeside(s, s.enemyId, 'A');
			armForcedDefeat(s, s.enemyId);
			stubJailRoomSelection(s);

			const before = worldMapId(s);
			s.submit('A', { kind: 'wait' });

			// `timesJailed` (read off `s.bundles.get('A').gameData.TimesJailed`) is not used here: a
			// solo session's own bundle for the ONLY joined human is never captured mid-pass the way a
			// second human's is in the two-player tests above (there is nobody to swap to), so nothing
			// re-captures it after this capture lands — `worldMapId`/`heldLines` (the same oracle
			// `mp-coop-capture-held.spec.ts`'s own "one player" control uses) are what actually prove a
			// real, un-held jail happened.
			expect(worldMapId(s), 'alone, there is nobody free — jails exactly as before').not.toBe(before);
			expect(heldLines(s, 'A'), 'alone, a capture is never announced as held').toBe(0);
		}, BOOT_TIMEOUT);
	});
});
