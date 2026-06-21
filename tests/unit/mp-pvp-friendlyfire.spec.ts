/**
 * Node-layer (Vitest) tests for KD-096 — co-op AOE friendly-fire.
 *
 * Incidental splash: A's AOE spell whose footprint covers a partner B splashes B's bundle, even
 * without intentional PvP (a separate `friendlyFire` switch). Approximate: Chebyshev radius
 * (spell.aoe) around the cast target tile, routed to the covered peer's bundle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const AOE_SPELL = 'Firecracker'; // tags: aoe; aoe:1, power:3.5

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-ff-seed' });
	s.join('A');
	s.join('B');
	for (const id of ['A', 'B']) { s.bundles.get(id).stats.mana = 100; s.bundles.get(id).stats.manaMax = 100; }
	return s;
}

/** A casts the AOE spell centered on B's avatar tile; B waits. Returns A's result. */
function aoeOnB(s: any) {
	const bEnt = s.world.listEntities().find((e: any) => e.id === s.avatars.get('B'));
	s.submit('A', { kdType: 'tryCastSpell', data: { tx: bEnt.x, ty: bEnt.y, spellname: AOE_SPELL, player: { __kdEnt: 'player' } } });
	const r = s.submit('B', { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === 'A').result;
}

describe('Co-op AOE friendly-fire (KD-096)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('friendlyFire ON: A’s AOE over B splashes B’s bundle', () => {
		s.setFriendlyFire(true);
		const r = aoeOnB(s);
		expect(r && r.friendlyFire && r.friendlyFire.length).toBeGreaterThan(0);
		const splash = r.friendlyFire.find((x: any) => x.id === 'B');
		expect(splash).toBeTruthy();
		expect(JSON.stringify(splash.after)).not.toBe(JSON.stringify(splash.before)); // B took splash
	}, BOOT_TIMEOUT);

	it('friendlyFire OFF (default): A’s AOE does NOT splash B', () => {
		const r = aoeOnB(s);
		// result is the plain cast result (string), with no friendlyFire routing
		expect(r == null || r.friendlyFire === undefined).toBe(true);
	}, BOOT_TIMEOUT);
});
