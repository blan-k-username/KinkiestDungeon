/**
 * KDM-199 — the peer avatar must be ARMED FROM the peer's real state, not reset to a placeholder.
 *
 * A peer avatar is a STAND-IN for another player. Each turn `_armPeerEnemies` used to reset it to a
 * placeholder (hp = FULL, stun = 0, boundLevel = 0) and then patch the consequences with an invented
 * rule (`will <= 0 ⇒ ent.stun = 6`, written both into the world and onto the wire). That invention
 * exists only because the proxy first deletes the state KD's own gate reads.
 *
 * KD's gate (`KDCanApplyBondage`, `KinkyDungeonEnemies.ts:11264`):
 *     KinkyDungeonIsDisabled(t) || (!t.player && t.vulnerable && t.hp <= 0.5*t.Enemy.maxhp) || KDWillingBondage(...)
 * with `KinkyDungeonIsDisabled = IsStunned || KDBoundEffects > 3`.
 *
 * MEASURED (KDM-199 probes):
 *  - `KDBoundEffects` returns 0 unless `boundLevel > 0` (`:4228` short-circuit) — hp alone can NEVER
 *    make a peer disabled, so a faithful Will→hp mapping is necessary but not sufficient.
 *  - `specialBoundLevel` is the game's own ITEM-FREE bondage channel and survives `KDResyncBondage`
 *    (1→1, 5→5, 60→60, 80→80), so a mirrored value is not wiped — and it needs no restraint items,
 *    leaving the KD-101 binding-slot crash fix untouched.
 *  - hp 1/100 + boundLevel 5 ⇒ KDBoundEffects 4 ⇒ disabled ⇒ tie-able, exactly as for an NPC.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

function idleTurn(s: any) {
	s.submit('A', { kind: 'wait' });
	s.submit('B', { kind: 'wait' });
}

function setWill(s: any, id: string, will: number) {
	s.world.restorePlayer(s.bundles.get(id));
	s.world.setWill(will);
	s.bundles.set(id, s.world.capturePlayer());
	s.vitalsOf.set(id, s.world.getVitals());
}

/**
 * KD's OWN gate, evaluated on the SNAPSHOT entity — the object the browser actually holds.
 *
 * Evaluating against the SERVER world object is what made three earlier fixes look correct while
 * changing nothing in play: the two are different objects and only the wire connects them. Always
 * assert at the layer that decides.
 */
function canTie(s: any, victim: string, actor: string) {
	// Arm first, then snapshot — the real order: the avatar is armed during the actor's turn and the
	// snapshot is composed afterwards.
	s.world.restorePlayer(s.bundles.get(actor));
	s._armPeerEnemies(actor);
	const snap = s.snapshotFor(actor);
	const ent = ((snap.map && snap.map.Entities) || []).find((e: any) => e.id === s.avatars.get(victim));
	if (!ent) return { missing: true } as any;
	s.world.restorePlayer(s.bundles.get(actor));
	return s.world.eval('(function(){ var e = ' + JSON.stringify(ent) + ';'
		+ ' return { hp: e.hp, maxhp: (e.Enemy && e.Enemy.maxhp) || 0, boundLevel: e.boundLevel || 0,'
		+ '   vulnerable: e.vulnerable || 0,'
		+ "   can: (typeof KDCanApplyBondage === \"function\" && typeof KDPlayer === \"function\")"
		+ '     ? !!KDCanApplyBondage(e, KDPlayer()) : null }; })()');
}

describe('KDM-199 — peer avatar arming', () => {

	/**
	 * CHARACTERISATION — landed BEFORE the change, because this is the mechanism KDM-156 was about.
	 * hp used to be a MEASUREMENT (ARM_HP - hp = damage dealt); re-reading a stale delta PINNED a
	 * downed player at 0 Will and SILENTLY WIPED healing. Putting Will back INTO hp is the move that
	 * could resurrect it, so pin the real signature first.
	 *
	 * NOT asserted: "Will never drops while idle". Measured on BOTH sides of this change — the world
	 * drains a little Will on its own (turn 3 pre-change, turn 7 post-change, same seed), so that
	 * assertion would fail for reasons unrelated to KDM-156 and would have been a false alarm.
	 * What IS asserted is the bug itself: healing must stick, and a healed peer must not be re-pinned.
	 */
	it('CHARACTERISATION: healing a peer must STICK — KDM-156 must not return', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'arming-char', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();

		// Drive B to the floor, as a peer who has been beaten down.
		setWill(s, 'B', 0);
		idleTurn(s);
		expect(s.vitalsFor('B').will, 'precondition: B really is at the floor').toBeLessThanOrEqual(0);

		// Heal them. Under KDM-156 the stale hp delta was re-charged every turn, so this was wiped and
		// the player stayed pinned at 0 forever.
		setWill(s, 'B', 7);
		for (let i = 0; i < 6; i++) idleTurn(s);

		const after = s.vitalsFor('B').will;
		expect(after, 'healing must not be silently wiped by a re-read damage delta')
			.toBeGreaterThan(1);
	}, BOOT_TIMEOUT);

	it('arms the avatar hp from the peer\'s real Will, not to full', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'arming-hp', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();

		const healthy = canTie(s, 'B', 'A');
		expect(healthy.hp, 'a peer at full Will reads as full hp').toBe(healthy.maxhp);

		setWill(s, 'B', 0.5);   // ~5% of a 10 WillMax
		const worn = canTie(s, 'B', 'A');
		expect(worn.hp, 'a worn-down peer must read as DAMAGED, not pristine').toBeLessThan(worn.maxhp);
		expect(worn.hp, 'hp must track Will, so well under half').toBeLessThan(0.5 * worn.maxhp);
		expect(worn.hp, 'but never 0 — a hp=0 entity reads as dead and untargetable').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('mirrors the peer\'s REAL bondage, and that is what makes them tie-able', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'arming-bondage', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();

		// Worn down but UNBOUND: KD does not consider that tie-able (KDBoundEffects short-circuits on
		// boundLevel), and neither may we. This is the assertion the invented rule used to violate.
		setWill(s, 'B', 0);
		const unbound = canTie(s, 'B', 'A');
		expect(unbound.boundLevel, 'an unbound peer has no bondage to mirror').toBe(0);
		// KDM-200: whether a defeated peer is TIE-ABLE is asserted in its own test below. This test is	
		// about the MIRRORING only — that the peer's real bondage reaches the avatar at all.

		// Now give B REAL restraints, as a peer who has actually been tied would have.
		s.world.restorePlayer(s.bundles.get('B'));
		const added = s.world.addRestraint('HingedCuffs');
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', s.world.getVitals());
		expect(added && added.count, 'precondition: B must really be wearing a restraint')
			.toBeGreaterThan(0);

		const bound = canTie(s, 'B', 'A');
		expect(bound.boundLevel, "the peer's real bondage must be mirrored onto the avatar")
			.toBeGreaterThan(0);
		expect(bound.can, 'a worn-down, genuinely bound peer is tie-able by KD\'s OWN gate').toBe(true);
	}, BOOT_TIMEOUT);

	/**
	 * KDM-200 — THE PRODUCT REQUIREMENT: a defeated opponent can be tied through the stock submenu.
	 *
	 * Owner, after three rounds of measurement: "i want this sub-menu works. the player should be able
	 * to tie up the opponent as it wish by this flexible feature."
	 *
	 * KD subdues an NPC via stun/freeze or accumulated bondage, which arrive from weapons and spells.
	 * Measured (KDM-199): damage alone never subdues anything — `KinkyDungeonIsStunned` reads only
	 * `stun`/`freeze`, and the `bindStun` damage applies affects struggling only. A real Rat beaten to
	 * 5% hp is equally un-tie-able. So between two PLAYERS the only alternatives were dictating the
	 * loadout or declaring one co-op rule; the rule is declared.
	 *
	 * It is the smallest one that works: a defeated peer gets the game's own per-turn exposure flag,
	 * and KD's OWN branch decides — `target.vulnerable && target.hp <= 0.5 * maxhp` — with the hp half
	 * supplied by the peer's real Will. Nothing overrides KDCanApplyBondage.
	 *
	 * Asserted through `KDCanApplyBondage` itself, never a re-implementation of its condition.
	 */
	it('a DEFEATED opponent is tie-able through KD\'s own gate; a healthy one is not', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'arming-defeated', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();

		// Healthy peer — must NOT be tie-able, or the rule has quietly become "always".
		expect(canTie(s, 'B', 'A').can, 'a healthy opponent must not be tie-able').toBe(false);

		// Beat them down, exactly as the owner does before opening the submenu.
		setWill(s, 'B', 0);
		idleTurn(s);
		expect(s.isDefeated('B'), 'precondition: B must really be defeated').toBe(true);

		const down = canTie(s, 'B', 'A');
		expect(down.hp, 'a defeated peer reads as all but dead, from their real Will')
			.toBeLessThan(0.5 * down.maxhp);
		expect(down.can, "a defeated opponent MUST be tie-able — this is the co-op feature").toBe(true);

		// …and it lapses on its own: heal them and the window closes, with no bookkeeping of ours.
		setWill(s, 'B', s.vitalsFor('B').willMax || 10);
		idleTurn(s);
		expect(canTie(s, 'B', 'A').can, 'a recovered opponent must stop being tie-able').toBe(false);
	}, BOOT_TIMEOUT);
});
