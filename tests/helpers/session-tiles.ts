/**
 * Finding tiles in a `SwapSession` world — for any spec holding one (unit, or e2e via `bridge.session`).
 *
 * Tiles are FOUND, never assumed: the party lands on KD's start and its free neighbours (KDM-309), so
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
