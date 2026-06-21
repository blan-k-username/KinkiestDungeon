/**
 * Node-layer (Vitest) test for KD-091 — bundle completeness.
 *
 * capturePlayer/restorePlayer previously omitted some NON-self-healing per-player state (spell
 * instances, temporary status counters, per-turn KDGameData). The restraint-DERIVED locks
 * (slow/blind/tags) intentionally stay omitted — they self-heal from the captured inventory each
 * turn (KD-073 §B). This test proves the newly-captured fields round-trip through a swap.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

describe('Bundle completeness round-trip (KD-091)', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'bundle-complete' });
		h.boot();
		h.init({ seed: 'bundle-complete-seed' });
	}, BOOT_TIMEOUT);

	it('non-self-healing per-player state survives capture → mutate → restore', () => {
		// Seed distinctive values on the live globals.
		h.eval(`(function(){
			KinkyDungeonStatBind = 5; KinkyDungeonStatFreeze = 3; KinkyDungeonSleepiness = 7;
			KDGameData.OrgasmStage = 2; KDGameData.Balance = 4; KDGameData.MovePoints = 9;
			KinkyDungeonSpells = [{ name: 'KD091TestSpell' }];
		})()`);

		const bundle = h.capturePlayer();

		// Clobber them (as if another player had been swapped in meanwhile).
		h.eval(`(function(){
			KinkyDungeonStatBind = 0; KinkyDungeonStatFreeze = 0; KinkyDungeonSleepiness = 0;
			KDGameData.OrgasmStage = 0; KDGameData.Balance = 0; KDGameData.MovePoints = 0;
			KinkyDungeonSpells = [];
		})()`);

		h.restorePlayer(bundle);

		const got = h.eval(`({
			bind: KinkyDungeonStatBind, freeze: KinkyDungeonStatFreeze, sleepiness: KinkyDungeonSleepiness,
			orgasm: KDGameData.OrgasmStage, balance: KDGameData.Balance, movePoints: KDGameData.MovePoints,
			spell: (KinkyDungeonSpells && KinkyDungeonSpells[0]) ? KinkyDungeonSpells[0].name : null,
		})`);

		expect(got.bind).toBe(5);
		expect(got.freeze).toBe(3);
		expect(got.sleepiness).toBe(7);
		expect(got.orgasm).toBe(2);
		expect(got.balance).toBe(4);
		expect(got.movePoints).toBe(9);
		expect(got.spell).toBe('KD091TestSpell');
	}, BOOT_TIMEOUT);
});
