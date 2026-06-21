/**
 * Node-layer (Vitest) PoC + test for KD-089 — co-op targeted-spell casting headless.
 *
 * Feasibility question this proves: a TARGETED DAMAGING SPELL routed through the real
 * dispatcher (HeadlessHost.applyInput → KDSendInput('tryCastSpell', ...)) actually lands
 * damage on a summoned enemy in the headless world, WITHOUT a browser frame loop.
 *
 * Why it can work (from the KD-089 assessment): the cast→damage path is pure turn-loop
 * logic, NOT render-driven —
 *   KinkyDungeonCastSpell (Game/src/magic/KinkyDungeonMagic.ts:864)
 *     → KinkyDungeonLaunchBullet (Game/src/fight/KinkyDungeonFight.ts:3317) into KDMapData.Bullets
 *     → KinkyDungeonUpdateBullets / ...Collisions (KinkyDungeonFight.ts:1798/2186)
 *        called from KinkyDungeonAdvanceTime (KinkyDungeonGame.ts:3514/3520) — the turn loop
 *     → KDBulletHitEnemy → KinkyDungeonDamageEnemy → KDDamageEnemy mutates Enemy.hp.
 * Bullets live in KDMapData.Bullets (WORLD state), so they survive player swaps and resolve
 * on the next KinkyDungeonAdvanceTime the host already pumps (step()).
 *
 * The client→server contract is KD-088's already-wired one: {kdType:'tryCastSpell', data:{
 * tx,ty,spellname, player:{__kdEnt:'player'}}}; applyInput re-resolves {__kdEnt:'player'}
 * to THIS world's KinkyDungeonPlayerEntity before dispatch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost } = require('../../tools/mp-server/headless-host');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Read a world enemy's live state by id; null once it's removed (killed). */
function enemyById(h: any, id: number) {
	return h.eval(`(function(){
		var e = KDMapData.Entities.find(function(x){ return x.id === ${id | 0}; });
		return e ? { id: e.id, hp: e.hp, x: e.x, y: e.y } : null;
	})()`);
}

describe('Co-op targeted-spell casting headless (KD-089)', () => {
	let h: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'spell-cast' });
		h.boot();
		h.init({ seed: 'spell-cast-seed' });
		h.setServerMode('world');
		const t = h.findOpenTile();
		h.placePlayer(t.x, t.y);
		// Give the caster plenty of mana so the cast isn't resource-gated.
		h.eval('KinkyDungeonStatManaMax = 100; KinkyDungeonStatMana = 100;');
	}, BOOT_TIMEOUT);

	it('R1/R3: a targeted damaging spell reduces the shared enemy HP authoritatively', () => {
		const p = h.getPlayerPos();
		// Summon an enemy nearby, then park it adjacent to the caster so the cast is in-range
		// deterministically (independent of the Rat's wandering AI).
		const spawned = h.summonEnemy(p.x + 2, p.y, 'Rat', { rad: 4 });
		expect(spawned).toBeTruthy();
		h.moveAvatar(spawned.id, p.x + 1, p.y);
		const before = enemyById(h, spawned.id);
		expect(before).toBeTruthy();
		const hp0 = before.hp;

		// Cast Firecracker (inert AoE, manacost 4) at the enemy's tile via the REAL dispatcher.
		// player:{__kdEnt:'player'} → re-resolved to KinkyDungeonPlayerEntity inside applyInput.
		// No `enemy` field ⇒ player-faction cast path (manacost computed, beforeCast event).
		const res = h.applyInput('tryCastSpell', {
			tx: before.x,
			ty: before.y,
			spellname: 'Firecracker',
			player: { __kdEnt: 'player' },
		});
		expect(res).not.toBe('Fail');

		// Pump the turn loop so the launched bullet resolves (inert delay → detonates within
		// a tick or two). tryCastSpell already advanced 1 tick; a few more is belt-and-suspenders.
		let after = enemyById(h, spawned.id);
		for (let i = 0; i < 5 && after && after.hp >= hp0; i++) {
			h.step(1);
			after = enemyById(h, spawned.id);
		}

		// Either the enemy took damage, or it was killed outright (removed from Entities).
		const damaged = after == null || after.hp < hp0;
		expect(damaged).toBe(true);
	}, BOOT_TIMEOUT);
});

/**
 * Live-path coverage: the SAME action travels the production swap path. The client
 * forwards {kdType:'tryCastSpell', data} (KD-088 routing + {__kdEnt} sanitization);
 * SwapSession._toInput passes it straight through; _advanceTurn swaps the caster in,
 * runs it through the real dispatcher on the ONE authoritative world, swaps out. No new
 * wiring — this proves the cast lands and self-effects persist on the caster's bundle.
 */
describe('Co-op spell casting over the live swap path (KD-089)', () => {
	let s: any;

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'swap-spell-seed' });
		s.join('A');
		s.join('B'); // 2nd join starts the session (boots world, summons shared enemy)
	}, BOOT_TIMEOUT);

	it('R1/R3 (live): A casts a damaging spell that reduces the shared enemy authoritatively', () => {
		// Ensure the caster isn't mana-gated — bundle stats round-trip via restorePlayer.
		s.bundles.get('A').stats.mana = 100;
		s.bundles.get('A').stats.manaMax = 100;

		// Deterministically park the shared enemy adjacent to A's cast origin so the cast is
		// in-range regardless of the Rat's wandering AI (Firecracker range 3.99; AoE 1 tile
		// still covers a 1-tile enemy step before detonation).
		const pa0 = s.bundles.get('A').player;
		s.world.moveAvatar(s.enemyId, pa0.x + 1, pa0.y);
		const enemy0 = s.enemyView();
		expect(enemy0).toBeTruthy();
		const hp0 = enemy0.hp;

		// A casts Firecracker (inert AoE) at the enemy's tile; B waits → turn advances.
		s.submit('A', {
			kdType: 'tryCastSpell',
			data: { tx: enemy0.x, ty: enemy0.y, spellname: 'Firecracker', player: { __kdEnt: 'player' } },
		});
		s.submit('B', { kind: 'wait' });

		// Let the launched bullet resolve over a few lockstep turns.
		let enemy = s.enemyView();
		for (let i = 0; i < 5 && enemy && enemy.hp >= hp0; i++) {
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			enemy = s.enemyView();
		}
		const damaged = enemy == null || enemy.hp < hp0;
		expect(damaged).toBe(true);

		// R3 (shared visibility): each client's composed snapshot agrees with the ONE
		// authoritative world — both see the enemy damaged, or both see it gone.
		const enemyInSnap = (cid: string) => {
			const ents = (s.snapshotFor(cid).map && s.snapshotFor(cid).map.Entities) || [];
			return ents.find((e: any) => e.id === s.enemyId) || null;
		};
		const world = s.enemyView();
		const a = enemyInSnap('A');
		const b = enemyInSnap('B');
		if (world == null) {
			expect(a).toBeNull();
			expect(b).toBeNull();
		} else {
			expect(a && a.hp).toBe(world.hp);
			expect(b && b.hp).toBe(world.hp);
		}
	}, BOOT_TIMEOUT);

	it('R4 (live): a self-targeted buff persists on the caster across swaps, and B is unaffected', () => {
		s.bundles.get('A').stats.mana = 100;
		s.bundles.get('A').stats.manaMax = 100;

		// Self-cast StoneSkin: target = A's own bundle position (selfCast in KinkyDungeonCastSpell).
		const pa = s.bundles.get('A').player;
		s.submit('A', {
			kdType: 'tryCastSpell',
			data: { tx: pa.x, ty: pa.y, spellname: 'StoneSkin', player: { __kdEnt: 'player' } },
		});
		s.submit('B', { kind: 'wait' });

		const hasStoneSkin = (id: string) =>
			JSON.stringify(s.bundles.get(id).buffs || {}).indexOf('StoneSkin') >= 0;

		// Buff is on A's bundle right after the cast turn (captured on swap-out)...
		expect(hasStoneSkin('A')).toBe(true);
		// ...and B never received it (per-player state isolation).
		expect(hasStoneSkin('B')).toBe(false);

		// ...and it SURVIVES a subsequent swap (A waits, swapped out then in again).
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(hasStoneSkin('A')).toBe(true);
	}, BOOT_TIMEOUT);
});
