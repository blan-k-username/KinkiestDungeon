/**
 * KDM-242 — the party agrees which perk it takes, and BOTH players get it.
 *
 * ── WHAT IS BROKEN WITHOUT THIS ───────────────────────────────────────────────────────────────────
 * `KinkyDungeonDrawPerkOrb` (KinkyDungeonShrine.ts:916-1038) contains no `KDSendInput` at all. Both of
 * its writes happen inline in the DRAW function: the card cursor (`KDMapData.SelectedPerk = i`, :980)
 * and the whole Accept block (:955-975 — perks, restraints, escape method, `choseperk`, and the wipe
 * of all three altars). The co-op client is render-only and forwards only what goes through
 * `KDSendInput`, so neither reached the world.
 *
 * Worse than a race, and MEASURED (KDM-242 POC P2): `KDMapData` is world state adopted WHOLESALE by
 * the client (`render-client.js:509`), so the cursor a player sets is overwritten by the next snapshot
 * with the server's value — `-1`, since nothing server-side ever wrote it. The Accept button renders
 * only while `SelectedPerk == i`, so in co-op **it was unreachable**. The party could not take a perk.
 *
 * ── WHY THE PERK IS THE PARTY'S, NOT THE CHARACTER'S (F9) ─────────────────────────────────────────
 * Several perks rewrite the SHARED world: `Stealthy` scales the floor's enemy and treasure counts
 * (KDMapGen.ts:1049, :1770), `Pristine` its rubble (:297), `Fortify_Barricade` the enemy commander's
 * AI (KDCommander.ts:392). All are read from whichever player is swapped in when generation runs, so a
 * per-player perk makes the shared map depend on swap order. The owner ruled perks cannot be
 * per-character; the draft requirement "each player gets their own choice" was withdrawn.
 *
 * ── WHY THIS FILE IS NOT A VACUOUS GREEN ──────────────────────────────────────────────────────────
 *  1. The routing test runs UPSTREAM's own draw function and pairs the wrapped call with a CONTROL
 *     that calls the unwrapped original and DEMANDS it still mutates. If upstream moves the Accept
 *     click, the control goes red — silence there is the drift alarm (KDM-241 R-b, the plugin rule).
 *  2. The fan-out (R1) is asserted on BOTH bundles from the SAME session, so "everybody got it" and
 *     "nobody got it" are distinguishable — and it is paired with a control perk that nobody was
 *     granted, so the assertion cannot pass by the Map simply being full.
 *  3. Consumption (R10/R11) is asserted at two times — after a proposal and after the commit — because
 *     "the altars are spent" at the end is also what you would see if they had been spent too early.
 *  4. No perk name is hardcoded: valid keys are read out of KD's own `KinkyDungeonStatsPresets`, so
 *     this file cannot drift from the game's table and the gateway still names none (R17).
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KDGAMEDATA_WORLD_KEYS } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

function session(players: string[], extra: any = {}) {
	const s: any = new SwapSession({ requiredPlayers: players.length, seed: 'kdm242-perk', pvp: false, ...extra });
	for (const p of players) s.join(p);
	return s;
}

/**
 * Plant a perk room: three altars at known tiles, each offering a DIFFERENT real perk taken from KD's
 * own table. Answers the three perk names so assertions can name them without this file owning a list.
 */
function plantPerkRoom(s: any): string[] {
	return s.world.eval(`(function(){
		// Three perks KD itself knows about, none of them already held — read from the game's table so
		// this fixture cannot drift from it.
		var names = [];
		for (var k in KinkyDungeonStatsPresets) {
			if (!KinkyDungeonStatsChoice.get(k) && KDGetPerkCost(KinkyDungeonStatsPresets[k]) > 0) names.push(k);
			if (names.length >= 4) break;
		}
		var coords = ['5,3', '7,3', '9,3'];
		KDMapData.PerkShrines = coords.slice();
		KDMapData.SelectedPerk = -1;
		for (var i = 0; i < coords.length; i++) {
			var xy = coords[i].split(',');
			KinkyDungeonMapSet(parseInt(xy[0]), parseInt(xy[1]), 'P');
			KinkyDungeonTilesSet(coords[i], {
				Perks: [names[i]], Bondage: [], Method: "", Type: "PerkOrb", Light: 5,
			});
		}
		return names;
	})()`);
}

/** Send the choice the way the client's wrap sends it: a routed input, nothing more. */
function accept(s: any, who: string, index: number) {
	return s.apply(who, { kdType: 'KDCoopPerk', data: { index } });
}

/**
 * Read something out of ONE player's own state, by swapping their bundle in and asking the game.
 *
 * Deliberately not a peek at the bundle's serialised shape: `KinkyDungeonStatsChoice` is a Map, the
 * capture layer tags it through a codec, and a test that hard-codes that encoding is testing the codec
 * rather than the feature. Restoring and asking KD is what the game itself does.
 *
 * It leaves that player swapped in, so callers use it only in assertions at the END of a test.
 */
function readPlayer(s: any, id: string, expr: string): any {
	s.world.restorePlayer(s.bundles.get(id));
	return s.world.eval(`(function(){ return (${expr}); })()`);
}

/** Does this player's own StatsChoice hold the perk? */
function heldBy(s: any, id: string, perk: string): boolean {
	return !!readPlayer(s, id, `!!KinkyDungeonStatsChoice.get(${JSON.stringify(perk)})`);
}

describe('KDM-242 — the party agrees its perk', () => {
	describe('R9 — the Accept click is routed, never applied locally', () => {
		let s: any;
		beforeEach(async () => { s = session(["A", "B"]); await s.ready(); }, BOOT_TIMEOUT);

		/**
		 * The load-bearing test of the whole slice, and the only one that runs UPSTREAM's code.
		 *
		 * It drives the real `KinkyDungeonDrawPerkOrb` with `DrawButtonKDEx` captured, then invokes the
		 * callback KD registered for the Accept button — i.e. exactly what a click does, minus the
		 * pixels. No production test hook is involved: the wrap substitutes callbacks through the same
		 * `DrawButtonKDEx` the capture stands in for.
		 */
		it('KD applies the perk inside the draw call; the wrap suppresses it and routes it instead', () => {
			const perks = plantPerkRoom(s);
			const out = s.world.eval(`(function(){
				var r = {};
				r.wrapped = !!(KinkyDungeonDrawPerkOrb && KinkyDungeonDrawPerkOrb._kdcoop_perk_wrapped);
				var sent = [], captured = {};
				var realSend = KDSendInput, realDraw = DrawButtonKDEx;
				var capture = function (name, cb) { captured[name] = cb; };
				KDSendInput = function (t, d) { sent.push({ t: t, d: d }); return ""; };
				try {
					__KDCoopPerkStats.routed = 0; __KDCoopPerkStats.acceptsSuppressed = 0;
					globalThis.__KDCoopPerkCursor = 1;

					// ── the wrapped function, as the browser calls it every frame
					DrawButtonKDEx = capture;
					KinkyDungeonDrawPerkOrb();
					DrawButtonKDEx = realDraw;
					r.sawAccept = typeof captured['AcceptContractButton1'] === 'function';
					r.sharedCursorAfterDraw = KDMapData.SelectedPerk;
					if (r.sawAccept) captured['AcceptContractButton1']();
					r.sent = JSON.parse(JSON.stringify(sent));
					r.routed = __KDCoopPerkStats.routed;
					r.suppressed = __KDCoopPerkStats.acceptsSuppressed;
					r.perkAfterWrapped = !!KinkyDungeonStatsChoice.get(${JSON.stringify(perks[1])});
					r.tileStillOffered = KinkyDungeonMapGet(7, 3);

					// ── CONTROL: KD's OWN Accept callback must still mutate. If it does not, the wrap
					// above is suppressing nothing and every other test here would still pass.
					captured = {};
					KDMapData.SelectedPerk = 1;
					r.controlPerkBefore = !!KinkyDungeonStatsChoice.get(${JSON.stringify(perks[1])});
					DrawButtonKDEx = capture;
					KinkyDungeonDrawPerkOrb._kdcoop_perk_original();
					DrawButtonKDEx = realDraw;
					r.controlSawAccept = typeof captured['AcceptContractButton1'] === 'function';
					if (r.controlSawAccept) captured['AcceptContractButton1']();
					r.controlPerkAfter = !!KinkyDungeonStatsChoice.get(${JSON.stringify(perks[1])});
					r.controlTile = KinkyDungeonMapGet(7, 3);
				} finally {
					KDSendInput = realSend; DrawButtonKDEx = realDraw;
				}
				return r;
			})()`);

			expect(out.wrapped, 'the wrap is installed in the world at session start').toBe(true);
			expect(out.controlSawAccept,
				'DRIFT ALARM / CONTROL: upstream must still register a button named AcceptContractButton1 '
				+ 'from inside KinkyDungeonDrawPerkOrb. If it does not, the wrap substitutes nothing.').toBe(true);
			expect(out.controlPerkBefore, 'CONTROL precondition: nobody holds it yet').toBe(false);
			expect(out.controlPerkAfter,
				'DRIFT ALARM / CONTROL: …and that callback must still grant the perk itself.').toBe(true);
			expect(out.controlTile, 'CONTROL: …and still spend the altar').toBe('p');

			expect(out.sawAccept,
				'the wrapped draw must offer the button for the PRIVATE cursor position — KD renders it '
				+ 'only while KDMapData.SelectedPerk == i').toBe(true);
			expect(out.sharedCursorAfterDraw,
				'…and must put the shared, broadcast field back afterwards (POC P2)').toBe(-1);
			expect(out.suppressed, 'the wrap saw the Accept it exists to suppress').toBeGreaterThanOrEqual(1);
			expect(out.perkAfterWrapped,
				'R9: the client must be structurally incapable of granting itself a perk').toBe(false);
			expect(out.tileStillOffered,
				'R10: a proposal consumes nothing — the altar is still standing').toBe('P');
			expect(out.routed, 'R9: …and the choice must leave as a routed input instead').toBe(1);
			expect(out.sent).toEqual([{ t: 'KDCoopPerk', d: { index: 1 } }]);
		}, BOOT_TIMEOUT);

		it('R14 — the card cursor is PRIVATE: it never reaches KDMapData, which is broadcast to both', () => {
			plantPerkRoom(s);
			const out = s.world.eval(`(function(){
				var captured = {}, realDraw = DrawButtonKDEx;
				globalThis.__KDCoopPerkCursor = -1;
				try {
					DrawButtonKDEx = function (name, cb) { captured[name] = cb; };
					KinkyDungeonDrawPerkOrb();
				} finally { DrawButtonKDEx = realDraw; }
				var saw = typeof captured['perkshrinechoicebg2'] === 'function';
				if (saw) captured['perkshrinechoicebg2']();
				return { saw: saw, cursor: globalThis.__KDCoopPerkCursor, shared: KDMapData.SelectedPerk };
			})()`);
			expect(out.saw, 'CONTROL: upstream must still register the card-select button').toBe(true);
			expect(out.cursor, 'the highlight moved…').toBe(2);
			expect(out.shared,
				'…but not on KDMapData: POC P2 measured that field arriving IDENTICALLY in both peers\' '
				+ 'snapshots, so a cursor living there is either shared or erased on the next frame').toBe(-1);
		}, BOOT_TIMEOUT);

		it('KDInputTypes.KDCoopPerk is registered once and survives a full turn (KDM-241 P1)', () => {
			const before = s.world.eval('(function(){ return typeof KDInputTypes.KDCoopPerk; })()');
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			const after = s.world.eval('(function(){ return typeof KDInputTypes.KDCoopPerk; })()');
			expect(before).toBe('function');
			expect(after, 'a routed input that evaporates on a swap would fail silently, once').toBe('function');
		}, BOOT_TIMEOUT);

		it('proposing costs the party no turn', () => {
			plantPerkRoom(s);
			expect(s.inputKind.get('KDCoopPerk')).toBe('ui');
		}, BOOT_TIMEOUT);
	});

	describe('R4-R8 — arbitration, and R1 — the grant reaches EVERY seat', () => {
		let s: any;
		let perks: string[];
		beforeEach(async () => {
			s = session(['A', 'B']);
			await s.ready();
			perks = plantPerkRoom(s);
		}, BOOT_TIMEOUT);

		it('R4/R5: one player accepting a card PROPOSES it — the party has not taken it', () => {
			accept(s, 'A', 0);
			expect(s.perkReport().pending).toEqual({ index: 0 });
			expect(s.perkReport().proposer).toBe('A');
			expect(heldBy(s, 'A', perks[0]), 'a proposal grants nothing, not even to the proposer').toBe(false);
			expect(heldBy(s, 'B', perks[0])).toBe(false);
		}, BOOT_TIMEOUT);

		it('R10: …and it consumes no altar', () => {
			accept(s, 'A', 0);
			const tiles = s.world.eval('(function(){ return [KinkyDungeonMapGet(5,3), KinkyDungeonMapGet(7,3), KinkyDungeonMapGet(9,3)]; })()');
			expect(tiles).toEqual(['P', 'P', 'P']);
		}, BOOT_TIMEOUT);

		it('R1/R6: the other player accepting the SAME card commits it — into BOTH bundles', () => {
			accept(s, 'A', 0);
			accept(s, 'B', 0);
			expect(heldBy(s, 'A', perks[0]), 'R1: the perk is the party\'s').toBe(true);
			expect(heldBy(s, 'B', perks[0]), 'R1: …so the player who did not propose it has it too').toBe(true);
			expect(heldBy(s, 'A', perks[1]),
				'CONTROL: a perk the party did NOT take must be absent, or "has it" proves only that the '
				+ 'Map is full').toBe(false);
			expect(heldBy(s, 'B', perks[1])).toBe(false);
		}, BOOT_TIMEOUT);

		it('R11: the commit spends the perk room exactly once, and both players see it spent', () => {
			accept(s, 'A', 0);
			accept(s, 'B', 0);
			const tiles = s.world.eval('(function(){ return [KinkyDungeonMapGet(5,3), KinkyDungeonMapGet(7,3), KinkyDungeonMapGet(9,3)]; })()');
			expect(tiles, 'all three altars are spent, as stock KD does — and KDMapData is shared')
				.toEqual(['p', 'p', 'p']);
		}, BOOT_TIMEOUT);

		it('R12: the commit sets `choseperk` for EVERY seat, or the mandatory-perk exit opens for one', () => {
			accept(s, 'A', 0);
			accept(s, 'B', 0);
			for (const id of ['A', 'B']) {
				expect(readPlayer(s, id, 'KinkyDungeonFlags.get("choseperk") || 0'),
					`${id} must carry choseperk — KDEventMapAlt.tick.PerkRoom reads it to unlock the `
					+ 'perksmandatory exit, and it runs for whoever is swapped in').toBeGreaterThan(0);
			}
		}, BOOT_TIMEOUT);

		it('R7: a DIFFERENT card from the other player re-opens the proposal instead of deadlocking', () => {
			accept(s, 'A', 0);
			accept(s, 'B', 2);
			expect(s.perkReport()).toMatchObject({ pending: { index: 2 }, proposer: 'B' });
			expect(heldBy(s, 'A', perks[0]), 'disagreement is not agreement').toBe(false);
			accept(s, 'A', 2);
			expect(heldBy(s, 'A', perks[2]), '…and agreement is always one pick away').toBe(true);
			expect(heldBy(s, 'B', perks[2])).toBe(true);
		}, BOOT_TIMEOUT);

		it('an index that is not on offer is dropped — no proposal, and no second refusal path', () => {
			accept(s, 'A', 9);
			expect(s.perkReport().pending).toBe(null);
			const tiles = s.world.eval('(function(){ return [KinkyDungeonMapGet(5,3), KinkyDungeonMapGet(7,3), KinkyDungeonMapGet(9,3)]; })()');
			expect(tiles).toEqual(['P', 'P', 'P']);
		}, BOOT_TIMEOUT);


		it('R1: the grant does not drift — it is still on both players several turns later', () => {
			accept(s, 'A', 0);
			accept(s, 'B', 0);
			for (let i = 0; i < 3; i++) { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
			expect(heldBy(s, 'A', perks[0]), 'a perk that evaporates on the next swap is not a grant').toBe(true);
			expect(heldBy(s, 'B', perks[0])).toBe(true);
		}, BOOT_TIMEOUT);

		it('R11: …and the room is still spent several turns later', () => {
			accept(s, 'A', 0);
			accept(s, 'B', 0);
			for (let i = 0; i < 3; i++) { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
			const tiles = s.world.eval('(function(){ return [KinkyDungeonMapGet(5,3), KinkyDungeonMapGet(7,3), KinkyDungeonMapGet(9,3)]; })()');
			expect(tiles).toEqual(['p', 'p', 'p']);
		}, BOOT_TIMEOUT);

		it('R18: the negotiation is the gateway\'s and never reaches KDGameData or a bundle', () => {
			accept(s, 'A', 0);
			const inWorld = s.world.eval(`(function(){
				return JSON.stringify(KDGameData).indexOf('__kdCoopPerkPending') >= 0;
			})()`);
			expect(inWorld).toBe(false);
			for (const id of ['A', 'B']) {
				expect(JSON.stringify(s.bundles.get(id)).indexOf('kdCoopPerkPending')).toBe(-1);
			}
		}, BOOT_TIMEOUT);
	});

	describe('R8 — one seat is stock KD', () => {
		it('a solo player\'s Accept IS the decision, with no proposal step', async () => {
			const s: any = session(['A']);
			await s.ready();
			const perks = plantPerkRoom(s);
			accept(s, 'A', 1);
			expect(s.perkReport().pending, 'a solo run must never wait for a partner').toBe(null);
			expect(heldBy(s, 'A', perks[1])).toBe(true);
		}, BOOT_TIMEOUT);
	});

	describe('A6/D6 — the escape method a card sets is the PARTY\'s', () => {
		it('SelectedEscapeMethod is declared world-scoped in production code, not inferred here', () => {
			expect(KDGAMEDATA_WORLD_KEYS,
				'KDMapGen.ts:694-695 copies it straight into KDMapData.EscapeMethod — the next floor\'s '
				+ 'level goal. A per-player copy makes the goal depend on who took the stairs.')
				.toContain('SelectedEscapeMethod');
		});
	});
});
