/**
 * Node-layer (Vitest) — KDM-160: I2, cross-player non-interference.
 *
 * THE primary instrument for this slice. The swap model keeps ONE authoritative world and swaps each
 * player's bundle in and out; anything player-specific that the bundle does NOT carry simply stays on
 * the world and belongs to "whoever was swapped in last".
 *
 * Measured during assessment (KDM-160 §A4): KDGameData has 221 keys, capturePlayer whitelisted 12,
 * and 86 of 123 probed primitive keys leaked from A to B — including ShieldTokens, DodgeTokens,
 * BlockTokens, Crouch, Guilt, CurseLevel, CollectedOrbs, TimesJailed. A further 98 non-primitive keys
 * are never restored either (RevealedFog/RevealedTiles = per-player vision, Party, NPCRestraints,
 * PlayerName/PlayerPronoun — both players would share one name).
 *
 * The test is deliberately GENERIC (KDM-160 §D3): it stamps a magic value on every primitive key and
 * then searches the OTHER player's whole save for any of them. Enumerating field names here would
 * make the test itself the maintained list this epic exists to delete — and it would not catch
 * field 222.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KDGAMEDATA_WORLD_KEYS } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;
const MAGIC = 777_000; // stamped values are MAGIC + n — recognisable and vanishingly unlikely naturally

/** Every number appearing anywhere in an arbitrary JSON structure. */
function allNumbers(v: any, out: Set<number> = new Set()): Set<number> {
	if (typeof v === 'number') out.add(v);
	else if (Array.isArray(v)) for (const x of v) allNumbers(x, out);
	else if (v && typeof v === 'object') for (const k of Object.keys(v)) allNumbers(v[k], out);
	return out;
}

describe('KDM-160 · I2 — one player\'s turn must not contaminate another', () => {
	let s: any;
	let stamped: string[];

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm160-noninterference' });
		s.join('A');
		s.join('B');

		// Stamp a unique magic number on every primitive KDGameData key while B is swapped in,
		// then persist it as B's state.
		s.world.restorePlayer(s.bundles.get('B'));
		stamped = s.world.eval(`(function(){
			var names = [], n = 0;
			for (var k in KDGameData) {
				if (typeof KDGameData[k] === 'number' && isFinite(KDGameData[k])) {
					KDGameData[k] = ${MAGIC} + (n++); names.push(k);
				}
			}
			return names;
		})()`);
		s.bundles.set('B', s.world.capturePlayer());

		// one lockstep turn — both players act
		s.submit('A', { kdType: 'tick', data: { delta: 1 } });
		s.submit('B', { kdType: 'tick', data: { delta: 1 } });
	}, BOOT_TIMEOUT);

	it('stamped enough fields for the test to be meaningful', () => {
		expect(stamped.length).toBeGreaterThan(50);
	}, BOOT_TIMEOUT);

	/** Fields of B that show up in A's save. */
	function bledFields(): string[] {
		s.world.restorePlayer(s.bundles.get('A'));
		const aNumbers = allNumbers(s.world.saveOf());
		return stamped.filter((_name, i) => aNumbers.has(MAGIC + i));
	}

	it('nothing leaks EXCEPT the explicitly declared world-scoped keys', () => {
		// R7: the exclusion is a named list in production code (KDGAMEDATA_WORLD_KEYS), not a wildcard
		// in the test. Asserting "leaked ⊆ declared" is stronger than "nothing leaked": it proves the
		// only shared fields are the ones we deliberately chose, and it FAILS on a newly-appearing
		// unclassified key instead of silently deciding for it.
		const unexplained = bledFields().filter((k) => !KDGAMEDATA_WORLD_KEYS.includes(k));
		expect(
			unexplained,
			`${unexplained.length} of ${stamped.length} KDGameData fields leaked from B into A ` +
			'without being declared world-scoped',
		).toEqual([]);
	}, BOOT_TIMEOUT);

	it('the declared world keys really ARE shared (the list is not dead weight)', () => {
		// The inverse assertion: every entry in KDGAMEDATA_WORLD_KEYS that this run actually stamped
		// must be visible across players. If one stops being shared, the list has drifted from reality.
		const bled = bledFields();
		const stampedWorldKeys = KDGAMEDATA_WORLD_KEYS.filter((k: string) => stamped.includes(k));
		expect(stampedWorldKeys.length).toBeGreaterThan(0);
		expect(stampedWorldKeys.filter((k: string) => !bled.includes(k))).toEqual([]);
	}, BOOT_TIMEOUT);

	it('B keeps its own stamped values (no LOSS while fixing the leak)', () => {
		s.world.restorePlayer(s.bundles.get('B'));
		const kept = s.world.eval(`(function(){
			var names = ${JSON.stringify(stamped)}, out = {};
			for (var i = 0; i < names.length; i++) out[names[i]] = KDGameData[names[i]];
			return out;
		})()`);
		// Fields the game RECOMPUTES each turn (Balance, HeelPower, MovePoints, OrgasmStage, LastWP …)
		// legitimately drop their stamp — that is derived state self-healing, not loss. Assert the
		// majority survive rather than demanding all, and report the count if it collapses.
		const survivors = stamped.filter((n, i) => kept[n] === MAGIC + i);
		expect(survivors.length, `only ${survivors.length}/${stamped.length} of B's fields survived`)
			.toBeGreaterThan(stamped.length * 0.6);
	}, BOOT_TIMEOUT);
});
