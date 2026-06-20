/**
 * Node-layer (Vitest) tests for the KD-068 `KDServerRole` source flag.
 *
 * KD-068 adds a real, gated engine flag (Game/src/enemy/KinkyDungeonEnemies.ts):
 *   ""      → single-player / offline (default; guard is a no-op → byte-identical)
 *   "world" → this instance owns + simulates shared entities
 *   "player"→ this instance suppresses shared-entity AI (driven by the world)
 *
 * These prove: the flag DEFAULTS to "" (so SP behaviour is unchanged), the host
 * toggles it, and a "player" instance's shared enemy stays inert while a "world"
 * instance's enemy moves under AI. (Heavier world-vs-player trace parity also lives
 * in mp-headless-host.spec.ts.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 180_000;

describe('KDServerRole flag (KD-068)', () => {
	it('defaults to "" after boot (single-player / offline byte-identical)', () => {
		const h = new HeadlessHost({ id: 'sm-default' });
		h.boot(); // NOTE: no init() — init() assigns the role; boot() must not.
		expect(h.getServerRole()).toBe('');
		// The guard at the top of KinkyDungeonUpdateEnemies is a no-op when role==="".
		expect(h.eval('KDServerRole === ""')).toBe(true);
	}, BOOT_TIMEOUT);

	describe('world vs player suppression', () => {
		let world: any;
		let player: any;

		beforeAll(() => {
			const make = (mode: 'world' | 'player') => {
				const h = new HeadlessHost({ id: `sm-${mode}` });
				h.boot();
				h.init({ seed: 'server-mode-seed' });
				h.setServerMode(mode);
				const t = h.findOpenTile();
				h.placePlayer(t.x, t.y);
				h.summonEnemy(t.x + 2, t.y, 'Rat', { rad: 4 });
				const start = h.getRealEnemy(0);
				let moved = false;
				for (let i = 0; i < 10; i++) {
					const p = h.applyMove(i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 0 : 1);
					h.setEnemyTarget(p.x, p.y);
					h.step(1);
					const e = h.getRealEnemy(0);
					if (e && (e.x !== start.x || e.y !== start.y)) moved = true;
				}
				return { h, moved };
			};
			const w = make('world');
			const p = make('player');
			world = w; player = p;
		}, BOOT_TIMEOUT);

		it('sets the engine flag to the requested role', () => {
			expect(world.h.getServerRole()).toBe('world');
			expect(player.h.getServerRole()).toBe('player');
		});

		it('reports runsEnemyAI per role', () => {
			expect(world.h.runsEnemyAI()).toBe(true);
			expect(player.h.runsEnemyAI()).toBe(false);
		});

		it('world enemy moves under AI; player enemy stays inert (AI suppressed)', () => {
			expect(world.moved).toBe(true);
			expect(player.moved).toBe(false);
		});
	});
});
