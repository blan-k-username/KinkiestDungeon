/**
 * KD-096 co-op AOE friendly-fire, on the REAL bullet path (KDM-164).
 *
 * This file used to test an approximation: a Chebyshev square radius around the target tile, applying
 * the spell's nominal `power` to any peer inside it — ignoring walls, line of sight and the actual
 * bullet. That is a gameplay rule invented in the gateway, and KDM-164's whole point is that the MP
 * layer owns none.
 *
 * It is now unnecessary. Measured (`KDM-164/probes/aoe-real-path.spec.ts`): a real AOE cast in the
 * headless world creates a real bullet, `KinkyDungeonUpdateBullets` runs (16 ticks over the turns), and
 * the blast damages a peer AVATAR through `KinkyDungeonDamageEnemy` — the very function the peer-damage
 * recorder wraps. So the splash is captured like any other hit and applied through that player's own
 * `KinkyDungeonDealDamage`. Will went 10 → 6.5 with no MP-side splash code at all.
 *
 * The `friendlyFire` toggle went with it: under the real path the GAME decides who its AOE hits, and a
 * server-side switch could only re-impose our answer over the game's.
 *
 * ⚠️ Timing subtlety worth knowing when reading this test: the ACTING player's own avatar is PARKED
 * while they are swapped in, and returns to their position afterwards. So a blast a caster leaves
 * behind can splash their OWN avatar on a later turn — which is exactly what the probe caught, and is
 * the game being consistent rather than a bug.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { bundleGiveMana } from './helpers/bundle';

const BOOT_TIMEOUT = 240_000;
const AOE_SPELL = 'Firecracker'; // tags: aoe; aoe:1, power:3.5

describe('Co-op AOE friendly-fire via the real bullet path (KD-096 / KDM-164)', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-ff-seed', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		for (const id of ['A', 'B']) bundleGiveMana(s.bundles.get(id));
		s._shuffle = () => ['A', 'B'];
	}, BOOT_TIMEOUT);

	it("an AOE blast splashes a peer through the game's own bullet, with no MP-side splash code", () => {
		const eid = s.avatars.get('B');
		const a = s.posOf('A');
		s.world.moveAvatar(eid, a.x, a.y + 1);
		const bEnt = s.world.listEntities().find((e: any) => e.id === eid);
		const willA0 = s.vitalsFor('A').will;
		const willB0 = s.vitalsFor('B').will;

		s.submit('A', { kdType: 'tryCastSpell', data: { tx: bEnt.x, ty: bEnt.y, spellname: AOE_SPELL, player: { __kdEnt: 'player' } } });
		s.submit('B', { kind: 'wait' });
		for (let i = 0; i < 3; i++) { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

		const splashed = (s.vitalsFor('A').will < willA0) || (s.vitalsFor('B').will < willB0);
		expect(splashed, `a real AOE blast must reach a peer (A ${willA0}->${s.vitalsFor('A').will}, ` +
			`B ${willB0}->${s.vitalsFor('B').will})`).toBe(true);
	}, BOOT_TIMEOUT);

	/** The approximation is gone — including the switch that used to gate it. */
	it('the MP layer has no friendly-fire code or toggle left', () => {
		expect(typeof s.setFriendlyFire, 'the toggle gated an approximation and went with it').toBe('undefined');
		expect(typeof s._applyFriendlyFire, 'the Chebyshev splash is deleted').toBe('undefined');
	}, BOOT_TIMEOUT);
});
