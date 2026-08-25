/**
 * KDM-261 — one player's capture must not drag the whole party into the jail map.
 *
 * THE BUG. `KinkyDungeonDefeat(PutInJail = true)` calls `KinkyDungeonCreateMap`
 * (`Game/src/prison/KinkyDungeonJail.ts:1725`) and moves the player into a freshly generated jail
 * outpost. `KDMapData` is shared world state — there is exactly ONE world — so the partner who was
 * never captured is relocated with them. KDM-240 made that coherent (everybody lands, everybody keeps
 * an avatar, everybody is told) but did not stop it happening.
 *
 * THE RULE (owner decision, 2026-08-24). **Jail only when nobody is free.** While any partner is
 * still up, the capture resolves as `KinkyDungeonDefeat(PutInJail = false)` — KD's OWN branch
 * (`:1627`), which runs `KDDefeatedPlayerTick`, binds and blinds the player, and leaves them on the
 * current map. No `KinkyDungeonCreateMap`, so nobody moves. Once the whole party is down the jail
 * move fires unchanged, and relocating everyone is then correct.
 *
 * HOW A CAPTURE IS DRIVEN. `armCapture` (tests/unit/helpers/world.ts) calls KD's real
 * `KinkyDungeonDefeat(true, …)` from inside `KinkyDungeonAdvanceTime` — where a real capture runs it.
 * It lives in the shared helper because its party-gate fence is load-bearing and fails GREEN when
 * wrong: `_advanceTurn` applies in NO fixed order (measured: **B** first), so an unfenced hook turns
 * "the partner did not move" into an assertion about the captured player. `true` = contain the
 * throw, so these tests can ask which BRANCH ran; KDM-267 passes `false` to ask a different question.
 *
 * NON-VACUITY (memory `vacuous-oracle-divergence`), on two legs:
 *   - `timesJailed` proves the defeat body really ran in the held case, so "the map did not change"
 *     cannot pass because nothing happened;
 *   - `party is wiped` and `single player` drive the IDENTICAL forced capture and REQUIRE the map to
 *     change, so "the map never changes here anyway" cannot pass either.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { mapId as worldMapId, armCapture, captureRan } from './helpers/world';

const BOOT_TIMEOUT = 300_000;


/**
 * KD's own count of how many times THIS player has been jailed — incremented inside
 * `KinkyDungeonDefeat` (`KinkyDungeonJail.ts:1634`) on both sides of the fork. Read from the
 * player's own bundle, not the live world: after a turn the world holds whichever player was
 * applied last.
 *
 * ⚠️ Only meaningful when the map did NOT change. On a real map change `_onMapChanged` re-seats
 * every player from their PRE-apply bundle and re-captures (`swap-session.js:2098-2101`), which
 * discards the acting player's own gameData changes from that apply. So the jail-path tests below
 * assert on the map change itself, not on this counter.
 */
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

describe('KDM-261 — a capture jails the party only when nobody is left free', () => {
	describe('two players', () => {
		let s: any;
		beforeEach(async () => {
			s = new SwapSession({ requiredPlayers: 2, seed: 'capture-held', pvp: false });
			s.join('A'); s.join('B');
			await s.ready();
		}, BOOT_TIMEOUT);

		function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

		/** R1/R2 — B is free, so A's capture must not regenerate the map. */
		it('holds the capture in place while the partner is free', () => {
			const before = worldMapId(s);
			const posB = s.posOf('B');
			const jailed0 = timesJailed(s, 'A');
			armCapture(s, 'A', true);
			turn();
			expect(captureRan(s)).toBe('ok');
			expect(timesJailed(s, 'A')).toBe(jailed0 + 1);   // the defeat really ran, on A
			expect(worldMapId(s)).toBe(before);              // R2: no CreateMap, nobody relocated
			expect(s.posOf('B')).toEqual(posB);              // R2: the uncaptured partner did not move
		}, BOOT_TIMEOUT);

		/** R6 — everybody hears it, once. */
		it('tells the whole party, once, that their partner is held', () => {
			armCapture(s, 'A', true);
			turn();
			expect(captureRan(s)).toBe('ok');
			expect(heldLines(s, 'A')).toBe(1);
			expect(heldLines(s, 'B')).toBe(1);
		}, BOOT_TIMEOUT);

		/**
		 * R3 CONTROL — the party IS wiped, so the jail move fires and the map really does change.
		 *
		 * `s.defeated` is the session's own down-marker and is exactly what the rule reads, so
		 * setting it states the precondition rather than bypassing the rule under test. Without this
		 * case the R1 assertion above would pass on a build where a capture can never jail at all.
		 */
		it('jails the party once nobody is free', () => {
			const before = worldMapId(s);
			s.defeated.add('B');
			armCapture(s, 'A', true);
			turn();
			expect(captureRan(s)).toBe('ok');
			expect(worldMapId(s)).not.toBe(before);          // R3: the jail move fired, unchanged
			expect(heldLines(s, 'A')).toBe(0);               // …and it is not announced as a hold
		}, BOOT_TIMEOUT);
	});

	/** R8 CONTROL — one player, so the rule never engages and KD's argument is passed through. */
	describe('one player', () => {
		let s: any;
		beforeEach(async () => {
			s = new SwapSession({ requiredPlayers: 1, seed: 'capture-solo', pvp: false });
			s.join('A');
			await s.ready();
		}, BOOT_TIMEOUT);

		it('leaves single-player capture exactly as it was', () => {
			const before = worldMapId(s);
			armCapture(s, 'A', true);
			s.submit('A', { kind: 'wait' });
			expect(captureRan(s)).toBe('ok');
			expect(worldMapId(s)).not.toBe(before);
			expect(heldLines(s, 'A')).toBe(0);
		}, BOOT_TIMEOUT);
	});
});
