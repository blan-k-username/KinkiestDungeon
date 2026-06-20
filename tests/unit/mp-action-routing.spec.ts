/**
 * Node-layer (Vitest) tests for the richer routed action surface — KD-088.
 *
 * The swap model replays ANY client action {kdType,data} through KD's REAL dispatcher
 * on the authoritative world (HeadlessHost.applyInput). These prove:
 *  - a representative self-action applies authoritatively (crouch toggles game state),
 *  - an item/weapon action applies (switchWeapon changes the equipped weapon),
 *  - the entity re-resolution: client placeholders {__kdEnt:id} / {__kdEnt:'player'}
 *    are resolved to THIS world's authoritative entities before dispatch (the
 *    mechanism targeted spells/interactions rely on).
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

describe('Richer routed actions via the real dispatcher (KD-088)', () => {
	let h: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'action-routing' });
		h.boot();
		h.init({ seed: 'action-routing-seed' });
		h.setServerMode('world');
		const t = h.findOpenTile();
		h.placePlayer(t.x, t.y);
	}, BOOT_TIMEOUT);

	it('applies a self-action authoritatively: crouch toggles game state', () => {
		const before = h.eval('!!KDGameData.Crouch');
		h.applyInput('crouch', {});
		const after = h.eval('!!KDGameData.Crouch');
		expect(after).toBe(!before);
		// and back
		h.applyInput('crouch', {});
		expect(h.eval('!!KDGameData.Crouch')).toBe(before);
	}, BOOT_TIMEOUT);

	it('applies an item/weapon action: switchWeapon changes the equipped weapon', () => {
		// pick a valid weapon different from the current one
		const target = h.eval(`(function(){
			var cur = (typeof KinkyDungeonPlayerWeapon !== 'undefined') ? KinkyDungeonPlayerWeapon : 'Unarmed';
			var names = Object.keys(KinkyDungeonWeapons || {});
			var other = names.find(function(n){ return n !== cur; });
			return other || 'Unarmed';
		})()`);
		h.applyInput('switchWeapon', { weapon: target, noOld: true });
		expect(h.eval('KinkyDungeonPlayerWeapon')).toBe(target);
	}, BOOT_TIMEOUT);

	it('re-resolves client entity placeholders to the world\'s authoritative entities', () => {
		// a shared enemy whose id the "client" would reference
		const enemy = h.summonEnemy(h.getPlayerPos().x + 2, h.getPlayerPos().y, 'Rat', { rad: 6 });
		expect(enemy && enemy.id).toBeTruthy();
		// install a probe input type that records the data the dispatcher receives
		h.eval(`KDInputTypes['__kdProbe'] = function(d){ globalThis.__kdProbeData = d; return 'ok'; };`);
		// applyInput with player + by-id + nested/array placeholders (as sanitizeInputData emits)
		h.applyInput('__kdProbe', {
			me: { __kdEnt: 'player' },
			foe: { __kdEnt: enemy.id },
			nested: { list: [{ __kdEnt: 'player' }, { __kdEnt: enemy.id }] },
			scalar: 7,
		});
		const check = h.eval(`(function(){
			var d = globalThis.__kdProbeData || {};
			return {
				meIsPlayer: d.me === KinkyDungeonPlayerEntity,
				foeId: d.foe && d.foe.id,
				listPlayer: d.nested && d.nested.list && d.nested.list[0] === KinkyDungeonPlayerEntity,
				listFoeId: d.nested && d.nested.list && d.nested.list[1] && d.nested.list[1].id,
				scalar: d.scalar,
			};
		})()`);
		expect(check.meIsPlayer).toBe(true);          // {__kdEnt:'player'} → KinkyDungeonPlayerEntity
		expect(check.foeId).toBe(enemy.id);            // {__kdEnt:id} → KinkyDungeonFindID(id)
		expect(check.listPlayer).toBe(true);           // resolves inside nested arrays
		expect(check.listFoeId).toBe(enemy.id);
		expect(check.scalar).toBe(7);                  // non-placeholder data untouched
	}, BOOT_TIMEOUT);
});
