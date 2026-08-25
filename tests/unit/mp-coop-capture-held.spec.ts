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
 * HOW A CAPTURE IS DRIVEN HERE, AND WHY IT IS NOT CHEATING. `armCapture` calls KD's real
 * `KinkyDungeonDefeat(true, …)` from inside `KinkyDungeonAdvanceTime` — i.e. from inside an acting
 * player's apply window, which is exactly where a real capture happens (`KDRunDefeatForEnemy`,
 * `KinkyDungeonEnemies.ts:5040`, runs at the end of a time advance). Reproducing a genuine leash
 * chase would make these tests about the leash machinery instead; `mp-party-lands-together` avoided
 * it for the same reason. What is NOT faked is the thing under test: the `PutInJail` argument and
 * everything KD does with it.
 *
 * ⚠️ WHICH PLAYER IS CAPTURED IS FENCED, NOT ASSUMED. `_advanceTurn` does not apply in join order —
 * measured: an unfenced hook fired during **B's** apply. So the hook reads `__KD_PARTY_GATE`, which
 * `_pushPartyGate` refreshes immediately before every dispatch with the OTHER players' names, and
 * fires only when the intended actor is the one swapped in. Without that fence the R1 assertion
 * ("the partner did not move") silently becomes an assertion about the captured player instead.
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
import { mapId as worldMapId } from './helpers/world';

const BOOT_TIMEOUT = 300_000;

/**
 * Arm ONE forced capture, to fire during `actor`'s next apply window and no one else's.
 *
 * The hook is installed once and re-armed per use. It sits UNDER the counting wrapper
 * `applyInputObserved` installs for the duration of a dispatch (`headless-host.js`), so the call
 * still reaches it.
 *
 * (No backtick and no `\n` escape below: this is a template literal, and TypeScript would resolve
 * both before the world ever saw the source — memory `backtick-in-template-literal`.)
 */
function armCapture(s: any, actor: string) {
	const actorName = s.displayNameOf(actor);
	return s.world.eval(`(function(){
		if (!globalThis.__kdTestCaptureHook) {
			var _prev = KinkyDungeonAdvanceTime;
			KinkyDungeonAdvanceTime = function () {
				var r = _prev.apply(this, arguments);
				var gate = globalThis.__KD_PARTY_GATE;
				var peers = (gate && gate.peers) || [];
				var mine = false;
				for (var i = 0; i < peers.length; i++) {
					if (peers[i].name === globalThis.__kdTestCaptureActor) mine = true;
				}
				// The gate lists everyone EXCEPT whoever is acting, so our actor being absent from it
				// is what says they are the one swapped in right now.
				if (globalThis.__kdTestCaptureArmed && !mine) {
					globalThis.__kdTestCaptureArmed = false;
					try { KinkyDungeonDefeat(true, undefined); globalThis.__kdTestCaptureRan = 'ok'; }
					catch (e) { globalThis.__kdTestCaptureRan = 'threw: ' + e.message; }
				}
				return r;
			};
			globalThis.__kdTestCaptureHook = true;
		}
		globalThis.__kdTestCaptureActor = ${JSON.stringify(actorName)};
		globalThis.__kdTestCaptureArmed = true;
		globalThis.__kdTestCaptureRan = 'never ran';
		return true;
	})()`);
}

/**
 * What the forced call returned. NOT simply `'ok'`: the LAST statement of `KinkyDungeonDefeat` is
 * `KinkyDungeonSaveGame()` (`KinkyDungeonJail.ts:1894`), which throws headlessly reading `Poses` off
 * the paper doll `_neuterRendering` deliberately never builds — the exact twin of the stair autosave
 * KDM-240 stubbed, filed separately as **KDM-267**.
 *
 * That throw is orthogonal to this task: it happens on BOTH sides of the `PutInJail` fork, after
 * everything the fork decides (the map change is at `:1725`, the throw at `:1894`). So it is
 * TOLERATED here — but named EXACTLY, so a new failure mode cannot hide behind it, and `'never ran'`
 * still fails. When KDM-267 lands, tighten this to `'ok'`.
 */
const KNOWN_OUTCOME = /^(?:ok$|threw: Cannot read properties of undefined \(reading 'Poses'\)$)/;
function captureRan(s: any): string { return s.world.eval('globalThis.__kdTestCaptureRan'); }

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
			armCapture(s, 'A');
			turn();
			expect(captureRan(s)).toMatch(KNOWN_OUTCOME);
			expect(timesJailed(s, 'A')).toBe(jailed0 + 1);   // the defeat really ran, on A
			expect(worldMapId(s)).toBe(before);              // R2: no CreateMap, nobody relocated
			expect(s.posOf('B')).toEqual(posB);              // R2: the uncaptured partner did not move
		}, BOOT_TIMEOUT);

		/** R6 — everybody hears it, once. */
		it('tells the whole party, once, that their partner is held', () => {
			armCapture(s, 'A');
			turn();
			expect(captureRan(s)).toMatch(KNOWN_OUTCOME);
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
			armCapture(s, 'A');
			turn();
			expect(captureRan(s)).toMatch(KNOWN_OUTCOME);
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
			armCapture(s, 'A');
			s.submit('A', { kind: 'wait' });
			expect(captureRan(s)).toMatch(KNOWN_OUTCOME);
			expect(worldMapId(s)).not.toBe(before);
			expect(heldLines(s, 'A')).toBe(0);
		}, BOOT_TIMEOUT);
	});
});
