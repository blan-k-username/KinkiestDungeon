/**
 * KDM-240 A1/A2 — the level goal is CO-LOCATED: the stairs do not fire until the whole party is
 * there, and never while a member is down.
 *
 * Owner decision D1/D2 (2026-08-24). The rule is enforced through KD's OWN stair cancellation —
 * a `beforeStairCancel` handler that sets `data.cancelevent`, plus the matching `KDCancelEvents`
 * entry (`KDStairActions.ts:84-95`) — and NOT by intercepting the move, which would also block
 * simply walking across a stair tile.
 *
 * ⚠️ WHY THESE TESTS DRIVE `KinkyDungeonHandleStairs` DIRECTLY.
 * Descending in play is a two-action sequence: stepping onto 's' only arms `KinkyDungeonConfirmStairs`
 * and prints a confirm prompt (`KinkyDungeonTiles.ts:113-123`); the descent happens on the FOLLOWING
 * action. `KinkyDungeonHandleStairs('s', true)` is the game's own single-call entry point for it and
 * is what KD's own test harness uses (`KinkyDungeonTests.ts:48`). Driving it inside a swap window is
 * therefore the real path with the confirm handshake removed, not a shortcut around the feature.
 *
 * The oracle is the MAP ITSELF (level + RoomType + mapX/mapY), never a message: a gate that printed
 * the right refusal while the party still descended would pass a text assertion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('KDM-240 — the stairs wait for the whole party', () => {
	let s: any;
	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'party-stair-gate', pvp: false });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	/** The game's own name for "which map are we on" — the tuple the jail code uses (KinkyDungeonJail.ts:1737). */
	function mapId(): string {
		return s.world.eval(`(function(){
			return [MiniGameKinkyDungeonLevel, KDGameData.RoomType || '',
				KDMapData.mapX, KDMapData.mapY].join('|');
		})()`);
	}

	/**
	 * Run the descent as `actor` would, inside their own swap window.
	 *
	 * The swap is what makes this real: the gate is consulted while the acting player's bundle is
	 * installed, exactly as it is during `_advanceTurn`.
	 */
	function descendAs(actor: string) {
		s.world.restorePlayer(s.bundles.get(actor));
		const av = s.avatars.get(actor);
		if (av != null) s.world.moveAvatar(av, 1, 1);          // park, as _advanceTurn does
		applyPendingFacts();
		const out = s.world.eval(`(function(){
			// ARMING THE JOURNEY TARGET IS LOAD-BEARING — and it is also what makes this test exercise
			// the gate at all. The session boots on the journey hub, where the stock JourneyChoice
			// cancel filter claims the transition first and opens the journey map instead
			// (KinkyDungeonTiles.ts:12-21). Our gate deliberately abstains when something has already
			// cancelled, so on that first pass it never runs — correctly, since nobody moves. Setting
			// JourneyTarget stands the stock filter down, and the SECOND pass is the one that actually
			// relocates the party and is therefore the one the party rule has to govern.
			var slot = KDGameData.JourneyMap[KDGameData.JourneyX + ',' + KDGameData.JourneyY];
			var c = slot && slot.Connections && slot.Connections[0];
			if (!c) return 'no journey connection to descend to';
			KDGameData.JourneyTarget = { x: c.x, y: c.y };
			KDGameData.UseJourneyTarget = true;
			try { KinkyDungeonHandleStairs('s', true); return 'ok'; }
			catch (e) { return 'threw: ' + e.message; }
		})()`);
		s.bundles.set(actor, s.world.capturePlayer());
		return out;
	}

	/** Put B's avatar exactly `d` tiles away from A (Chebyshev), so co-location is a decided input. */
	function placeBAt(d: number) {
		const a = s.world.eval('(function(){ return {x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y}; })()');
		s.world.moveAvatar(s.avatars.get('B'), a.x + d, a.y);
	}

	/**
	 * The party facts the session is responsible for supplying (A2) — DECLARED here, APPLIED after the
	 * swap.
	 *
	 * ⚠️ The order is load-bearing and this indirection exists to enforce it. `KDEventMapGeneric` and
	 * `KDCancelEvents` are captured as per-player bundle state, so `restorePlayer` REPLACES them and
	 * takes the gate's handler registration with it. `setPartyGate` therefore has to run inside the
	 * acting player's swap window — which is exactly where `_pushPartyGate` calls it in `_advanceTurn`.
	 * Calling it before the swap looks identical, is silently a no-op, and reads as "the gate is
	 * broken": that is precisely what an earlier draft of this file did.
	 */
	let pendingFacts: any = null;
	function gate(facts: any) { pendingFacts = facts; }
	function applyPendingFacts() { if (pendingFacts) s.world.setPartyGate(pendingFacts); }

	function peersAround(cid: string) {
		return [{ x: s.posOf(cid).x, y: s.posOf(cid).y, name: s.displayNameOf(cid) }];
	}

	it('R1: a partner who is not at the stairs cancels the transition — the party stays put', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		placeBAt(6);
		const before = mapId();
		gate({ peers: peersAround('B'), down: [], radius: 1 });

		descendAs('A');

		expect(mapId(),
			'A descended while B was six tiles away — the level goal is co-located (D1), so the ' +
			'transition must have been CANCELLED and the map must be unchanged').toBe(before);
	});

	it('R1: with the partner adjacent, the stairs fire normally', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		placeBAt(1);
		const before = mapId();
		gate({ peers: peersAround('B'), down: [], radius: 1 });

		descendAs('A');

		expect(mapId(),
			'B was standing next to the stairs, so nothing should have been cancelled. If this is ' +
			'equal to the starting map the gate is refusing EVERY descent, not just an uncoordinated ' +
			'one — which would soft-lock every co-op run.').not.toBe(before);
	});

	it('R2: the cancelled player is told WHO is missing, by name', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		placeBAt(6);
		const len0 = s.world.messageLogLength();
		gate({ peers: peersAround('B'), down: [], radius: 1 });

		descendAs('A');

		const said = (s.world.messagesSince(len0) || []).map((m: any) => String(m.text || m)).join(' | ');
		expect(said, `a silent refusal is indistinguishable from a broken control. Log was: ${said}`)
			.toContain(s.displayNameOf('B'));
	});

	it('R3: a defeated partner cancels the transition even when they ARE at the stairs', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		placeBAt(1);
		const before = mapId();
		gate({ peers: peersAround('B'), down: [s.displayNameOf('B')], radius: 1 });

		descendAs('A');

		expect(mapId(),
			'D2: the party cannot complete the level while a member is down, even standing right ' +
			'there. This is the case co-location alone does not cover.').toBe(before);
	});

	it('R3: the defeat gate is not permanent — it lifts when the player is no longer down', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		placeBAt(1);
		const before = mapId();
		gate({ peers: peersAround('B'), down: [s.displayNameOf('B')], radius: 1 });
		descendAs('A');
		expect(mapId(), 'precondition: blocked while down').toBe(before);

		gate({ peers: peersAround('B'), down: [], radius: 1 });   // Will recovered → _markRecovered
		descendAs('A');

		expect(mapId(),
			'a gate that cannot lift is a soft-lock, not a rule. `defeated` clears on its own as ' +
			'Will recovers (_markRecovered), so the stairs must open again.').not.toBe(before);
	});

	it('R7: a FORCED transition is never gated — a leash-drag is not the party\'s choice', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		placeBAt(6);
		const before = mapId();
		gate({ peers: peersAround('B'), down: [], radius: 1 });
		applyPendingFacts();       // in the swap window, as always — see `gate`

		// `force` is the game's own flag for "this is not the player choosing to leave"; the stock
		// JourneyChoice cancel returns "" on it (KinkyDungeonTiles.ts:6). Ours must too, or the jail
		// flow and enemy leash-drags would be blocked by a rule that has no business there.
		s.world.eval(`(function(){
			var slot = KDGameData.JourneyMap[KDGameData.JourneyX + ',' + KDGameData.JourneyY];
			var c = slot && slot.Connections && slot.Connections[0];
			if (c) { KDGameData.JourneyTarget = { x: c.x, y: c.y }; KDGameData.UseJourneyTarget = true; }
			try { KDGoThruTile(KinkyDungeonPlayerEntity.x, KinkyDungeonPlayerEntity.y, true, true, false, true); }
			catch (e) { /* the transition itself may fail headlessly; the GATE must not be why */ }
		})()`);

		expect(mapId(),
			'a forced transition was blocked by the party gate — that makes a player unjailable and ' +
			'un-draggable, which is a gameplay rule we have no business writing').not.toBe(before);
	});

	it('AC: with one player seated the gate is fully OFF — solo behaviour is untouched', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		const before = mapId();
		gate({ peers: [], down: [], radius: 1 });      // what a one-player session pushes

		descendAs('A');

		expect(mapId(),
			'empty party facts must disable the gate completely. A session with nobody to wait for ' +
			'that still refuses the stairs has made single-player worse.').not.toBe(before);
	});

	it('A2: the session pushes the OTHER players\' facts before each apply, never the actor\'s own', () => {
		const calls: any[] = [];
		const real = s.world.setPartyGate.bind(s.world);
		s.world.setPartyGate = (facts: any) => { calls.push(JSON.parse(JSON.stringify(facts || {}))); return real(facts); };

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(calls.length, 'the gate facts must be refreshed for EVERY apply — a stale peer ' +
			'position is a gate that answers about last turn').toBe(2);
		for (const f of calls) {
			expect(f.peers.length,
				'exactly one peer is pushed: the party minus the player whose action is being applied. ' +
				'Including the actor would make them block their own descent forever.').toBe(1);
		}
		const names = calls.map((f) => f.peers[0].name).sort();
		expect(names, 'each player is the OTHER one\'s peer, so across the two applies both names appear')
			.toEqual([s.displayNameOf('A'), s.displayNameOf('B')].sort());
	});
});
