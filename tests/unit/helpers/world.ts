/**
 * KDM-262/265: driving a REAL floor transition in a SwapSession, shared by every spec that needs one.
 *
 * It is here rather than copied into each spec because getting `descend()` wrong does not fail — it
 * passes VACUOUSLY, twice over (see the two warnings below), so a second hand-written copy is a
 * second chance to reintroduce a bug that looks like a green suite.
 */

/**
 * WHICH MAP the party is on. Not the level: a capture regenerates the map at an unchanged level, and
 * the start room -> first floor move changes only `RoomType`.
 */
export function mapId(s: any): string {
	return s.world.eval(`(function(){
		return [MiniGameKinkyDungeonLevel, KDGameData.RoomType || '',
			KDMapData.mapX, KDMapData.mapY].join('|');
	})()`);
}

/**
 * A real descent, with the party gate stood down so the caller tests landing and not the gate.
 *
 * ⚠️ VACUITY TRAP 1 — ARMING THE JOURNEY TARGET IS NOT OPTIONAL. The session BOOTS on the journey
 * start room (level 0, `RoomType === 'JourneyFloor'`), and taking the stairs there does not move
 * anybody: the stock `JourneyChoice` cancel filter claims the transition and opens the journey map
 * instead (`KinkyDungeonTiles.ts:12-21`). Only once `JourneyTarget` and `UseJourneyTarget` are set
 * does that filter stand down. Measured: without the arming, `KinkyDungeonHandleStairs` returns
 * cleanly and `mapId()` never moves, so every "the party landed correctly" assertion in an earlier
 * draft of `mp-party-lands-together` was checking a map change that never happened.
 *
 * ⚠️ VACUITY TRAP 2 (KDM-265) — THE PLAYER MUST BE STANDING ON THE STAIRS. `KinkyDungeonHandleStairs`
 * passes whatever tile the player occupies to `KDGoThruTile` (`KDStairActions.ts:289`), and after a
 * boot that is wherever the swap parked them — measured: a wall tile. The transition still "works",
 * but it takes the INSTANT branch of `KDStairActions.ts:251` every time, so the deferred
 * `KDGenMapCallback` path is never exercised. That is precisely how KDM-265's B1 stayed invisible: a
 * test asserting "no generation was left pending" passed while never once deferring any.
 *
 * So this moves the player to the map's own `EndPosition` — the down-stairs — and takes whatever tile
 * really is there.
 *
 * ALWAYS assert `mapId()` really moved afterwards. A `'ok'` return means the call did not throw, not
 * that anything happened.
 *
 * @param actor which seated player takes the stairs (their bundle is swapped in and re-captured)
 */
export function descend(s: any, actor = 'A'): string {
	s.world.setPartyGate({ peers: [], down: [], radius: 1 });
	s.world.restorePlayer(s.bundles.get(actor));
	const out = s.world.eval(`(function(){
		var slot = KDGameData.JourneyMap[KDGameData.JourneyX + ',' + KDGameData.JourneyY];
		var c = slot && slot.Connections && slot.Connections[0];
		if (c) { KDGameData.JourneyTarget = { x: c.x, y: c.y }; KDGameData.UseJourneyTarget = true; }
		// Stand down KDs OWN escape requirement for this floor. On a real dungeon floor the stairs
		// refuse until the escape method is satisfied (find the key / beat the boss) —
		// KinkyDungeonHandleStairs checks KDCanEscape(KDGetEscapeMethod(level)) BEFORE it ever reaches
		// KDGoThruTile (KDStairActions.ts:280). Measured: this, not the gateway, is what stopped a
		// party at floor 1. "None" is KDs own no-requirement escape type (KinkyDungeonEscapeList.ts:15),
		// and EscapeMethod lives on KDMapData, i.e. shared world state.
		//
		// This helper exists to exercise TRANSITIONS, so it stands down the escape rule for the same
		// reason it stands down the party gate above. A spec about escaping must NOT use it.
		KDMapData.EscapeMethod = "None";
		var e = KDMapData.EndPosition;
		if (!e) return 'no EndPosition on this map';
		KinkyDungeonPlayerEntity.x = e.x; KinkyDungeonPlayerEntity.y = e.y;
		var tile = KinkyDungeonMapGet(e.x, e.y);
		try { KinkyDungeonHandleStairs(tile, true); return 'ok'; }
		catch (err) { return 'threw: ' + err.message; }
	})()`);
	// The stairs are driven DIRECTLY here, not through an input, so the completion the input
	// path now does (KDM-265: applyInput / applyInputObserved -> runDeferredMapGen) has to be done
	// here too — otherwise a deferred transition is still half-finished when the caller asserts.
	// Calls the PRODUCTION method, never a copy of it.
	s.world.runDeferredMapGen();
	s.bundles.set(actor, s.world.capturePlayer());
	return out;
}

/**
 * KDM-261 / KDM-267: drive a REAL capture inside a REAL apply window, shared by every spec that
 * needs one.
 *
 * It is here rather than copied into each spec for the same reason `descend` is: the part that is
 * easy to get wrong fails GREEN. Specifically the party-gate fence below — an unfenced version fires
 * during whichever player `_advanceTurn` happens to apply first (measured: **B**, not A), which
 * silently turns "the partner did not move" into an assertion about the captured player.
 *
 * WHY THIS IS NOT CHEATING. `KinkyDungeonDefeat(true, …)` is called from inside
 * `KinkyDungeonAdvanceTime`, which is exactly where a real capture runs it — `KDRunDefeatForEnemy`
 * is the last statement of that function (`KinkyDungeonEnemies.ts:5040`). Reproducing a genuine
 * leash chase would make the test about the leash machinery instead. What is NOT faked is everything
 * the capture then does.
 *
 * @param actor    which seated player must be swapped in when the capture fires
 * @param catchThrow  MANDATORY, no default — the two callers need OPPOSITE behaviour and a default
 *                    would silently give one of them the wrong one:
 *                      true  — contain the throw and record it (KDM-261 asks "which BRANCH ran?",
 *                              and needs the session to survive to be asked)
 *                      false — let it ESCAPE into the session (KDM-267 asks "does the turn survive
 *                              a capture?", which is unanswerable if the test swallows it first)
 */
export function armCapture(s: any, actor: string, catchThrow: boolean) {
	const actorName = s.displayNameOf(actor);
	// One hook, re-armed per use. It sits UNDER the counting wrapper `applyInputObserved` installs
	// for the duration of a dispatch (`headless-host.js`), so the call still reaches it.
	//
	// (No backtick and no escape sequences below: this is a template literal, and TypeScript would
	// resolve them before the world ever saw the source — memory `backtick-in-template-literal`.)
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
				// The gate lists everyone EXCEPT whoever is acting, so our actor being ABSENT from it
				// is what says they are the one swapped in right now.
				if (globalThis.__kdTestCaptureArmed && !mine) {
					globalThis.__kdTestCaptureArmed = false;
					if (globalThis.__kdTestCaptureCatch) {
						try { KinkyDungeonDefeat(true, undefined); globalThis.__kdTestCaptureRan = 'ok'; }
						catch (e) { globalThis.__kdTestCaptureRan = 'threw: ' + e.message; }
					} else {
						// Deliberately unguarded: the throw is the thing under test.
						globalThis.__kdTestCaptureRan = 'entered';
						KinkyDungeonDefeat(true, undefined);
						globalThis.__kdTestCaptureRan = 'ok';
					}
				}
				return r;
			};
			globalThis.__kdTestCaptureHook = true;
		}
		globalThis.__kdTestCaptureActor = ${JSON.stringify(actorName)};
		globalThis.__kdTestCaptureCatch = ${catchThrow ? 'true' : 'false'};
		globalThis.__kdTestCaptureArmed = true;
		globalThis.__kdTestCaptureRan = 'never ran';
		return true;
	})()`);
}

/**
 * What the armed capture did: `'ok'`, `'never ran'`, `'entered'` (it started and the throw escaped),
 * or `'threw: …'`. `'never ran'` must always fail an assertion — a hook that silently did nothing
 * turns every downstream expectation into a green statement about nothing.
 */
export function captureRan(s: any): string { return s.world.eval('globalThis.__kdTestCaptureRan'); }
