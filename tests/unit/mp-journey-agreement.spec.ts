/**
 * Node-layer (Vitest) — KDM-263: two players agree the route out of the hub.
 *
 * ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────────────────────────
 * `KDRenderJourneyMap` writes `KDGameData.JourneyTarget` INLINE, inside the DRAW function
 * (`KDJourney.ts:388-395` from the mouse, `:434-452` from the keyboard) — never through `KDSendInput`.
 * The co-op client forwards only what goes through `KDSendInput`, so a click moved the CLIENT's target
 * and nothing else. KD's own `KDCancelFilters.JourneyChoice` then refused the stairs forever and
 * re-opened the map, which since KDM-239 R7 both players actually see. A two-player party could not
 * leave a `PerkRoom` at all.
 *
 * ── WHAT THIS SPEC IS CAREFUL ABOUT ───────────────────────────────────────────────────────────────
 * The feature's own fix is TEXT-COUPLED to an upstream draw function, so the failure mode that matters
 * is not "the arbitration is wrong" — it is "the wrap silently stopped seeing the write", after which
 * every arbitration test below still passes while the game is broken again. So the first test drives
 * KD's REAL code path (measured: `KDRenderJourneyMap` runs headless, keybinding branch included) and
 * carries a CONTROL that calls the UNWRAPPED original and demands it DOES write. If upstream moves
 * the click elsewhere, that control fails and names the reason.
 *
 * The arbitration tests plant a journey map, because the boot map's current slot has exactly ONE
 * connection and "the other player picked a different slot" cannot be expressed on it.
 *
 * ── WHY THE WORLD-SCOPING HALF NEEDS A DIVERGENCE, NOT A COMPARISON ───────────────────────────────
 * Both players' `JourneyMap`s are byte-identical at boot (MEASURED, KDM-241 P2), so a test that
 * compared two boot-time maps would pass on a completely unfixed build. The divergence is created by
 * a descent (`KDAdvanceLevel` prunes the departed slot's Connections), so this spec constructs it —
 * and pairs it with a CONTROL key on the same bundle, the `mp-room-world-state.spec.ts` rule: "the
 * world key held its ground" is also what you would see if the restore had done nothing at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { SwapSession } = require('../../tools/mp-server/swap-session');
const { KDGAMEDATA_WORLD_KEYS } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

/** A key no game code writes, so its arrival can only mean "this bundle was restored". */
const CONTROL_KEY = '__kdm263RestoreProbe';

/**
 * A journey map the arbitration can actually be argued over: the party stands at 0,0 and TWO routes
 * lead onward. 9,9 exists but is connected to nothing, so it is the illegal pick.
 */
const FORK = {
	'0,0': { x: 0, y: 0, type: 'shop', color: '#fffafa', Connections: [{ x: 0, y: 1 }, { x: 1, y: 1 }], SideRooms: [], HiddenRooms: {}, MapMod: '', RoomType: '', Faction: '', EscapeMethod: '' },
	'0,1': { x: 0, y: 1, type: 'dungeon', color: '#fffafa', Connections: [], SideRooms: [], HiddenRooms: {}, MapMod: 'LeftMod', RoomType: '', Faction: '', EscapeMethod: '' },
	'1,1': { x: 1, y: 1, type: 'dungeon', color: '#fffafa', Connections: [], SideRooms: [], HiddenRooms: {}, MapMod: 'RightMod', RoomType: '', Faction: '', EscapeMethod: '' },
	'9,9': { x: 9, y: 9, type: 'dungeon', color: '#fffafa', Connections: [], SideRooms: [], HiddenRooms: {}, MapMod: 'Unreachable', RoomType: '', Faction: '', EscapeMethod: '' },
};

const LEFT = { x: 0, y: 1 };
const RIGHT = { x: 1, y: 1 };
const UNREACHABLE = { x: 9, y: 9 };

function session(players: string[], extra: any = {}) {
	const s: any = new SwapSession({ requiredPlayers: players.length, seed: 'kdm263-journey', pvp: false, ...extra });
	for (const p of players) s.join(p);
	return s;
}

/** Plant the fork, with the party standing at its root and nothing agreed yet. */
function plantFork(s: any) {
	s.world.eval(`(function(){
		KDGameData.JourneyMap = ${JSON.stringify(FORK)};
		KDGameData.JourneyX = 0; KDGameData.JourneyY = 0;
		KDGameData.JourneyTarget = null; KDGameData.UseJourneyTarget = false;
	})()`);
}

/** Send the choice the way the client's wrap sends it: a routed input, nothing more. */
function pick(s: any, who: string, slot: { x: number, y: number }) {
	return s.apply(who, { kdType: 'KDCoopJourney', data: { x: slot.x, y: slot.y } });
}

describe('KDM-263 — the party agrees its route', () => {
	describe('R9 — a choice made in the draw function is routed, never committed locally', () => {
		let s: any;
		beforeEach(async () => {
			s = session(['A', 'B']);
			await s.ready();
		}, BOOT_TIMEOUT);

		/**
		 * The load-bearing test of the whole slice, and the only one that runs UPSTREAM's code.
		 *
		 * It drives the keyboard branch (`KinkyDungeonKeybindingCurrentKey === KinkyDungeonKeyWait[0]`
		 * → `JourneyTarget = currentSlot.Connections[0]`) rather than the mouse branch, because the
		 * keyboard branch needs no MouseIn geometry. Both branches are the same inline write inside the
		 * same draw call, which is the thing being reverted.
		 */
		it('KD writes the target inside the draw call; the wrap reverts it and routes it instead', () => {
			plantFork(s);
			const out = s.world.eval(`(function(){
				var r = {};
				r.wrapped = !!(KDRenderJourneyMap && KDRenderJourneyMap._kdcoop_journey_wrapped);
				var sent = [];
				var realSend = KDSendInput;
				KDSendInput = function (t, d) { sent.push({ t: t, d: d }); return ""; };
				try {
					// ── the wrapped function, as the browser calls it every frame
					__KDCoopJourneyStats.observed = 0; __KDCoopJourneyStats.routed = 0;
					KDGameData.JourneyTarget = null;
					KinkyDungeonKeybindingCurrentKey = KinkyDungeonKeyWait[0];
					KDRenderJourneyMap(0, 99, 5, 7);
					r.afterWrapped = KDGameData.JourneyTarget;
					r.observed = __KDCoopJourneyStats.observed;
					r.routed = __KDCoopJourneyStats.routed;
					r.sent = JSON.parse(JSON.stringify(sent));

					// ── CONTROL: the same call on the UNWRAPPED original must still write.
					KDGameData.JourneyTarget = null;
					KinkyDungeonKeybindingCurrentKey = KinkyDungeonKeyWait[0];
					KDRenderJourneyMap._kdcoop_journey_original(0, 99, 5, 7);
					r.afterOriginal = KDGameData.JourneyTarget
						? { x: KDGameData.JourneyTarget.x, y: KDGameData.JourneyTarget.y } : null;
				} finally {
					KDSendInput = realSend;
					KDGameData.JourneyTarget = null;
				}
				return r;
			})()`);

			expect(out.wrapped, 'the wrap is installed in the world at session start').toBe(true);
			expect(out.afterOriginal,
				'DRIFT ALARM / CONTROL: upstream must still write KDGameData.JourneyTarget from inside '
				+ 'KDRenderJourneyMap. If this is null, the click moved elsewhere and the wrap below is '
				+ 'reverting nothing — every other test in this file would still pass.').toEqual(LEFT);
			expect(out.observed, 'the wrap saw the write it exists to revert').toBeGreaterThanOrEqual(1);
			expect(out.afterWrapped,
				'R9: the client must be structurally incapable of committing a route locally').toBe(null);
			expect(out.routed, 'R9: …and the choice must leave as a routed input instead').toBe(1);
			expect(out.sent).toEqual([{ t: 'KDCoopJourney', d: { x: LEFT.x, y: LEFT.y } }]);
		}, BOOT_TIMEOUT);

		/**
		 * R8 — KD nulls `JourneyTarget` for reasons that are REFUSALS, not choices: the Cancel button
		 * (`KDJourney.ts:271`) and a click on a slot that is not connected (`:394`). Routing one would
		 * be the second refusal path this slice is required not to invent.
		 *
		 * Driven through the real MOUSE branch, which is where the `else … = null` lives — the frame
		 * hovers a slot the party cannot reach and clicks it. Coordinates come from the same arithmetic
		 * KDRenderJourneyMap draws with, so the fixture aims at the sprite the game itself placed.
		 */
		it('a refusal (an unconnected slot, clicked) is reverted but NOT proposed', () => {
			plantFork(s);
			const out = s.world.eval(`(function(){
				var sent = [], realSend = KDSendInput;
				KDSendInput = function (t, d) { sent.push({ t: t, d: d }); return ""; };
				try {
					__KDCoopJourneyStats.observed = 0; __KDCoopJourneyStats.routed = 0;
					// Something already agreed, so a clear is visible as a CHANGE rather than a no-op.
					KDGameData.JourneyTarget = { x: 0, y: 1 };
					KinkyDungeonKeybindingCurrentKey = "";
					// Hover + click the unreachable slot at 9,9. X/Y/offsets mirror the call the game
					// makes from KDRender.ts, so the sprite really is where the mouse is.
					var X = 9, Y = 9, ScaleX = 100, ScaleY = 136, xOff = 1450, yOff = 212, size = 72;
					MouseX = xOff; MouseY = yOff;
					MouseClicked = true;
					KDRenderJourneyMap(X, Y, 5, 7, ScaleX, ScaleY, xOff, yOff, size);
					return {
						hovered: __KDCoopJourneyStats.observed, routed: __KDCoopJourneyStats.routed,
						target: KDGameData.JourneyTarget ? { x: KDGameData.JourneyTarget.x, y: KDGameData.JourneyTarget.y } : null,
						sent: sent,
					};
				} finally { KDSendInput = realSend; MouseClicked = false; KDGameData.JourneyTarget = null; }
			})()`);
			expect(out.hovered,
				'PRECONDITION: KD must have taken the click and nulled the target — otherwise this test '
				+ 'exercises nothing and its green is free').toBeGreaterThanOrEqual(1);
			expect(out.target, 'the local write is reverted like any other').toEqual(LEFT);
			expect(out.routed, 'R8: a refusal is not a proposal, so nothing is routed').toBe(0);
			expect(out.sent).toEqual([]);
		}, BOOT_TIMEOUT);

		it('KDInputTypes.KDCoopJourney is registered once and survives a full turn (KDM-241 P1)', () => {
			// A3 rests on this measurement. Pinned rather than trusted: if KDInputTypes ever became
			// per-player state, the entry would vanish after the first swap and every proposal after the
			// first would be an UNKNOWN input that did nothing — silently.
			const before = s.world.eval('typeof KDInputTypes.KDCoopJourney');
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			expect(before).toBe('function');
			expect(s.world.eval('typeof KDInputTypes.KDCoopJourney'),
				'the routed input type must survive a swap, or A3 needs a re-assert loop').toBe('function');
			expect(s.unknownInputReport().find((u: any) => u.type === 'KDCoopJourney'),
				'…and must never be reported as an unknown type').toBeUndefined();
		}, BOOT_TIMEOUT);
	});

	describe('R4-R8 — arbitration between two players', () => {
		let s: any;
		beforeEach(async () => {
			s = session(['A', 'B']);
			await s.ready();
			plantFork(s);
		}, BOOT_TIMEOUT);

		it('R4/R5: one player picking a slot proposes it — it is not the party\'s route yet', () => {
			pick(s, 'A', LEFT);
			const r = s.journeyReport();
			expect(r.pending, 'R4: the session holds the proposal').toEqual(LEFT);
			expect(r.proposer, 'R4: …and who made it').toBe('A');
			expect(r.committed, 'R5: one player is not agreement').toBe(null);
			for (const id of ['A', 'B']) {
				expect((s.logs.get(id) || []).map((m: any) => m.text || m).join(' '),
					`R5: ${id} must be told what was proposed and by whom`).toMatch(/proposes the route/i);
			}
		}, BOOT_TIMEOUT);

		it('R6: the other player picking the SAME slot agrees it, and KD\'s own fields say so', () => {
			pick(s, 'A', LEFT);
			pick(s, 'B', LEFT);
			const r = s.journeyReport();
			expect(r.committed, 'R6: the agreed slot is the party\'s JourneyTarget').toEqual({ ...LEFT, use: true });
			expect(r.pending, 'R6: nothing is pending once it is agreed').toBe(null);
			expect((s.logs.get('A') || []).map((m: any) => m.text || m).join(' '))
				.toMatch(/party takes the route/i);
		}, BOOT_TIMEOUT);

		it('R7: the other player picking a DIFFERENT slot re-opens the proposal instead of deadlocking', () => {
			pick(s, 'A', LEFT);
			pick(s, 'B', RIGHT);
			let r = s.journeyReport();
			expect(r.pending, 'R7: the newer choice replaces the older').toEqual(RIGHT);
			expect(r.proposer, 'R7: …and the proposer role moves with it').toBe('B');
			expect(r.committed, 'R7: a disagreement commits nothing').toBe(null);
			// …and the party can still converge, which is the point of flipping the role.
			pick(s, 'A', RIGHT);
			r = s.journeyReport();
			expect(r.committed, 'R7: agreeing with the counter-proposal settles it').toEqual({ ...RIGHT, use: true });
		}, BOOT_TIMEOUT);

		it('R7: a new proposal un-commits an already agreed route', () => {
			pick(s, 'A', LEFT);
			pick(s, 'B', LEFT);
			expect(s.journeyReport().committed).toEqual({ ...LEFT, use: true });
			pick(s, 'A', RIGHT);
			const r = s.journeyReport();
			expect(r.committed,
				'the party has not left yet, so the decision is not final — and leaving a stale commit '
				+ 'standing would let the party descend on a route it stopped agreeing on').toBe(null);
			expect(r.pending).toEqual(RIGHT);
		}, BOOT_TIMEOUT);

		it('R8: an unconnected slot is dropped — no proposal, and no second refusal path', () => {
			pick(s, 'A', UNREACHABLE);
			const r = s.journeyReport();
			expect(r.pending, 'a slot KD would refuse never becomes the party\'s proposal').toBe(null);
			expect(r.committed).toBe(null);
			expect((s.logs.get('A') || []).map((m: any) => m.text || m).join(' '),
				'R8: KD\'s own JourneyChoice cancellation is the ONE refusal the player is shown')
				.not.toMatch(/proposes the route|cannot|refuse/i);
		}, BOOT_TIMEOUT);

		it('proposing costs the party no turn', () => {
			const turn0 = s.turn;
			const res = pick(s, 'A', LEFT);
			expect(res.kind, 'A3: seeded as a ui input, so it applies immediately').toBe('ui');
			expect(s.turn, 'a proposal must not spend the turn the party is waiting to take').toBe(turn0);
			expect(s.inputKind.get('KDCoopJourney')).toBe('ui');
		}, BOOT_TIMEOUT);

		it('A2/R16: the negotiation is the gateway\'s and never reaches KDGameData or a bundle', () => {
			pick(s, 'A', LEFT);
			const strayWorldKeys = s.world.eval(
				'Object.keys(KDGameData).filter(function(k){ return /coop|Coop|pending|proposer/.test(k); })');
			expect(strayWorldKeys,
				'"wait for your partner" cannot exist in a one-player game, so it is not world state').toEqual([]);
			const snap = s.snapshotFor('B');
			expect(JSON.stringify(snap.bundle || {}),
				'…and it must not be replicated to a client either').not.toMatch(/proposer/);
		}, BOOT_TIMEOUT);

		it('the proposal is dropped when the party changes map', () => {
			pick(s, 'A', LEFT);
			expect(s.journeyReport().pending).toEqual(LEFT);
			s._onMapChanged('A', 'some-other-map');
			expect(s.journeyReport().pending,
				'an unfinished argument about how to get here is over once we are here').toBe(null);
		}, BOOT_TIMEOUT);
	});

	describe('R15 — one seat behaves exactly like stock KD', () => {
		it('a single player\'s choice IS the decision, with no proposal and no confirmation', async () => {
			const s: any = session(['A']);
			await s.ready();
			plantFork(s);
			pick(s, 'A', RIGHT);
			const r = s.journeyReport();
			expect(r.committed, 'with nobody to agree with, picking is deciding').toEqual({ ...RIGHT, use: true });
			expect(r.pending).toBe(null);
			expect((s.logs.get('A') || []).map((m: any) => m.text || m).join(' '),
				'R15: a solo player must never be asked to wait for a partner')
				.not.toMatch(/proposes the route/i);
		}, BOOT_TIMEOUT);
	});

	describe('R10/R11 — the route is the party\'s, whichever player takes the stairs', () => {
		let s: any;
		beforeEach(async () => {
			s = session(['A', 'B']);
			await s.ready();
			plantFork(s);
		}, BOOT_TIMEOUT);

		it('the classification is declared in production code, not inferred by this test', () => {
			for (const k of ['JourneyMap', 'JourneyTarget', 'UseJourneyTarget']) {
				expect(KDGAMEDATA_WORLD_KEYS, `${k} must be declared world-scoped`).toContain(k);
			}
		});

		it('a stale bundle cannot stamp its own route or its own map onto the party', () => {
			pick(s, 'A', LEFT);
			pick(s, 'B', LEFT);
			// Make BOTH bundles disagree with the world — with only one stale bundle the other player's
			// turn would restore the right value and the world would end up correct by accident. The
			// pruned Connections are what a real descent does to the map (KDAdvanceLevel), i.e. the
			// divergence that boot-time equality hides.
			for (const [id, b] of s.bundles) {
				b.gameData.JourneyTarget = { x: 9, y: 9 };
				b.gameData.UseJourneyTarget = false;
				b.gameData.JourneyMap = { '0,0': { x: 0, y: 0, Connections: [], SideRooms: [], HiddenRooms: {} } };
				b.gameData[CONTROL_KEY] = `restored-from-${id}`;
			}

			s.world.restorePlayer(s.bundles.get('A'));
			const after = s.world.eval(`(function(){
				return {
					probe: KDGameData[${JSON.stringify(CONTROL_KEY)}],
					target: KDGameData.JourneyTarget,
					use: !!KDGameData.UseJourneyTarget,
					slots: Object.keys(KDGameData.JourneyMap).length,
					mapModOfTarget: (KDGameData.JourneyMap[KDGameData.JourneyTarget.x + ',' + KDGameData.JourneyTarget.y] || {}).MapMod,
				};
			})()`);

			expect(after.probe,
				'CONTROL: an ordinary KDGameData key on the SAME bundle must be installed — without it '
				+ 'this test proves only that restorePlayer did nothing at all').toBe('restored-from-A');
			expect(after.target, 'R11: the agreed slot is the party\'s, not the acting player\'s').toEqual(LEFT);
			expect(after.use, 'R11: …and it is armed, or KD ignores it entirely').toBe(true);
			expect(after.slots, 'R10: a player\'s pruned map must not become the party\'s').toBe(4);
			expect(after.mapModOfTarget,
				'R11: KDStairActions reads JourneyMap[JourneyTarget] for the next floor — both halves '
				+ 'must come from the world, or the next floor is whoever was swapped in').toBe('LeftMod');
		}, BOOT_TIMEOUT);

		it('the client is SENT the world\'s route rather than keeping its own copy', () => {
			pick(s, 'A', LEFT);
			pick(s, 'B', LEFT);
			const snap = s.snapshotFor('B');
			expect(snap.worldGameData, 'the world half of KDGameData rides the snapshot').toBeTruthy();
			expect(snap.worldGameData.JourneyTarget).toEqual(LEFT);
			expect(snap.worldGameData.UseJourneyTarget).toBe(true);
			expect(Object.keys(snap.worldGameData.JourneyMap).length).toBe(4);
			// The other half of the same rule: a world key must NOT also travel as per-player state, or
			// the client has two answers and adopts whichever arrives last.
			for (const k of KDGAMEDATA_WORLD_KEYS) {
				expect(Object.prototype.hasOwnProperty.call(snap.bundle.gameData, k),
					`${k} is world state and must be stripped from the per-player bundle`).toBe(false);
			}
		}, BOOT_TIMEOUT);
	});
});
