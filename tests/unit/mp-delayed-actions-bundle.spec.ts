/**
 * Node-layer (Vitest) tests: the delayed-action queue is PER PLAYER.
 *
 * Self-equipping a restraint is a delayed action — the click pushes onto
 * KDGameData.DelayedActions (KinkyDungeonInput.ts:386) and it commits
 * KDGetEquipDuration turns later. The queue used to live only on the shared world:
 * capturePlayer didn't save it and restorePlayer didn't restore it
 * (headless-host.js gameData whitelist), so in co-op it never followed the player
 * across a swap — the equip could never finish, no matter how long you waited.
 * (Same path is used by consumables and channelled casts.)
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function queueFor(s: any, id: string, tag: string) {
	s.world.restorePlayer(s.bundles.get(id));
	s.world.eval(`(function(){
		KDGameData.DelayedActions = KDGameData.DelayedActions || [];
		KDGameData.DelayedActions.push({ data: { name: ${JSON.stringify(tag)} }, time: 2, tick: 0, maxtime: 2, tags: ["Action"] });
	})()`);
	s.bundles.set(id, s.world.capturePlayer());
}

function queueOf(s: any, id: string) {
	s.world.restorePlayer(s.bundles.get(id));
	return s.world.eval('(function(){ return (KDGameData.DelayedActions || []).map(function(a){ return a.data && a.data.name; }); })()');
}

describe('delayed actions are per-player (bundle-carried)', () => {
	let s: any;
	beforeEach(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'delayed-seed' });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	it('a queued action survives a swap-out/swap-in', () => {
		queueFor(s, 'A', 'A-equip');
		s.world.restorePlayer(s.bundles.get('B'));   // somebody else takes a turn
		expect(queueOf(s, 'A')).toEqual(['A-equip']);
	}, BOOT_TIMEOUT);

	it("does not leak into the other player's queue", () => {
		queueFor(s, 'A', 'A-equip');
		expect(queueOf(s, 'B')).toEqual([]);
	}, BOOT_TIMEOUT);

	it('two players hold independent queues', () => {
		queueFor(s, 'A', 'A-equip');
		queueFor(s, 'B', 'B-potion');
		expect(queueOf(s, 'A')).toEqual(['A-equip']);
		expect(queueOf(s, 'B')).toEqual(['B-potion']);
	}, BOOT_TIMEOUT);
});
