/**
 * Finding tiles in a `SwapSession` world — for any spec holding one (unit, or e2e via `bridge.session`).
 *
 * Tiles are FOUND, never assumed: the party lands on KD's start and its free neighbours, so
 * no fixed offset between the players, or between a player and a wall, holds from seed to seed.
 */

/** Can a player step onto (x,y) right now — walkable terrain and nobody standing there? */
export function isFree(s: any, x: number, y: number): boolean {
	return !!s.world.eval(`(function(){
		var t = KinkyDungeonMapGet(${x | 0}, ${y | 0});
		return !!(KinkyDungeonMovableTilesEnemy.includes(t) && !KinkyDungeonEntityAt(${x | 0}, ${y | 0}));
	})()`);
}

/**
 * A tile adjacent to BOTH players that is free right now — the one tile two players can race for.
 * `null` when there is none; callers assert that as a precondition.
 */
export function contestedTarget(s: any): { x: number, y: number } | null {
	const a = s.posOf('A'), b = s.posOf('B');
	const adj = (p: any, c: any) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) === 1;
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			const c = { x: a.x + dx, y: a.y + dy };
			if (adj(a, c) && adj(b, c) && isFree(s, c.x, c.y)) return c;
		}
	}
	return null;
}

/**
 * A free tile next to `id`, with the direction to step onto it — for a spec that stands something
 * beside a player. Straight directions first (a diagonal bump can be refused by corners).
 * `null` when boxed in; callers assert that as a precondition.
 */
export function freeNeighbour(s: any, id: string): { x: number, y: number, dx: number, dy: number } | null {
	const p = s.posOf(id);
	const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
	for (const [dx, dy] of dirs) {
		if (isFree(s, p.x + dx, p.y + dy)) return { x: p.x + dx, y: p.y + dy, dx, dy };
	}
	return null;
}

/** Move a joined player's authoritative position (bundle + avatar), by id, exactly. */
export function placePlayerAt(s: any, id: string, x: number, y: number): void {
	s.world.restorePlayer(s.bundles.get(id));
	s.world.eval(`(function(){ KinkyDungeonPlayerEntity.x = ${x | 0}; KinkyDungeonPlayerEntity.y = ${y | 0}; })()`);
	s.bundles.set(id, s.world.capturePlayer());
	const avId = s.avatars.get(id);
	if (avId != null) s.world.moveAvatar(avId, x, y);
}

/**
 * Free tiles between `min` and `max` steps (Chebyshev) from `id` — candidate spots for something the
 * player should HEAR but not see (KD draws an enemy's noise ripple only when it is out of sight). A
 * spec cycles through them rather than trusting any single spot to be behind a wall.
 */
export function tilesAtRange(s: any, id: string, min: number, max: number): Array<{ x: number, y: number }> {
	const p = s.posOf(id);
	const out: Array<{ x: number, y: number }> = [];
	for (let dx = -max; dx <= max; dx++) {
		for (let dy = -max; dy <= max; dy++) {
			const d = Math.max(Math.abs(dx), Math.abs(dy));
			if (d >= min && d <= max && isFree(s, p.x + dx, p.y + dy)) out.push({ x: p.x + dx, y: p.y + dy });
		}
	}
	return out;
}
