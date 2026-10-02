/**
 * Node-layer (Vitest) acceptance tests for the last `turn-classification.js` MIXED systems named by
 * the coordinator's remaining-scope note: `KinkyDungeonUpdateAngel`, `KinkyDungeonUpdateTether`, the
 * player-only code interleaved inside `KinkyDungeonUpdateEnemies`, and the `KinkyDungeonSendEvent`
 * dispatcher set.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour, placePlayerAt } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

describe('KinkyDungeonUpdateAngel: already correct — a per-player flag gates an idempotent world write', () => {
	it('B\'s own AngelHelp flag removes the shared Angel tile even though A hosts the round\'s one real tick', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'angel-nonhost-flag' });
		s.join('A'); s.join('B');
		await s.ready();

		const posB = s.posOf('B');
		const tileLoc = `${posB.x + 2},${posB.y}`;
		s.world.eval(`(function(){ KDMapData.Tiles[${JSON.stringify(tileLoc)}] = { Type: "Angel" }; })()`);
		expect(s.world.eval(`(KDMapData.Tiles[${JSON.stringify(tileLoc)}] && KDMapData.Tiles[${JSON.stringify(tileLoc)}].Type)`),
			'liveness: the fabricated Angel tile must exist before the round').toBe('Angel');

		// Only B has the flag — A (who hosts the round's one real engine tick) never does.
		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval('KinkyDungeonFlags.set("AngelHelp", 2);');
		s.bundles.set('B', s.world.capturePlayer());

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		const type = s.world.eval(`(KDMapData.Tiles[${JSON.stringify(tileLoc)}] && KDMapData.Tiles[${JSON.stringify(tileLoc)}].Type)`);
		expect(type, 'B\'s own AngelHelp flag must still clear the shared Angel tile, even though B is ' +
			'never the slot occupant at the round\'s one real tick').not.toBe('Angel');
	}, BOOT_TIMEOUT);
});

describe('KinkyDungeonUpdateTether: an enemy\'s leash pulls ITS OWNER human, not whoever hosts the round', () => {
	it('a leash created during B\'s own turn tracks B\'s position, not A\'s (the round\'s host)', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'tether-owner-routing', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();

		const nb = freeNeighbour(s, 'A');
		if (!nb) throw new Error('setup invalid: no free tile beside A to put B on');
		placePlayerAt(s, 'B', nb.x, nb.y);
		const posB = s.posOf('B');

		// Attach the leash while B is the swapped-in player, so the engine's own `entity.player`
		// branch (KDTethers.ts:203-210) resolves the anchor to B specifically — exactly how a real
		// grab during B's own apply would create it.
		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			KinkyDungeonAttachTetherToEntity(2.5, KinkyDungeonPlayerEntity, e, "Default");
		})()`);
		s.bundles.set('B', s.world.capturePlayer());
		// Tag it the same way `_advanceTurn` tags a tether created during an apply — owned by B.
		s.world.tagOwnedTethers('B');

		const leashedBefore = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			return !!(e && e.leash);
		})()`);
		expect(leashedBefore, 'liveness: the enemy must actually be leashed before the round').toBe(true);

		// Move B again so B's post-leash position differs from A's — the discriminating position.
		placePlayerAt(s, 'B', posB.x, posB.y);

		// A hosts the round's one real engine tick.
		s._shuffle = () => ['B', 'A'];
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		const leash = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			return e && e.leash ? { x: e.leash.x, y: e.leash.y } : null;
		})()`);
		expect(leash, 'liveness: the leash must survive the round').not.toBeNull();
		const posA = s.posOf('A');
		expect(leash, 'the tether must pull toward B (its real owner), not A (the round\'s host) — a ' +
			'leash routed to whoever hosts the round\'s one real tick would silently reassign every ' +
			'leashed enemy to the wrong human').toEqual({ x: posB.x, y: posB.y });
		expect(leash).not.toEqual({ x: posA.x, y: posA.y });
	}, BOOT_TIMEOUT);

	it('CONTROL: a 1-player session\'s own leash is unaffected by the owner-routing wrap', async () => {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'tether-owner-routing-solo', enemyType: 'Rat' });
		solo.join('A');
		await solo.ready();

		solo.world.restorePlayer(solo.bundles.get('A'));
		solo.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${solo.enemyId}; });
			KinkyDungeonAttachTetherToEntity(2.5, KinkyDungeonPlayerEntity, e, "Default");
		})()`);
		solo.bundles.set('A', solo.world.capturePlayer());
		solo.world.tagOwnedTethers('A');

		solo.submit('A', { kind: 'wait' });

		const leash = solo.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${solo.enemyId}; });
			return e && e.leash ? { x: e.leash.x, y: e.leash.y } : null;
		})()`);
		const posA = solo.posOf('A');
		expect(leash, 'control: the only player\'s own leash still tracks them').toEqual({ x: posA.x, y: posA.y });
	}, BOOT_TIMEOUT);

	it('a leash attached to a switched-in (non-applying) human while the per-enemy slot switch is ' +
		'armed is owned by THAT human, not whoever applies the round', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'tether-slotswitch-mistag', enemyType: 'Rat' });
		s.join('A'); s.join('B');
		await s.ready();

		// SwapSession's own bookkeeping (_slotOccupant) leaves whoever joined LAST (B) restored, not
		// the round's host (A) — put A in the slot first, exactly like the start of a real apply, or
		// the swap-to-B below is a same-occupant no-op (_slotSwapTo short-circuits when
		// outgoing === targetId) and never actually moves __kdSlotCurrent.
		s._slotSwapTo('A');
		// Put the world in exactly the state installTurnModel's own per-enemy slot switch creates
		// mid-pass: armed, hosted by A, with B momentarily holding the slot (the real __kdSlotSwapTo
		// callback — the same cross-realm function KinkyDungeonNearestPlayer's wrap calls — not a
		// position-only move).
		s.world.armSlotSwitch('A', [
			{ cid: 'A', avatarId: s.avatars.get('A') },
			{ cid: 'B', avatarId: s.avatars.get('B') },
		], {});
		s.world.eval('globalThis.__kdSlotSwapTo("B")');
		// While B holds the slot, an enemy leashes "the player" — exactly what a real grab/tease
		// attack resolved against B (via the slot switch) would do.
		s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			KinkyDungeonAttachTetherToEntity(2.5, KinkyDungeonPlayerEntity, e, "Default");
		})()`);
		const leashedWhileB = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${s.enemyId}; });
			return !!(e && e.leash);
		})()`);
		expect(leashedWhileB, 'liveness: the enemy must actually be leashed while B holds the slot').toBe(true);
		// Hand the slot back to the host and disarm, exactly as installTurnModel's own
		// KinkyDungeonUpdateEnemies wrap does before the real apply returns.
		s.world.eval('globalThis.__kdSlotSwapTo("A")');
		s.world.disarmSlotSwitch();

		// Simulate what _advanceTurn calls right after A's own apply finishes this round — the "first
		// touch" sweep that would, without the creation-time fix, claim this untagged leash for A.
		s.world.tagOwnedTethers('A');

		const owner = s.world.eval(`(globalThis.__kdTetherOwner || {})[${s.enemyId}]`);
		expect(owner, 'the leash was anchored to B (the live slot identity at the moment it was ' +
			'created), not A (who merely hosts this round\'s one real apply) — tagging it by "whoever ' +
			'is applying" instead of by the slot identity at creation time would silently hand B\'s own ' +
			'leash to A, and every future round would then pull the enemy toward the wrong human')
			.toBe('B');
	}, BOOT_TIMEOUT);
});

describe('KinkyDungeonUpdateEnemies: the player-only pre/post code must run for every human, not just the host', () => {
	it('B\'s own dialogue tick fires every round, not just on the round\'s one real (host) apply', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'ue-dialogue-per-player' });
		s.join('A'); s.join('B');
		await s.ready();

		// KinkyDungeonUpdateDialogue(entity, delta) decays entity.dialogueDuration — a property on the
		// PLAYER ENTITY object itself (KinkyDungeonPlayerEntity, already per-player — SLOT_SWAP_GLOBALS).
		// Arm B's own dialogue duration, then confirm it ticks down on B's OWN apply even though A
		// hosts the round's one real engine tick.
		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval('KinkyDungeonPlayerEntity.dialogueDuration = 5;');
		s.bundles.set('B', s.world.capturePlayer());

		s._shuffle = () => ['B', 'A'];
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		s.world.restorePlayer(s.bundles.get('B'));
		const after = s.world.eval('KinkyDungeonPlayerEntity.dialogueDuration');
		expect(after, 'B\'s own dialogue tick (KinkyDungeonUpdateDialogue, called with ' +
			'KinkyDungeonPlayerEntity from inside the Allied branch) must run on B\'s own apply, not be ' +
			'dropped by the round\'s world-mute, which currently mutes the WHOLE ' +
			'KinkyDungeonUpdateEnemies call for every apply but the host\'s').toBeLessThan(5);
	}, BOOT_TIMEOUT);

	it('B\'s own leashed-to-jail countdown decays every round, not just on the host\'s apply', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'ue-leashedplayer-per-player' });
		s.join('A'); s.join('B');
		await s.ready();

		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval('KDGameData.KinkyDungeonLeashedPlayer = 5;');
		s.bundles.set('B', s.world.capturePlayer());

		s._shuffle = () => ['B', 'A'];
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		s.world.restorePlayer(s.bundles.get('B'));
		const after = s.world.eval('KDGameData.KinkyDungeonLeashedPlayer');
		expect(after, 'B\'s own KDGameData.KinkyDungeonLeashedPlayer countdown (per-player state, not ' +
			'in KDGAMEDATA_WORLD_KEYS) must decay on B\'s own apply, exactly as it would in a 1-player ' +
			'session').toBeLessThan(5);
	}, BOOT_TIMEOUT);

	it('CONTROL: the enemy-side world loop (TorsoGrabCD) still decays once per round, not once per player', async () => {
		const solo = new SwapSession({ requiredPlayers: 1, seed: 'ue-torsograbcd-solo' });
		solo.join('A');
		await solo.ready();
		solo.world.eval('KinkyDungeonTorsoGrabCD = 5;');
		solo.submit('A', { kind: 'wait' });
		const soloAfter = solo.world.eval('KinkyDungeonTorsoGrabCD');
		const soloDecrement = 5 - soloAfter;
		expect(soloDecrement, 'control: the shared cooldown decays by a non-zero amount in one round').toBeGreaterThan(0);

		const s = new SwapSession({ requiredPlayers: 2, seed: 'ue-torsograbcd-duo' });
		s.join('A'); s.join('B');
		await s.ready();
		s.world.eval('KinkyDungeonTorsoGrabCD = 5;');
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const duoAfter = s.world.eval('KinkyDungeonTorsoGrabCD');
		const duoDecrement = 5 - duoAfter;
		expect(duoDecrement, 'the shared world cooldown must decay by the 1-player amount per round, not ' +
			'once per player — this world-scoped half of the same "else" branch must stay muted').toBe(soloDecrement);
	}, BOOT_TIMEOUT);
});

describe('KinkyDungeonSendEvent dispatchers: generic/listener mod-hook events already run per human', () => {
	it('a generic mod-hook event registered on B\'s own bundle fires on B\'s own apply, every round', async () => {
		const s = new SwapSession({ requiredPlayers: 2, seed: 'sendevent-generic-per-player' });
		s.join('A'); s.join('B');
		await s.ready();

		// KDEventMapGeneric is a per-player registry (turn-classification.js SLOT_SWAP_GLOBALS) — a
		// handler registered while B is swapped in belongs to B's own bundle, not the world.
		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval(`(function(){
			globalThis.__sendEventProbeCount = (globalThis.__sendEventProbeCount || 0);
			if (!KDEventMapGeneric["tick"]) KDEventMapGeneric["tick"] = {};
			KDEventMapGeneric["tick"]["turnRemainingProbe"] = function(){ globalThis.__sendEventProbeCount++; };
		})()`);
		s.bundles.set('B', s.world.capturePlayer());

		s._shuffle = () => ['B', 'A'];
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kind: 'wait' });

		// The hook is a bare script global (not swapped by restorePlayer/capturePlayer), so its own
		// counter is read straight off the world, without restoring B's bundle first.
		const count = s.world.eval('globalThis.__sendEventProbeCount || 0');
		expect(count, 'liveness/control: B\'s own generic-event hook, registered on B\'s own bundle, must ' +
			'actually fire on B\'s own apply (KinkyDungeonHandleGenericEvent is never muted and ' +
			'KDEventMapGeneric already follows the slot switch per-player) — already correct, no new ' +
			'wrap needed').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
