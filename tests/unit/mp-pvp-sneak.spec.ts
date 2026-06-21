/**
 * Node-layer (Vitest) tests for KD-095 (KD-073d) — co-op → PvP transition via sneak-attack.
 *
 * The stock way to attack a friendly NPC is the `doaggro` input ("AggroSneak"). Aimed at a peer's
 * avatar it (a) starts PvP for that pair and (b) applies the first hit; afterwards KD-094's
 * peers-as-Enemy + doattack routing take over. Nothing new in mechanics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-sneak-seed' });
	s.join('A');
	s.join('B');
	return s;
}

/** A sneak-attacks (doaggro) B's avatar this turn (B waits); returns A's resolved result. */
function sneakTurn(s: any) {
	const bEid = s.avatars.get('B');
	const bEnt = s.world.listEntities().find((e: any) => e.id === bEid);
	s.submit('A', { kdType: 'doaggro', data: { tx: bEnt.x, ty: bEnt.y, id: bEid, unaware: true } });
	const r = s.submit('B', { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === 'A').result;
}

describe('Co-op → PvP sneak-attack transition (KD-095)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('R1/R2: a sneak-attack (doaggro) on a peer in co-op starts PvP and lands the hit', () => {
		expect(s._isPvP('A', 'B')).toBe(false); // co-op to begin with
		const aStatsBefore = JSON.stringify(s.bundles.get('A').stats);

		const r = sneakTurn(s);

		expect(r.applied).toBe(true);                                   // the hit landed...
		expect(JSON.stringify(r.after)).not.toBe(JSON.stringify(r.before)); // ...B's vitals changed
		expect(s._isPvP('A', 'B')).toBe(true);                          // ...and the pair is now PvP
		expect(JSON.stringify(s.bundles.get('A').stats)).toBe(aStatsBefore); // A unaffected
	}, BOOT_TIMEOUT);

	it('after the transition, a plain doattack at the peer routes as PvP (KD-094)', () => {
		sneakTurn(s); // A→B sneak: pair is now PvP
		expect(s._isPvP('A', 'B')).toBe(true);
		// a subsequent stock doattack on B is recognized as a PvP target
		const bEid = s.avatars.get('B');
		expect(s._pvpTargetOf('A', { kdType: 'doattack', data: { id: bEid } }, 'doattack', { id: bEid })).toBe('B');
	}, BOOT_TIMEOUT);
});
