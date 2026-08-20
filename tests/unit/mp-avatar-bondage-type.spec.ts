/**
 * UAT crash — "Cannot read properties of undefined (reading 'priority')".
 *
 * Reported from a real co-op session on client B:
 *
 *   TypeError: Cannot read properties of undefined (reading 'priority')
 *       at KDPredictStruggle (out/main.js:46791)   // the Object.entries(...).sort() comparator
 *       at KinkyDungeonDrawEnemiesHP
 *       at KinkyDungeonDrawGame
 *
 * ROOT CAUSE. `HeadlessHost.setAvatarBondage` armed a peer avatar with
 * `e.specialBoundLevel = { MPPeer: amount }`. `MPPeer` is NOT a registered bondage type, and KD
 * indexes `KDSpecialBondage[key]` UNGUARDED in two draw-path places
 * (`KinkyDungeonEnemies.ts:2193` and the `KDPredictStruggle` sort at `:8614`). So the very first
 * frame that drew a bound peer's HP bar took the whole game down.
 *
 * The rule this locks in: `specialBoundLevel` is a KEYED channel, not a free-form bag. Anything we
 * write into it must be a type the game actually registered — inventing a key is inventing a
 * `KDSpecialBondage` entry that does not exist.
 *
 * Asserted at BOTH layers, because they are different objects and only the wire connects them:
 * the server world (where we write it) and the snapshot entity (where the crash happened).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('peer-avatar bondage must use a REGISTERED KDSpecialBondage type', () => {
	it('does not crash KD\'s own draw-path struggle prediction, on the world OR on the wire', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'bondage-type', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		const eid = s.avatars.get('B');

		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		s.world.setAvatarBondage(eid, 5);

		// PRECONDITION — the avatar really carries special bondage, so a green below cannot come from
		// an empty `specialBoundLevel` short-circuiting the crashing sort.
		const world = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
			var sbl = (e && e.specialBoundLevel) || {};
			return { keys: Object.keys(sbl), boundLevel: (e && e.boundLevel) || 0,
				unregistered: Object.keys(sbl).filter(function(k){ return !KDSpecialBondage[k]; }) };
		})()`);
		expect(world.keys.length, 'precondition: the avatar must carry special bondage').toBeGreaterThan(0);
		expect(world.boundLevel, 'precondition: the avatar must be bound').toBeGreaterThan(0);

		// eslint-disable-next-line no-console
		console.log('\navatar specialBoundLevel: ' + JSON.stringify(world) + '\n');

		expect(world.unregistered,
			'every specialBoundLevel key must exist in KDSpecialBondage — KD indexes it unguarded')
			.toEqual([]);

		// THE DECIDING LAYER. Run the exact function that threw, in the game's own realm, first on the
		// world entity and then on the entity the CLIENT would hold (the crash was client-side).
		const snap = s.snapshotFor('A');
		const ent = ((snap.map && snap.map.Entities) || []).find((e: any) => e.id === eid);
		expect(ent, 'precondition: the peer avatar must be in the snapshot').toBeTruthy();
		expect(Object.keys((ent as any).specialBoundLevel || {}).length,
			'precondition: the wire must carry the special bondage').toBeGreaterThan(0);

		const predict = s.world.eval(`(function(){
			function attempt(e) {
				try { KDPredictStruggle(e, 1, 1, 0.1); return 'ok'; }
				catch (err) { return String(err && err.message || err); }
			}
			var w = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
			return { world: attempt(w), wire: attempt(${JSON.stringify(ent)}) };
		})()`);
		expect(predict.world, 'KDPredictStruggle on the world avatar').toBe('ok');
		expect(predict.wire, 'KDPredictStruggle on the SNAPSHOT avatar (this is what crashed)').toBe('ok');
	}, BOOT_TIMEOUT);
});
