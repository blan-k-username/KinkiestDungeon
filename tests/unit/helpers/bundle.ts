/**
 * KDM-161: reading and poking a player-state bundle in tests.
 *
 * A bundle used to have a hand-written shape (`bundle.stats.mana`, `bundle.player.x`, `bundle.buffs`)
 * because `capturePlayer` named ~20 globals by hand. That list is deleted: a bundle is now
 * `{v, gameData, globals}`, where `globals` holds every global that DIVERGED from the post-init
 * baseline, keyed by its real bundle name.
 *
 * Tests go through here rather than reaching into `bundle.globals` directly, so the next change to the
 * bundle format is one edit instead of five — and so the divergence rule ("absent means: never moved
 * from the default") fails loudly with the global's name instead of as `undefined.mana`.
 */

/** A bundle's value for a bundle global. Throws — never returns undefined — if it is not carried. */
export function bundleGet(bundle: any, name: string): any {
	const g = bundle && bundle.globals;
	if (!g || !Object.prototype.hasOwnProperty.call(g, name)) {
		throw new Error(
			`[bundle] ${name} is not in this bundle. Under KDM-161 a global is carried only once it ` +
			'DIVERGES from the post-init baseline, so this means the player never changed it. Drive the ' +
			'state first, or use bundleSet() to force a value.');
	}
	return g[name];
}

/**
 * Force a bundle global. Works whether or not the player had diverged: restore assigns everything
 * present in `globals`, so writing here is enough to make the value real on the next swap-in.
 */
export function bundleSet(bundle: any, name: string, value: any): void {
	if (!bundle.globals) bundle.globals = {};
	bundle.globals[name] = value;
}

/** Give the player enough mana that a cast is not mana-gated. */
export function bundleGiveMana(bundle: any, amount = 100): void {
	bundleSet(bundle, 'KinkyDungeonStatMana', amount);
	bundleSet(bundle, 'KinkyDungeonStatManaMax', amount);
}

/** The player entity as this bundle holds it (mutate it to move the player authoritatively). */
export function bundlePlayer(bundle: any): any {
	return bundleGet(bundle, 'KinkyDungeonPlayerEntity');
}

/**
 * A stable digest of the player's vitals, for "A is unaffected by X" assertions. Reads only the
 * globals actually carried — an absent stat is one the player never moved, which compares equal for
 * the same reason it is absent.
 */
export function bundleStats(bundle: any): string {
	const g = (bundle && bundle.globals) || {};
	const keys = Object.keys(g).filter((k) => k.startsWith('KinkyDungeonStat')).sort();
	return JSON.stringify(keys.map((k) => [k, g[k]]));
}

/** Whether a named buff is present on this bundle's player buffs. */
export function bundleHasBuff(bundle: any, buffName: string): boolean {
	const g = (bundle && bundle.globals) || {};
	return JSON.stringify(g.KinkyDungeonPlayerBuffs || {}).indexOf(buffName) >= 0;
}
