/**
 * Node-layer (Vitest): the render snapshot carries the movement-cost state.
 *
 * UAT bug: a hobbled player saw "You are slowed! Trying to move will cause you to lose a turn"
 * while the move reticule still read "x1". That number is drawn IN THE BROWSER
 * (KinkyDungeonDraw.ts:1581) from KDGameData.MovePoints + KinkyDungeonSlowLevel — neither of
 * which reached the client: `slowLevel` wasn't in the snapshot at all, and `movePoints` was in
 * the snapshot but never applied by render-client. So the client drew its own defaults.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const HOBBLE = 'HighsecShackles';   // hobble: 1 ⇒ slow level > 0

describe('render snapshot: movement cost', () => {
	it('reports the bound player as slowed, and the free player as not', () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'movecost-seed' });
		s.join('A');
		s.join('B');

		s.world.restorePlayer(s.bundles.get('A'));
		s.world.addRestraint(HOBBLE);
		s.bundles.set('A', s.world.capturePlayer());

		const a = s.snapshotFor('A');
		const b = s.snapshotFor('B');

		expect(a.stats.slowLevel).toBeGreaterThan(0);
		expect(b.stats.slowLevel).toBe(0);
		// movePoints must be present too — the reticule maths uses both.
		expect(a.stats).toHaveProperty('movePoints');
	}, BOOT_TIMEOUT);
});
