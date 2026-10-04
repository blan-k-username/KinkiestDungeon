/**
 * Node-layer (Vitest) — the player's paper doll is CLIENT-owned: the wire bundle never carries it
 * (KDM-322; behaviour pinned by `tests/e2e/mp-own-paper-doll.spec.ts`).
 *
 * `KinkyDungeonPlayer` (and `DefaultPlayer`, the same BC Character in KD) is the drawn character the
 * browser builds with `KinkyDungeonDressPlayer`. The headless world has no renderer: its copy never
 * draws restraints and wears the join-time look. Adopting it REPLACED the browser's paper doll, so a
 * bound co-op player saw themselves unbound. Same category as `CLIENT_OWNED_GAMEDATA_KEYS`.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

describe('the wire bundle leaves the paper doll to the client', () => {
	it('strips KinkyDungeonPlayer and DefaultPlayer, keeps every other global', () => {
		const s = new SwapSession({ requiredPlayers: 1 });
		const doll = { Appearance: [{ Model: { Name: 'BanditBoots' } }] };
		const bundle = { v: 1, gameData: {}, globals: {
			KinkyDungeonPlayer: doll, DefaultPlayer: doll,
			KinkyDungeonPlayerEntity: { x: 1, y: 2 }, KinkyDungeonPlayerTags: { a: 1 },
		} };
		const wire = s._clientBundle(bundle);
		expect(wire.globals).not.toHaveProperty('KinkyDungeonPlayer');
		expect(wire.globals).not.toHaveProperty('DefaultPlayer');
		// same-shape control: the player's real state still travels
		expect(wire.globals.KinkyDungeonPlayerEntity).toEqual({ x: 1, y: 2 });
		expect(wire.globals.KinkyDungeonPlayerTags).toEqual({ a: 1 });
		// the session's own bundle is not mutated by preparing a snapshot
		expect(bundle.globals.KinkyDungeonPlayer).toBe(doll);
	});
});
