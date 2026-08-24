/**
 * KDM-227 — the between-floors hub resets PvP back to co-op.
 *
 * Split out of KDM-225: this slice delivers on its own ("finishing a level clears the slate") with no
 * UI, no handshake and no client work, and it exercises the shared enabler both slices need — the
 * relationship registry, the `_isPvP` override and the hostility clear.
 *
 * The trigger is `KDGameData.RoomType === "JourneyFloor"` (the mandatory hub, "Floor N: Journey
 * Selection") and NOT any non-empty room type — `Tunnel` / `PerkRoom` / `ShopStart` are the optional
 * detours a grudge is meant to survive (KDM-225 D6/D7).
 *
 * ⚠️ SPEC CORRECTION, owner 2026-08-20. An earlier draft of this file booted the session with
 * `pvp: true` and demanded the hub beat that flag too. That was wrong, and two of its tests failed
 * for the right reason. `KD_PVP` is a session CONFIGURATION — "this run is a deathmatch" — not a
 * grudge, and a hub that silently cancelled it would make the flag expire after floor 1. The hub
 * clears wars that STARTED IN PLAY. So these tests run co-op, which is also the mode the feature was
 * asked for, and the last test pins the deliberate non-behaviour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { mapId, descend } from './helpers/world';
import { readFileSync } from 'fs';

const BOOT_TIMEOUT = 300_000;

describe('KDM-227 — arriving at the between-floors hub ends every war', () => {
	let s: any;
	beforeEach(async () => {
		// CO-OP, like the live server: war exists only because somebody attacked.
		s = new SwapSession({ requiredPlayers: 2, seed: 'peace-hub', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	/**
	 * Put the party in a given room the way a real transition does.
	 *
	 * This used to have to patch every player's captured bundle as well as the world, because
	 * `RoomType` was not in `KDGAMEDATA_WORLD_KEYS` and `restorePlayer` re-installed it from the
	 * acting player's bundle at the top of their slice — overwriting the world write before
	 * `_checkHubReset` ever read it. (Measured at the time: with the world write alone every room here
	 * behaved like the boot room, `JourneyFloor`, so the "a side room does not reset" case passed for
	 * the wrong reason.)
	 *
	 * KDM-228 classified `RoomType`/`MapMod` as world state — they are a copy of `KDMapData.RoomType`
	 * (`KinkyDungeonGame.ts:841`) — so the world write is now the whole story, exactly as it is in
	 * real play.
	 */
	function setRoom(type: string) {
		s.world.eval('(function(){ if (typeof KDGameData !== "undefined" && KDGameData) '
			+ `KDGameData.RoomType = ${JSON.stringify(type)}; })()`);
	}
	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
	/** What an attack does to the relationship. */
	function fight() { s.rel.declareWar('A', 'B'); }
	/**
	 * A real ARRIVAL at the hub: from a dungeon floor, into the hub.
	 *
	 * The two-step matters because the session BOOTS on the hub — KD starts the journey at level 0,
	 * "Floor 0: Journey Selection" — and `_start` seeds the arrival baseline from that. Setting the
	 * room to `JourneyFloor` while already on it is presence, not arrival, and correctly does nothing.
	 */
	function arriveAtHub() {
		setRoom(''); turn();               // out on a dungeon floor
		setRoom('JourneyFloor'); turn();   // …and back to the hub: THIS is the transition
	}

	it('R13/AC10: arriving at the hub ends the war, with no offer made', () => {
		fight();
		expect(s._isPvP("A", "B"), "precondition: at war").toBe(true);
		arriveAtHub();
		expect(s._isPvP('A', 'B'), 'the hub clears the slate (D7)').toBe(false);
	});

	it('AC4: it clears the hostility KD itself holds on the avatars, not just our verdict', () => {
		fight();
		for (const cid of ['A', 'B']) {
			const eid = s.avatars.get(cid);
			s.world.eval(`(function(){
				var e = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
				if (e && typeof KDMakeHostile === 'function') KDMakeHostile(e);
			})()`);
		}
		const read = (cid: string) => s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.avatars.get(cid)}; });
			return e ? { hostile: e.hostile || 0, rage: e.rage || 0 } : { missing: true };
		})()`);
		expect(read("A").hostile, "precondition: KD really holds hostility").toBeGreaterThan(0);

		arriveAtHub();

		for (const cid of ['A', 'B']) {
			expect(read(cid).hostile, `${cid}: hostility cleared in the game's own field`).toBe(0);
			expect(read(cid).rage, `${cid}: rage too`).toBe(0);
		}
	});

	/**
	 * The discriminator between "reset on ARRIVAL" and the much easier — and wrong — "reset every turn
	 * the party is on the hub". Without this, an implementation that simply clears the war whenever
	 * `RoomType === 'JourneyFloor'` passes every other test in this file.
	 */
	it('AC2/R14: the reset fires once per arrival — a war started ON the hub survives', () => {
		fight();
		arriveAtHub();
		expect(s._isPvP("A", "B"), "precondition: the arrival reset it").toBe(false);
		fight();
		expect(s._isPvP('A', 'B'), 'precondition: at war again, while still on the hub').toBe(true);
		turn();
		expect(s._isPvP('A', 'B'),
			'armed by ARRIVING, not by being here — a second turn must not re-fire it').toBe(true);
	});

	/**
	 * D6: the optional detours are exactly what a grudge is supposed to survive.
	 *
	 * ⚠️ KDM-262 REMOVED `PerkRoom` FROM THIS LIST, on the owner's decision (2026-08-24). D6 called it
	 * an optional detour; it is not one. `KDAdvanceAmount['s']` (`KinkyDungeonTiles.ts:930-946`)
	 * FORCES `roomType: "PerkRoom"` whenever you take the main stairs down from the deepest floor you
	 * have reached, so a `PerkRoom` follows EACH main floor on the way down. D6 and the `JourneyFloor`
	 * trigger were one false belief about which room is the hub, expressed twice. The arrival that fires
	 * at the real hub is KDM-262, whose tests are parked until KDM-265 makes a multi-floor descent work.
	 *
	 * The other three entries are untouched: they really are skippable (and `Tunnel` is marked
	 * `// DEPRECATED DO NOT USE` upstream, `KinkyDungeonAlt.ts:340`).
	 */
	it('AC3/R12: a side room does NOT reset the war', () => {
		for (const room of ['Tunnel', 'ShopStart', 'ElevatorRoom']) {
			fight();
			setRoom(room);
			turn();
			expect(s._isPvP('A', 'B'), `"${room}" is a detour, not the hub — the war must survive it`)
				.toBe(true);
			setRoom('');
			turn();
		}
	});

	it('AC5: after the hub, a fresh attack starts PvP again', () => {
		fight();
		arriveAtHub();
		setRoom("");
		turn();
		expect(s._isPvP("A", "B"), "precondition: the hub really did clear it").toBe(false);
		fight();
		expect(s._isPvP('A', 'B'), 'the door swings both ways').toBe(true);
	});

	/**
	 * AC6 (as corrected) — the deliberate NON-behaviour, pinned so nobody "fixes" it later.
	 *
	 * A war the operator configured is not a war two players started. Left unpinned, the natural
	 * next change ("make resetAll() write peace entries so it beats everything") would silently turn
	 * every KD_PVP session co-op after the first floor.
	 */
	it('AC6: the hub does NOT cancel a globally-configured PvP session', async () => {
		const g: any = new SwapSession({ requiredPlayers: 2, seed: 'peace-hub-global', pvp: true });
		g.join('A'); g.join('B');
		await g.ready();
		expect(g._isPvP('A', 'B'), 'precondition: the global flag has them hostile').toBe(true);
		// A REAL arrival, not just "already on the hub" — otherwise no reset fires at all and this
		// test would pass without exercising anything.
		const room = (type: string) => {
			for (const b of g.bundles.values()) { if (b && b.gameData) b.gameData.RoomType = type; }
			g.world.eval('(function(){ if (typeof KDGameData !== "undefined" && KDGameData) '
				+ `KDGameData.RoomType = ${JSON.stringify(type)}; })()`);
		};
		room(''); g.submit('A', { kind: 'wait' }); g.submit('B', { kind: 'wait' });
		room('JourneyFloor'); g.submit('A', { kind: 'wait' }); g.submit('B', { kind: 'wait' });
		expect(g._lastRoomType, 'precondition: the session really did arrive at the hub')
			.toBe('JourneyFloor');
		expect(g._isPvP('A', 'B'),
			'KD_PVP is a session configuration, not a grudge — the hub must not expire it').toBe(true);
	}, BOOT_TIMEOUT);
});


/**
 * KDM-262 — the reset fires at the room a real run actually reaches.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────────────────
 * KDM-227 matched `JourneyFloor`. That is the level-0 START room: it is assigned only at new-game boot
 * (`KinkyDungeon.ts:6025`, `KinkyDungeonGame.ts:457`) and holds the five journey-TYPE portals
 * (`KDJourneyList`, `KinkyDungeonAlt.ts:1227`). No journey slot can carry it — the slot factories emit
 * `""` or `"ShopStart"` (`KDJourney.ts:47/124/142`). Meanwhile `_lastRoomType` is seeded from the
 * world at session start (`swap-session.js:349`), which IS that room, and the rule is
 * arrival-not-presence. So the reset could not fire from the only room it matched. Measured
 * (KDM-241 P3): a fresh two-player session reports `RoomType === 'JourneyFloor'` at level 0.
 *
 * The between-floors room is `PerkRoom`: `KDAdvanceAmount['s']` (`KinkyDungeonTiles.ts:930-946`)
 * forces it whenever the main stairs are taken down from the deepest floor reached, so one follows
 * EACH main floor. It is also the room with `requireJourneyTarget` (`KinkyDungeonAlt.ts:388`), the
 * shop and quest NPCs, and KD's own between-floors autosave (`KDStairActions.ts:266`).
 *
 * ── WHY THE TESTS ABOVE DID NOT CATCH IT ──────────────────────────────────────────────────────────
 * Every one of them installs the room with `setRoom()`. That pins the MECHANISM ("given an arrival at
 * X, the war ends") and says nothing about whether an arrival at X ever occurs. **A trigger test that
 * constructs its own trigger proves nothing about reachability.** So this block drives REAL descents
 * and lets the GAME choose the room — the fixture never names `PerkRoom` at all.
 */
describe('KDM-262 — a real descent reaches the hub, and the hub ends the war', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'hub-reachable', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	function turn() { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
	function fight() { s.rel.declareWar('A', 'B'); }
	function room(): string { return s.world.eval('KDGameData.RoomType || ""'); }

	/**
	 * ONE real hop: take the stairs, let the turn settle, and insist the world actually moved.
	 *
	 * The map-moved assertion is not decoration. `descend` returning 'ok' only means the call did not
	 * throw, and a descent that quietly does nothing is this file's oldest failure mode.
	 */
	function stepDown(tag: string): string {
		const before = mapId(s);
		expect(descend(s), `${tag}: the descent did not throw`).toBe('ok');
		turn();
		expect(mapId(s), `${tag}: the descent really moved the party`).not.toBe(before);
		return room();
	}

	/**
	 * Walk down the main path until the game puts the party in a room of its own choosing.
	 *
	 * NOTHING HERE NAMES THE DESTINATION, and the count is not hardcoded: the party leaves the start
	 * room, crosses the opening rooms and a dungeon floor, and a `PerkRoom` appears when the game
	 * decides one should. `KDAdvanceAmount['s']` (`KinkyDungeonTiles.ts:930-946`) forces it once the
	 * stairs are taken down from the deepest floor reached — so if upstream ever stops doing that,
	 * this goes red, which is the point.
	 */
	function walkUntil(want: (r: string) => boolean, max = 5): string {
		const seen: string[] = [room()];
		for (let i = 1; i <= max; i++) {
			const r = stepDown(`hop ${i}`);
			seen.push(r || '(floor)');
			if (want(r)) return r;
		}
		throw new Error(`walked ${max} hops without reaching the wanted room; saw: ${seen.join(' -> ')}`);
	}

	const isHub = (r: string) => r === 'PerkRoom';
	const isFloor = (r: string) => r === '';

	/**
	 * THE REACHABILITY ORACLE — the assertion whose absence let this hide for a whole slice.
	 *
	 * It is deliberately about the GAME, not about our detector: walking the main path must land the
	 * party in a room that is neither the boot room nor a plain dungeon floor, with the fixture never
	 * naming it. Kept separate from the reset tests so that "the hub is unreachable" and "the reset is
	 * broken" can never be confused again.
	 */
	it('R2: walking the main path lands the party in the between-floors room', () => {
		expect(room(), 'precondition: the session boots on the START room').toBe('JourneyFloor');
		const arrived = walkUntil(isHub);
		expect(arrived, 'the game itself chose this room — the fixture never named it').toBe('PerkRoom');
	}, BOOT_TIMEOUT);

	/** R2: and arriving there ends a war that started on the floor below. */
	it('R2: a war started on the floor is over once the party reaches the hub', () => {
		expect(walkUntil(isFloor), 'precondition: out on a real dungeon floor').toBe('');
		fight();
		expect(s._isPvP('A', 'B'), 'precondition: at war on a dungeon floor').toBe(true);
		expect(walkUntil(isHub), 'precondition: the party really reached the hub — else this is vacuous')
			.toBe('PerkRoom');
		expect(s._isPvP('A', 'B'), 'reaching the hub clears the slate').toBe(false);
	}, BOOT_TIMEOUT);

	/**
	 * R3: presence is not arrival, asserted on the REAL room rather than an assigned one.
	 *
	 * The discriminator against the easy, wrong implementation ("clear the war whenever RoomType is
	 * the hub"), which would pass the test above and every mechanism test in the file.
	 */
	it('R3: a war started IN the hub survives the turns spent there', () => {
		expect(walkUntil(isHub), 'precondition: in the hub').toBe('PerkRoom');
		fight();
		expect(s._isPvP('A', 'B'), 'precondition: at war while standing in the hub').toBe(true);
		turn(); turn();
		expect(s._isPvP('A', 'B'),
			'armed by ARRIVING, not by being here — standing still must not re-fire it').toBe(true);
	}, BOOT_TIMEOUT);

	/**
	 * R1 — ONE detector. A structural guard, deliberately: the failure it prevents is a SECOND hub
	 * test being added elsewhere in the file (which is how the gateway would drift into two different
	 * answers to "are we at the hub?"). Behaviour cannot see that; a count can.
	 *
	 * Coupled to our OWN source, not the game's, so it is a maintenance cost we control. It counts the
	 * literal because the identifier is free to be renamed; consumers must ask the detector, never
	 * re-test the room themselves.
	 */
	it('R1: the hub room type is named exactly once in swap-session.js', () => {
		const src = readFileSync(require.resolve('../../tools/mp-server/swap-session.js'), 'utf8');
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const hits = (code.match(/['"`]PerkRoom['"`]/g) || []).length;
		expect(hits,
			`'PerkRoom' appears ${hits}x in swap-session.js code (comments stripped). Exactly one is ` +
			'expected — the hub-room set. A second occurrence is a second detector: consumers must ask ' +
			'the one detector, not re-test the room.').toBe(1);
	});
});
