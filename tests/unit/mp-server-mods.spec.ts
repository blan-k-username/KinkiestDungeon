/**
 * Node-layer (Vitest) tests for KD-074 — server-side mod support on the live swap model.
 *
 * The swap model runs ONE authoritative world engine (players are state bundles), so a mod loads
 * once into that world — "all instances agree" is automatic. Same eval path as the browser loader
 * (Scripts/KDMods.ts). Proves: the real Mods/example_enemy mod registers AngrySkeleton server-side
 * and the new enemy is summonable; and a function-reassign mod loaded after start takes effect.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const BOOT_TIMEOUT = 240_000;
const MOD_CODE = fs.readFileSync(path.join(__dirname, '..', '..', 'Mods', 'example_enemy', 'init.ks'), 'utf8');
const MOD_ENEMY = 'AngrySkeleton';

describe('Server-side mods on the swap model (KD-074)', () => {
	it('a mod passed at construction registers its enemy in the world; it is summonable', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'mods-seed', mods: [MOD_CODE] });
		s.join('A');
		s.join('B'); // starts the world → loads the mod

		// the mod's enemy now resolves in the authoritative world...
		expect(s.getEnemyByName(MOD_ENEMY)).toEqual({ name: MOD_ENEMY });
		// ...with the mod's full def (not just the name), proving the push took real effect...
		const def = s.world.eval(`(function(){ var e = KinkyDungeonGetEnemyByName('AngrySkeleton'); return e ? { maxhp: e.maxhp, AI: e.AI, attack: e.attack } : null; })()`);
		expect(def).toEqual({ maxhp: 5, AI: 'hunt', attack: 'MeleeBind' });
		// ...and the mod's addTextKey also registered (its translation resolves).
		expect(s.world.eval(`(typeof TextGet === 'function') ? TextGet('NameAngrySkeleton') : null`)).toBe('Angry Skeleton');
	}, BOOT_TIMEOUT);

	it('without the mod, the modded enemy is absent (control)', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'mods-seed' });
		s.join('A');
		s.join('B');
		expect(s.getEnemyByName(MOD_ENEMY)).toBeNull();
	}, BOOT_TIMEOUT);

	it('a function-reassign mod loaded AFTER start takes effect (KDMods-style)', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'mods-seed-2' });
		s.join('A');
		s.join('B');
		// stock behavior, then a mod reassigns the global function (as Mods/example_unlimitedbed does)
		s.loadMod('KDCanSleep = function(){ return true; };');
		expect(s.world.eval('KDCanSleep()')).toBe(true);
	}, BOOT_TIMEOUT);
});
