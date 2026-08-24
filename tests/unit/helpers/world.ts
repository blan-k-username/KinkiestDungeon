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
