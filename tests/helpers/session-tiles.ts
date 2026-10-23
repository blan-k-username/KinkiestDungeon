/**
 * Finding tiles in a `SwapSession` world — for any spec holding one (unit, or e2e via `bridge.session`).
 *
 * Tiles are FOUND, never assumed: the party lands on KD's start and its free neighbours, so
 * no fixed offset between the players, or between a player and a wall, holds from seed to seed.
 */

/** Can a player step onto (x,y) right now — walkable terrain and nobody standing there? */
export function isFree(s: any, x: number, y: number): boolean {
	return !!s.world.eval(`(function(){
		// Bounds first: KinkyDungeonMapGet indexes x + y*width with no check, so an off-map
		// coordinate such as (-5,3) wraps onto a real tile and would read as free.
		if (${x | 0} < 0 || ${y | 0} < 0 || ${x | 0} >= KDMapData.GridWidth || ${y | 0} >= KDMapData.GridHeight) return false;
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

/**
 * Drop a real entity at (x,y) via KD's own `KDAddNewEntity` (the primitive `HeadlessHost.ensureAvatar`
 * uses to inject an avatar). `KinkyDungeonSummonEnemy` needs a reachable goToTarget, has none this early
 * in a headless session, and silently summons NOTHING (measured: `KDMapData.Entities.length` unchanged).
 * So this throws unless exactly one entity was added: a spec never runs against a stale "last entity".
 */
export function spawnEntityDirect(s: any, x: number, y: number, type: string): { id: number, name: string } {
	const before = s.world.eval('KDMapData.Entities.length');
	const out = s.world.eval(`(function(){
		var Enemy = KinkyDungeonGetEnemyByName(${JSON.stringify(type)});
		if (!Enemy) return null;
		var e = { summoned: true, Enemy: Enemy, id: KinkyDungeonGetEnemyID(),
			x: ${x | 0}, y: ${y | 0}, hp: Enemy.startinghp || Enemy.maxhp,
			movePoints: 0, attackPoints: 0 };
		e = KDAddNewEntity(e);
		KDUpdateEnemyCache = true;
		return { id: e.id, name: e.Enemy && e.Enemy.name };
	})()`);
	const after = s.world.eval('KDMapData.Entities.length');
	if (!out || after !== before + 1) throw new Error(`setup invalid: failed to spawn ${type} at (${x},${y})`);
	return out;
}
