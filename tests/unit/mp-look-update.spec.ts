/**
 * Node-layer (Vitest) — a player's own drawn look, sent when it changes, lands on their avatar and in
 * their character package (KDM-344; behaviour end-to-end in `tests/e2e/mp-own-paper-doll.spec.ts` #3).
 *
 * The partner's client applies whatever `appearance` the avatar entity carries; this pins the server
 * half: the session puts the new look on the right avatar, keeps it for a later respawn, and an empty,
 * invalid or unknown-player look changes nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;
let s: any;
const avatarLook = (id: string) => s.world.eval(`(function(){
	var e = KDMapData.Entities.find(function(x){ return x.id === ${s.avatars.get(id)}; });
	return e ? (e.appearance || '') : null;
})()`);

describe('a player\'s look update', () => {
	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'look-update', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	it('goes on THAT player\'s avatar and into their character package', () => {
		expect(s.avatars.get('A'), 'setup: A has an avatar').not.toBeUndefined();
		const beforeB = avatarLook('B');
		expect(s.setLook('A', 'Look1+/=AAA')).toBe(true);
		expect(avatarLook('A')).toBe('Look1+/=AAA');
		expect(avatarLook('B'), "B's avatar is untouched (control)").toBe(beforeB);
		expect(s.characterOf('A').appearance, 'kept for a respawn on a later floor').toBe('Look1+/=AAA');
		expect(s.setLook('A', 'Look2')).toBe(true);
		expect(avatarLook('A'), 'the newest look wins').toBe('Look2');
	});

	it('an empty, invalid or unknown-player look changes nothing', () => {
		expect(s.setLook('A', '')).toBe(false);
		expect(s.setLook('A', 42)).toBe(false);
		expect(s.setLook('A', 'x'.repeat(64 * 1024 + 1))).toBe(false);     // over the join cap
		expect(s.setLook('Z', 'Look3')).toBe(false);
		expect(avatarLook('A')).toBe('Look2');
	});
});
