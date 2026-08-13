/**
 * Node-layer (Vitest) tests: the movement penalty belongs to the player wearing the bondage.
 *
 * UAT bug: the BOUND player moved at normal speed while their UNBOUND partner got
 * "You are slowed! Trying to move will cause you to lose a turn" — the debuff was landing
 * on the wrong seat. KinkyDungeonSlowLevel is a world global that
 * KinkyDungeonCalculateSlowLevel writes for whoever occupies the player slot; it survived the
 * swap, so the next player inherited a stranger's hobble. Derived state ⇒ recomputed on
 * swap-in (headless-host.restorePlayer); the SlowMoveTurns/SprintTurns timers ride the bundle.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const HOBBLE = 'HighsecShackles';   // ItemFeet, hobble: 1 ⇒ slow level > 0

/**
 * Slow level as the GAME sees it right after `id` is swapped in — the raw global, deliberately
 * NOT host.playerSlowLevel(), because that helper recomputes before reading and would mask the
 * very leak under test (it would pass with or without the fix).
 */
function slowOf(s: any, id: string) {
	s.world.restorePlayer(s.bundles.get(id));
	return s.world.eval('(function(){ return (typeof KinkyDungeonSlowLevel !== "undefined") ? KinkyDungeonSlowLevel : 0; })()');
}

describe('slow level is per-player', () => {
	let s: any;
	beforeEach(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'slow-seed' });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	it("binding A does not slow B", () => {
		// A gets hobbling gear; B stays free.
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.addRestraint(HOBBLE);
		s.bundles.set('A', s.world.capturePlayer());

		expect(slowOf(s, 'A')).toBeGreaterThan(0);
		expect(slowOf(s, 'B')).toBe(0);          // was: inherited A's hobble
		expect(slowOf(s, 'A')).toBeGreaterThan(0);   // and A keeps it after B's turn
	}, BOOT_TIMEOUT);

	it('a turn taken by the bound player leaves the free player unslowed', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		s.world.addRestraint(HOBBLE);
		s.bundles.set('A', s.world.capturePlayer());

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(slowOf(s, 'B')).toBe(0);
		expect(slowOf(s, 'A')).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
