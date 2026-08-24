/**
 * KDM-262: driving a REAL floor transition in a SwapSession, shared by every spec that needs one.
 *
 * Extracted verbatim from `mp-party-lands-together.spec.ts`, which had the only working copy. It is
 * here rather than copied because getting `descend()` wrong does not fail — it passes VACUOUSLY (see
 * the warning on `descend` below), so a second hand-written copy is a second chance to reintroduce a
 * bug that looks like a green suite.
 */

/**
 * WHICH MAP the party is on. Not the level: a capture regenerates the map at an unchanged level, and
 * the hub -> first floor move changes only `RoomType`.
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
 * ⚠️ ARMING THE JOURNEY TARGET IS NOT OPTIONAL, and getting this wrong made an earlier draft of
 * `mp-party-lands-together` pass vacuously. The session BOOTS on the journey start room (level 0,
 * `RoomType === 'JourneyFloor'`), and taking the stairs from there does not move anybody: the stock
 * `JourneyChoice` cancel filter claims the transition and opens the journey map instead
 * (`KinkyDungeonTiles.ts:12-21`). Only once `JourneyTarget` and `UseJourneyTarget` are set does that
 * filter stand down and the SECOND pass actually advance. Measured: without the arming,
 * `KinkyDungeonHandleStairs` returns cleanly and `mapId()` never moves, so every "the party landed
 * correctly" assertion was checking a map change that never happened.
 *
 * ALWAYS assert `mapId()` really moved afterwards. This helper returning `'ok'` means the call did
 * not throw — not that anything happened.
 *
 * @param actor which seated player takes the stairs (their bundle is swapped in and re-captured)
 */
export function descend(s: any, actor = 'A'): string {
	s.world.setPartyGate({ peers: [], down: [], radius: 1 });
	s.world.restorePlayer(s.bundles.get(actor));
	const out = s.world.eval(`(function(){
		var slot = KDGameData.JourneyMap[KDGameData.JourneyX + ',' + KDGameData.JourneyY];
		var c = slot && slot.Connections && slot.Connections[0];
		if (!c) return 'no journey connection to descend to';
		KDGameData.JourneyTarget = { x: c.x, y: c.y };
		KDGameData.UseJourneyTarget = true;
		try { KinkyDungeonHandleStairs('s', true); return 'ok'; }
		catch (e) { return 'threw: ' + e.message; }
	})()`);
	s.bundles.set(actor, s.world.capturePlayer());
	return out;
}
