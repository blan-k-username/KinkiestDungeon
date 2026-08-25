/**
 * KDM-240 A3/R4-R6 — when the world's map changes, the whole party lands together, keeps its
 * avatars, and is told once.
 *
 * Three defects are pinned here, all of them shipping today (measured 2026-08-24):
 *
 *   F1  A peer avatar is spawned exactly once, in `_seatPlayer` (`swap-session.js:1383`), and never
 *       re-spawned. A map change replaces `KDMapData.Entities`, so the entity is gone and `moveAvatar`
 *       returns `null` in silence (`headless-host.js:1578`). The players become invisible to each other.
 *   F2  Only the acting player is re-placed by `KDGoThruTile`. Everyone else's position lives in their
 *       own bundle and is restored verbatim onto the new map — an OLD-MAP coordinate.
 *   F4  Detection compares `getLevel()` (`swap-session.js:1148`). A capture regenerates the map at the
 *       SAME level (`KinkyDungeonDefeat` → `KinkyDungeonCreateMap`, `KinkyDungeonJail.ts:1725`), so
 *       the whole party is relocated and nothing notices.
 *
 * The level-unchanged test is the one that kills the old implementation: a `getLevel()` comparison
 * passes every other test in this file and fails only that one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { mapId as worldMapId, descend as worldDescend } from './helpers/world';

const BOOT_TIMEOUT = 300_000;

describe('KDM-240 — a map change lands the whole party together', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'lands-together', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }

	function mapId(): string { return worldMapId(s); }

	/** Everything the session promised about a player after a map change. */
	function landing(cid: string) {
		const pos = s.posOf(cid);                     // reads the AVATAR — null means F1 bit us
		return { pos, log: (s.logs.get(cid) || []).map((m: any) => String(m.text || m)) };
	}

	/**
	 * The proxy's own announcement, and ONLY it — the one line `_announceMapChange` emits.
	 *
	 * ⚠️ COUNTED, never sliced by a saved index. `_pushLog` caps each log at `maxLog` and SHIFTS the
	 * front off once it is full, so `log.slice(lengthBefore)` quietly returns `[]` on a full log — a
	 * green "nothing was announced" for a session that announced perfectly well, and a green control
	 * test that proves nothing. Counting a distinctive line has no such failure mode: the session emits
	 * none of these at boot, so the count IS the delta.
	 */
	const ANNOUNCE = /^The party (?:descends to|arrives at)\b/;
	function announcements(cid: string) {
		return landing(cid).log.filter((t) => ANNOUNCE.test(t)).length;
	}

	/**
	 * Regenerate the map WITHOUT changing the level — the exact shape a capture produces.
	 *
	 * This is KD's own map creation, called the way `KinkyDungeonDefeat` calls it
	 * (`KinkyDungeonJail.ts:1725`): same `MiniGameKinkyDungeonLevel`, different room. Driving
	 * `KinkyDungeonDefeat` itself would drag in the leash/guard machinery and make the test about
	 * that; the property under test is only "the map changed and the level did not".
	 */
	function regenerateSameLevel(room: string) {
		return s.world.eval(`(function(){
			try {
				var params = KinkyDungeonMapParams[
					(KinkyDungeonMapIndex[MiniGameKinkyDungeonCheckpoint] || MiniGameKinkyDungeonCheckpoint)];
				KinkyDungeonCreateMap(params, ${JSON.stringify(room)}, "", MiniGameKinkyDungeonLevel);
				KDGameData.RoomType = KDMapData.RoomType;
				return 'ok';
			} catch (e) { return 'threw: ' + e.message; }
		})()`);
	}

	/**
	 * A real descent. The implementation — and the vacuous-pass warning that goes with it — lives in
	 * `./helpers/world`, shared with every spec that needs a real transition (KDM-262).
	 */
	function descend() { return worldDescend(s, 'A'); }

	/**
	 * F5 — descending must COMPLETE, not merely start.
	 *
	 * `KDPostStairSave` is the second-to-last statement of `KDGenMapCallback`
	 * (`KDStairActions.ts:239`), and headlessly it threw: it autosaves via
	 * `KinkyDungeonGenerateSaveData`, which reads model `Poses` off a paper doll the server
	 * deliberately never builds (`_neuterRendering` no-ops `DrawModelProcessPoses`). The throw
	 * escaped AFTER the new map was generated but BEFORE `KDGenMapCallback = null`, so every floor
	 * change in a co-op session aborted its own tail and left a stale callback behind.
	 *
	 * A leftover `KDGenMapCallback` is the exact fingerprint, and it is not something a "did the map
	 * change" assertion can see — the map changes either way.
	 */
	it('F5: a floor transition runs to completion instead of throwing on the autosave', () => {
		const before = mapId();
		const out = descend();

		expect(out,
			'the descent threw. The likely cause is a browser-only call reached from KDGenMapCallback ' +
			'that the headless world cannot serve — see _neuterAutosave.').toBe('ok');
		expect(mapId(), 'precondition: the descent really did move the party').not.toBe(before);
		expect(s.world.eval('KDGenMapCallback === null || KDGenMapCallback === undefined'),
			'KDGenMapCallback was left set, which means KDGoThruTile did not reach the end of its own ' +
			'callback — the transition aborted partway even though the map changed.').toBe(true);
	});

	it('R4/F1: every player still has a live avatar on the new map', () => {
		expect(s.posOf('B'), 'precondition: B has an avatar before the map changes').not.toBeNull();
		const before = mapId();
		expect(descend(), 'precondition: the descent did not throw').toBe('ok');
		expect(mapId(), 'precondition: the map really changed — otherwise this test is vacuous')
			.not.toBe(before);
		turn();

		expect(s.posOf('A'),
			"A's avatar did not survive the map change. `spawnAvatar` is called once at seating and " +
			'`moveAvatar` fails SILENTLY when the entity is gone, so the players simply stop seeing ' +
			'each other after the first floor (F1).').not.toBeNull();
		expect(s.posOf('B'), "B's avatar did not survive the map change (F1)").not.toBeNull();
	});

	it('R4/F2: nobody is left standing on an old-map coordinate', () => {
		// Put B somewhere distinctive and FAR, so a stale restore is recognisable by value rather
		// than by coincidence.
		const a0 = s.posOf('A');
		s.world.moveAvatar(s.avatars.get('B'), a0.x + 7, a0.y + 5);
		const staleB = { ...s.posOf('B') };
		const before = mapId();

		expect(descend(), 'precondition: the descent did not throw').toBe('ok');
		expect(mapId(), 'precondition: the map really changed — otherwise this test is vacuous')
			.not.toBe(before);
		turn();

		const b = s.posOf('B');
		expect(b, 'B has no avatar at all — see the F1 test').not.toBeNull();
		expect(`${b.x},${b.y}`,
			'B is standing on exactly the tile they occupied on the PREVIOUS map. Their position ' +
			'lives in their own bundle and is restored verbatim; only the acting player is re-placed ' +
			'by KDGoThruTile (F2).').not.toBe(`${staleB.x},${staleB.y}`);

		const a = s.posOf('A');
		const apart = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
		expect(apart,
			`the party landed ${apart} tiles apart. R4 is "both land in the same next place" — ` +
			'arriving on opposite ends of a new floor is the same bug as arriving in a wall.')
			.toBeLessThanOrEqual(3);
	});

	it('R5/F4: a map change at the SAME level is detected — this is the capture case', () => {
		const before = mapId();
		const a0 = s.posOf('A');
		s.world.moveAvatar(s.avatars.get('B'), a0.x + 7, a0.y + 5);
		const staleB = { ...s.posOf('B') };

		const out = regenerateSameLevel('Tunnel');
		expect(out, `could not regenerate the map headlessly: ${out}`).toBe('ok');
		expect(mapId(), 'precondition: the map really did change').not.toBe(before);
		expect(mapId().split('|')[0],
			'precondition: …and the LEVEL did not, which is what makes this the capture case')
			.toBe(before.split('|')[0]);

		turn();

		const b = s.posOf('B');
		expect(b,
			'nothing re-spawned B after a same-level relocation. Detection keyed on `getLevel()` ' +
			'(swap-session.js:1148) cannot see this, so a capture drags the party into a jail map ' +
			'and every repair silently skips (F4).').not.toBeNull();
		expect(`${b.x},${b.y}`, 'B kept an old-map coordinate through a same-level relocation (F4)')
			.not.toBe(`${staleB.x},${staleB.y}`);
	});

	it('R6: the move is announced to EVERY player, exactly once', () => {
		for (const cid of ['A', 'B']) {
			expect(announcements(cid),
				'precondition: nothing has been announced yet, so the count below IS the delta').toBe(0);
		}

		const before = mapId();
		expect(descend(), 'precondition: the descent did not throw').toBe('ok');
		expect(mapId(), 'precondition: the map really changed').not.toBe(before);
		turn();

		for (const cid of ['A', 'B']) {
			expect(announcements(cid),
				`${cid} was told about the map change ${announcements(cid)} times; it must be exactly ` +
				'once. Zero means a player is moved without being told; more than one means a second ' +
				'announcement path is still firing alongside the map-change detection.').toBe(1);
		}
	});

	it('control: a turn with NO map change moves nobody and announces nothing', () => {
		const a0 = { ...s.posOf('A') }, b0 = { ...s.posOf('B') };

		turn();

		expect(`${s.posOf('A').x},${s.posOf('A').y}`,
			'a quiet turn re-placed A — the map-change detector is firing on every turn, which would ' +
			'teleport the party to the entrance continuously').toBe(`${a0.x},${a0.y}`);
		expect(`${s.posOf('B').x},${s.posOf('B').y}`, 'a quiet turn re-placed B').toBe(`${b0.x},${b0.y}`);
		for (const cid of ['A', 'B']) {
			expect(announcements(cid),
				`${cid} was told the party moved on a turn where it did not`).toBe(0);
		}
	});
});
