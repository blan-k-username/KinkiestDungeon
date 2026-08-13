/**
 * Node-layer (Vitest) test for KD_WEAR_RESTRAINT — items worn from the start.
 *
 * Why it exists: self-equipping from the inventory is a DELAYED action
 * (KinkyDungeonInput.ts:386 → KDGameData.DelayedActions, committed after
 * KDGetEquipDuration turns). That queue is NOT part of the player bundle
 * (headless-host.js:991 whitelists a handful of KDGameData fields) and its auto-wait
 * cannot drive lockstep turns — so a co-op player can never finish equipping anything
 * on themselves. Wearing at start is the UAT path around that.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
// blockfeet + hobble ⇒ KinkyDungeonCalculateSlowLevel returns > 0 once worn.
const WORN = 'HighsecShackles';

describe('KD_WEAR_RESTRAINT (worn at start)', () => {
	it('every player starts wearing it, and it slows them', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'wear-seed', wearRestraint: WORN });
		s.join('A');
		s.join('B');

		for (const id of ['A', 'B']) {
			s.world.restorePlayer(s.bundles.get(id));
			const worn = s.world.getVitals().restraints;
			expect(worn).toBeGreaterThan(0);                 // it is ON them, not merely carried
			expect(s.world.playerSlowLevel()).toBeGreaterThan(0);   // and it costs them speed
		}
	}, BOOT_TIMEOUT);

	it('is inert when unset (default sessions are unencumbered)', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'wear-seed-off' });
		s.join('A');
		s.join('B');
		s.world.restorePlayer(s.bundles.get('A'));
		expect(s.world.playerSlowLevel()).toBe(0);
	}, BOOT_TIMEOUT);
});
