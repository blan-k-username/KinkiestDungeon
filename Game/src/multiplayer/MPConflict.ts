/* =========================================================================
 * MP host-side conflict resolution.
 *
 * When both players' actions are applied on the host in a single turn,
 * simultaneous moves can target the same tile. The host resolves this
 * authoritatively with its seeded RNG so the outcome is reproducible and
 * save/load-stable: exactly one player moves, the other holds.
 *
 * Other conflict classes are handled elsewhere or for free:
 *   - NPC intent: the guest renders the host's broadcast result, so "host
 *     decides" is automatic via state_sync — no resolver code needed.
 *   - Cross-dungeon follow: the nearest-free-tile spawn reuses
 *     KinkyDungeonGetNearbyPoint (as KDSpawnPlayer2 already does).
 *
 * The core resolver (KDResolveDestinationConflicts) is pure — it takes
 * precomputed destinations and an injectable RNG — so every rule is unit-testable
 * without entities or sockets.
 * ========================================================================= */

interface KDMoveDest { playerId: number; dest: { x: number; y: number } | null; }

/**
 * Pure same-tile resolver. Given each player's intended destination tile (null
 * for a non-move/hold), decide which players' moves are **cancelled** because
 * two would land on the same tile. Ties are broken with `rng` (defaults to
 * KDRandom): `rng() < 0.5` keeps the earlier player, else the later one.
 *
 * Returns the array of cancelled playerIds (empty when there's no collision).
 * Deterministic for a given RNG sequence ⇒ reproducible across host/guest views.
 */
function KDResolveDestinationConflicts(moves: KDMoveDest[], rng?: () => number): number[] {
	const roll = rng || (typeof KDRandom === 'function' ? KDRandom : Math.random);
	const cancelled: number[] = [];
	const isCancelled = (id: number) => cancelled.indexOf(id) !== -1;
	for (let i = 0; i < moves.length; i++) {
		for (let j = i + 1; j < moves.length; j++) {
			const di = moves[i].dest, dj = moves[j].dest;
			if (!di || !dj) continue;
			if (di.x !== dj.x || di.y !== dj.y) continue;
			if (isCancelled(moves[i].playerId) || isCancelled(moves[j].playerId)) continue;
			// Collision: keep one, cancel the other by seeded coin-flip.
			const loser = roll() < 0.5 ? moves[j].playerId : moves[i].playerId;
			cancelled.push(loser);
		}
	}
	return cancelled;
}

/**
 * Compute a player's intended destination tile for a turn action, or null when
 * it isn't a move (so it can't collide). Reads the player's current slot entity
 * position: slot 0 = the engine's singular player, other slots via KDPlayerById.
 */
function KDActionDestination(playerId: number, action: { type: string; data: any }): { x: number; y: number } | null {
	if (!action || action.type !== 'move' || !action.data || !action.data.dir) return null;
	const ent = (playerId === 0)
		? (typeof KinkyDungeonPlayerEntity !== 'undefined' ? KinkyDungeonPlayerEntity : undefined)
		: (typeof KDPlayerById === 'function' ? KDPlayerById(playerId) : undefined);
	if (!ent) return null;
	return { x: ent.x + action.data.dir.x, y: ent.y + action.data.dir.y };
}

/**
 * Host-side turn hook: given the turn's per-player actions, neutralize the moves
 * the same-tile resolver cancels (rewriting them to an inert `mpnoop` hold) and
 * return the adjusted action list, ready to enqueue. No-op when fewer than two
 * moves or no collision. Single-player / single-mover turns pass through verbatim.
 */
function KDApplyTurnConflicts(
	actions: { playerId: number; action: { type: string; data: any } }[],
): { playerId: number; action: { type: string; data: any } }[] {
	if (!Array.isArray(actions) || actions.length < 2) return actions;
	const moves: KDMoveDest[] = actions.map((a) => ({ playerId: a.playerId, dest: KDActionDestination(a.playerId, a.action) }));
	const cancelled = KDResolveDestinationConflicts(moves);
	if (!cancelled.length) return actions;
	return actions.map((a) =>
		cancelled.indexOf(a.playerId) !== -1
			? { playerId: a.playerId, action: { type: 'mpnoop', data: {} } }  // hold this turn
			: a,
	);
}
