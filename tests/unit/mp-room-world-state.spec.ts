/**
 * Node-layer (Vitest) — KDM-228: the room the party is in is WORLD state, not per-player.
 *
 * `KDGameData.RoomType` / `.MapMod` say WHICH MAP everyone is on — "" for a dungeon floor,
 * `JourneyFloor` for the between-floors hub, `Tunnel`/`PerkRoom`/`ShopStart` for the side rooms. The
 * session has one world and one map, and a floor change moves the whole party (KDM-165).
 *
 * They were nonetheless absent from `KDGAMEDATA_WORLD_KEYS`, so `restorePlayer` re-installed them
 * from the acting player's captured bundle at the top of that player's slice of every turn
 * (`headless-host.js:2261-2270`) — the world's own value was overwritten by a copy held by whoever
 * happened to be acting.
 *
 * ── WHY THIS IS WORLD STATE, NOT A JUDGEMENT CALL ─────────────────────────────────────────────────
 * The game assigns these two in exactly four places, and every one is a map load, a map generation
 * or a floor transition. The decisive one is `KinkyDungeonGame.ts:841-842`:
 *
 *     KDGameData.RoomType = KDMapData.RoomType;
 *     KDGameData.MapMod   = KDMapData.MapMod;
 *
 * — i.e. the game itself says these are a COPY of a field on `KDMapData`, which this layer already
 * treats as authoritative shared world state. So they are criterion (b) (floor/dungeon generation
 * state), and being *derived* makes a per-player copy wrong twice over: a bundle can hold a value
 * its own source of truth has since moved past. The other three sites are `KDMapGen.ts:87-88`,
 * `KDStairActions.ts:201` and the new-game boot at `KinkyDungeon.ts:6025`.
 *
 * ── WHY IT IS BENIGN UNTIL IT IS NOT ──────────────────────────────────────────────────────────────
 * In ordinary play every bundle is captured from the same world after the same transition, so they
 * all agree and the restore is a no-op. The bug needs the copies to DIVERGE — a rejoin, a stale
 * capture, a capture taken mid-transition. That is exactly the case this spec constructs, because
 * the happy path where everyone agrees cannot tell a fixed build from a broken one.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ────────────────────────────────────────────────────
 * "The world's value survived a restore" is also what you would see if the restore had done nothing
 * at all — if the bundle were empty, the session were wedged, or `restorePlayer` had silently become
 * a no-op. So every case here carries a CONTROL key: an ordinary (non-world) `KDGameData` field,
 * planted on the same bundle in the same breath, which MUST come through. The pair is the assertion:
 * the world key held its ground *while* a player key on the same bundle was installed.
 *
 * The `mp-noninterference` spec covers the complementary half generically — that every declared world
 * key really is shared, and that nothing leaks which is not declared. This one asks the behavioural
 * question that a leak test cannot: whose value wins when two players disagree.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KDGAMEDATA_WORLD_KEYS } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

/** A key no game code writes, so its arrival can only mean "this bundle was restored". */
const CONTROL_KEY = '__kdm228RestoreProbe';

describe('KDM-228 — the party\'s room is world state', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'room-classification', pvp: false });
		s.join('A');
		s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	/** Read the world's own values — not any player's copy. */
	function world(): { RoomType: string; MapMod: string; probe: any } {
		return s.world.eval(`(function(){
			return { RoomType: KDGameData.RoomType, MapMod: KDGameData.MapMod,
				probe: KDGameData[${JSON.stringify(CONTROL_KEY)}] };
		})()`);
	}

	/** Set the world's room the way a real transition does — the world, and only the world. */
	function setWorldRoom(roomType: string, mapMod: string) {
		s.world.eval(`(function(){
			KDGameData.RoomType = ${JSON.stringify(roomType)};
			KDGameData.MapMod = ${JSON.stringify(mapMod)};
		})()`);
	}

	/**
	 * Make every player's captured bundle DISAGREE with the world about the room, and stamp the
	 * control key on each at the same time.
	 *
	 * Every bundle, not just the actor's: with only one stale bundle the other player's turn would
	 * restore the correct value and the world would end the turn right anyway — a green produced by
	 * the fixture rather than by the code.
	 */
	function makeBundlesStale(roomType: string, mapMod: string) {
		for (const [id, b] of s.bundles) {
			if (!b || !b.gameData) throw new Error(`precondition: ${id} has no captured gameData`);
			b.gameData.RoomType = roomType;
			b.gameData.MapMod = mapMod;
			b.gameData[CONTROL_KEY] = `restored-from-${id}`;
		}
	}

	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

	it('a stale actor bundle does not rewrite the room the party is on', () => {
		setWorldRoom('Tunnel', 'ShopStart');
		makeBundlesStale('JourneyFloor', '');

		// The deciding layer: restorePlayer is where the world/player split is applied.
		s.world.restorePlayer(s.bundles.get('A'));

		const afterRestore = world();
		expect(afterRestore.probe,
			'CONTROL: an ordinary KDGameData key on the SAME bundle must be installed — otherwise this '
			+ 'test proves only that restorePlayer did nothing at all').toBe('restored-from-A');
		expect(afterRestore.RoomType,
			'AC1/AC2: the world owns the room; a player\'s stale copy must not overwrite it')
			.toBe('Tunnel');
		expect(afterRestore.MapMod,
			'AC3: MapMod is written by the same statements as RoomType and classifies with it')
			.toBe('ShopStart');
	}, BOOT_TIMEOUT);

	it('…and it survives a whole real turn, with both players disagreeing', () => {
		setWorldRoom('PerkRoom', '');
		makeBundlesStale('JourneyFloor', 'SomeOtherMod');

		turn();

		const after = world();
		expect(after.probe, 'CONTROL: the turn really did restore player bundles').toMatch(/^restored-from-/);
		expect(after.RoomType, 'AC2: after a full turn the world still owns the room').toBe('PerkRoom');
		expect(after.MapMod, 'AC3: …and the map mod with it').toBe('');
	}, BOOT_TIMEOUT);

	it('the classification is declared in production code, not inferred by this test', () => {
		// R7, same rule mp-noninterference states: the world/player split lives in ONE named list in
		// production code. If someone "fixes" the behaviour above by special-casing the room somewhere
		// else, this fails and says so.
		expect(KDGAMEDATA_WORLD_KEYS, 'RoomType must be declared world-scoped').toContain('RoomType');
		expect(KDGAMEDATA_WORLD_KEYS, 'MapMod must be declared world-scoped').toContain('MapMod');
	});
});
