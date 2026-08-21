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

	/** D6: the optional detours are exactly what a grudge is supposed to survive. */
	it('AC3/R12: a side room does NOT reset the war', () => {
		for (const room of ['Tunnel', 'PerkRoom', 'ShopStart', 'ElevatorRoom']) {
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
