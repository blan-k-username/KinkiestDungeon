/**
 * KDM-309 — a new co-op game starts the party where single player starts the player, with no demo Rat.
 *
 * Owner's UAT (2026-09-30): "the chars should spawn at the same position as SP", beside a Rat nobody
 * asked for. Session start seated seat 0 on `findOpenTile()` — a map-wide scan for the most open tile,
 * not KD's start — put seat i at `base.x + i` (a wall, or occupied), and summoned the early demo's Rat.
 *
 * Single player stands the player on `KDMapData.StartPosition` during map generation. The party now
 * lands the way it lands on every later floor (`landingTiles`): seat 0 where KD put the player, the
 * others on free neighbouring tiles. The Rat is opt-in (`enemyType`) for the specs that fight it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('KDM-309 — co-op start position', () => {
	let s: any;
	let start: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'start-position-seed' });
		s.join('A');
		s.join('B');
		start = s.world.eval('KDMapData.StartPosition ? ({ x: KDMapData.StartPosition.x, y: KDMapData.StartPosition.y }) : null');
	}, BOOT_TIMEOUT);

	it('seats the host on KD\'s own start position, as single player does', () => {
		expect(s.started, 'precondition: the session started').toBe(true);
		expect(start, 'precondition: the generated map has a start position').toBeTruthy();
		expect(s.posOf('A')).toEqual(start);
	});

	it('seats the partner on a free, walkable tile right next to the host', () => {
		const a = s.posOf('A'); const b = s.posOf('B');
		expect(b, 'the partner is in the world').toBeTruthy();
		expect(b, 'not stacked on the host').not.toEqual(a);
		expect(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)), 'adjacent to the host').toBe(1);
		expect(s.world.isMovable(b.x, b.y), 'on a tile a player can stand on').toBe(true);
	});

	it('summons no demo enemy', () => {
		expect(s.enemyId).toBeNull();
		expect(s.enemyView()).toBeNull();
	});
});

describe('KDM-309 — the demo enemy is opt-in', () => {
	it('is summoned only when a spec asks for it', () => {
		const s = new SwapSession({ requiredPlayers: 1, seed: 'start-position-seed', enemyType: 'Rat' });
		s.join('A');
		expect(s.started, 'precondition: the session started').toBe(true);
		const e = s.enemyView();
		expect(e, 'the requested enemy is in the world').toBeTruthy();
		expect(e.name).toBe('Rat');
	}, BOOT_TIMEOUT);
});
