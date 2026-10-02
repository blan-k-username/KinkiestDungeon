/**
 * Co-op companions: separate teams by owner, hostility follows the players' own peace/war, fully
 * reversible.
 *
 * Requirements (owner):
 *  - A companion follows/obeys/helps its OWNER only -- never merged into the other player's party, and
 *    never engaged with whoever it happens to stand closest to.
 *  - PEACE: both players' companions help against a shared monster; neither companion ever attacks
 *    either player or the other player's companion.
 *  - WAR (PvP): A's companion attacks B and B's companions, and vice versa -- separate teams.
 *  - WAR -> PEACE: fully friendly again, no residual hostility (faction, `hostile`, target lock), and
 *    the cycle is repeatable.
 *
 * Imports the harness under tools/mp-server/** only -- never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
import { freeNeighbour } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

/** Drop a real entity via KD's own `KDAddNewEntity` -- see mp-companion-avatar-immunity.spec.ts for why
 *  `KinkyDungeonSummonEnemy` cannot be used this early in a headless session. */
function spawnEntityDirect(s: any, x: number, y: number, type: string): { id: number, name: string } {
	const before = s.world.eval('KDMapData.Entities.length');
	const out = s.world.eval(`(function(){
		var Enemy = KinkyDungeonGetEnemyByName(${JSON.stringify(type)});
		if (!Enemy) return null;
		var e = { summoned: true, Enemy: Enemy, id: KinkyDungeonGetEnemyID(),
			x: ${x | 0}, y: ${y | 0}, hp: Enemy.startinghp || Enemy.maxhp,
			movePoints: 0, attackPoints: 0 };
		e = KDAddNewEntity(e);
		KDUpdateEnemyCache = true;
		return { id: e.id, name: e.Enemy && e.Enemy.name };
	})()`);
	const after = s.world.eval('KDMapData.Entities.length');
	if (!out || after !== before + 1) throw new Error(`setup invalid: failed to spawn ${type} at (${x},${y})`);
	return out;
}

/**
 * Recruit a real ally near `ownerCid` via KD's own `KDAddToParty`.
 *
 * `KDGameData.Party` is a PER-PLAYER field (not a world one), so "recruit for A" only means something
 * if A is actually the one in the player slot while `KDAddToParty` runs -- otherwise the entry is
 * written into whichever player's bundle happens to be live at that moment (the one `_seatPlayer` left
 * live last), not `ownerCid`. Swap `ownerCid` in first and re-capture their bundle afterward, the same
 * `restorePlayer(bundle)` -> mutate -> `bundles.set(cid, capturePlayer())` idiom
 * mp-coop-slot-swap-human-context.spec.ts's `moveClientTo` uses for any other player-scoped setup.
 */
function recruitCompanion(s: any, ownerCid: string, type: string): number {
	s.world.restorePlayer(s.bundles.get(ownerCid));
	const pos = s.world.getPlayerPos();
	const summoned = spawnEntityDirect(s, pos.x, pos.y, type);
	const ok = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${summoned.id}; });
		if (!e || typeof KDAddToParty !== 'function') return false;
		return !!KDAddToParty(e);
	})()`);
	if (!ok) throw new Error('setup invalid: KDAddToParty did not accept the summoned companion');
	s.bundles.set(ownerCid, s.world.capturePlayer());
	return summoned.id;
}

function factionOf(s: any, entityId: number): string | null {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? ((typeof KDGetFaction === 'function') ? KDGetFaction(e) : e.faction) : null;
	})()`);
}

function rawFieldsOf(s: any, entityId: number): { hostile: number, faction: string | undefined, factionorig: string | undefined } {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? { hostile: e.hostile || 0, faction: e.faction, factionorig: e.factionorig } : null;
	})()`);
}

function hpOf(s: any, entityId: number): { hp: number, maxhp: number } | null {
	const c = s.world.getEntityCombat(entityId);
	return c ? { hp: c.hp, maxhp: c.maxhp } : null;
}

function posOfEntity(s: any, entityId: number): { x: number, y: number } | null {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? { x: e.x, y: e.y } : null;
	})()`);
}

/** Move `entityId` onto a free tile next to `nearCid`'s avatar and lock it onto that avatar (`gx`/`gy`)
 *  -- the same recipe mp-companion-avatar-immunity.spec.ts uses to reach an ordinary, already-settled
 *  follower state without a real line-of-sight corridor. */
function pinNextTo(s: any, nearCid: string, entityId: number) {
	const p = s.posOf(nearCid);
	const already = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? (Math.max(Math.abs(e.x - ${p.x}), Math.abs(e.y - ${p.y})) === 1) : false;
	})()`);
	if (!already) {
		const nb = freeNeighbour(s, nearCid);
		if (!nb) throw new Error(`setup invalid: no free tile beside ${nearCid}`);
		s.world.moveAvatar(entityId, nb.x, nb.y);
	}
	const target = s.posOf(nearCid);
	s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		if (e) { e.aware = true; e.gx = ${target.x}; e.gy = ${target.y}; }
		KDUpdateEnemyCache = true;
	})()`);
}

/**
 * Move a non-avatar entity onto a free tile next to `nearCid`, WITHOUT forcing `gx`/`gy`/`aware` the
 * way `pinNextTo` does. `pinNextTo`'s lock exists to work around the avatar's `lowpriority` leash check
 * (see its own doc comment) -- it simulates an ALREADY-committed, mid-attack lock, which is appropriate
 * for proving a hostile entity's engagement survives a reposition, but WRONG for a "does this friendly
 * entity choose to attack" safety check: forcing `gx`/`gy` onto a real human's own tile can read as "I
 * am already attacking what's standing there" regardless of the fresh hostility decision for that
 * round, which would make a safety assertion pass or fail for the wrong reason. A real human target is
 * never `lowpriority`, so the leash workaround is not needed here anyway -- plain adjacency is enough
 * to give the entity's own AI a genuine, un-forced chance to decide every round.
 */
function placeAdjacentTo(s: any, nearCid: string, entityId: number) {
	const p = s.posOf(nearCid);
	const already = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${entityId}; });
		return e ? (Math.max(Math.abs(e.x - ${p.x}), Math.abs(e.y - ${p.y})) === 1) : false;
	})()`);
	if (!already) {
		const nb = freeNeighbour(s, nearCid);
		if (!nb) throw new Error(`setup invalid: no free tile beside ${nearCid}`);
		s.world.moveAvatar(entityId, nb.x, nb.y);
	}
}

/** Park `mobileCid`'s avatar onto a free tile next to `anchorCid` -- the ordinary co-op case of two
 *  players standing together. */
function standTogether(s: any, mobileCid: string, anchorCid: string) {
	const a = s.posOf(anchorCid), m = s.posOf(mobileCid);
	if (Math.max(Math.abs(a.x - m.x), Math.abs(a.y - m.y)) === 1) return;
	const nb = freeNeighbour(s, anchorCid);
	if (!nb) throw new Error(`setup invalid: no free tile beside ${anchorCid}`);
	s.world.moveAvatar(s.avatars.get(mobileCid), nb.x, nb.y);
}

describe('co-op companions: separate teams by owner', () => {
	it("step 1: a companion always engages its OWNER, even standing next to the other player", () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-owner-slot', enemyType: null });
		s.join('A'); s.join('B');

		const companionId = recruitCompanion(s, 'A', 'WitchEarth');
		expect(factionOf(s, companionId), 'setup: the companion must really be Player-faction').toBe('Player');

		// Move B well clear of A FIRST, or the companion (spawned ON A's own tile by `recruitCompanion`)
		// would already be within one tile of a B standing right next to A -- a degenerate setup that
		// cannot tell "owned by A" apart from "merely closer to A". Then pin the companion next to B
		// specifically -- the suspected-bug scenario: nearest-by-position would pick B, but ownership
		// must win regardless of distance.
		const aPos = s.posOf('A');
		s.world.moveAvatar(s.avatars.get('B'), aPos.x + 5, aPos.y);
		pinNextTo(s, 'B', companionId);
		const dAtoCompanion = (() => {
			const p = posOfEntity(s, companionId)!;
			return Math.max(Math.abs(p.x - aPos.x), Math.abs(p.y - aPos.y));
		})();
		expect(dAtoCompanion, 'setup: the companion must genuinely be FARTHER from A than from B')
			.toBeGreaterThan(1);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		const log = s.world.slotChoiceLog ? s.world.slotChoiceLog() : {};
		expect(log[companionId],
			"the engine's own per-round engagement choice for the companion must be its owner, A, " +
			"never B even though the companion is standing next to B").toBe('A');
	}, BOOT_TIMEOUT);

	it('step 5 control: each player\'s party stays private -- never merged', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-party-separate', enemyType: null });
		s.join('A'); s.join('B');

		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		const bCompanion = recruitCompanion(s, 'B', 'WitchFlame');
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		const owners = s._computeCompanionOwners();
		expect(owners[aCompanion], "A's own companion must be owned by A").toBe('A');
		expect(owners[bCompanion], "B's own companion must be owned by B").toBe('B');

		const partyA: any[] = s.bundles.get('A').gameData.Party || [];
		const partyB: any[] = s.bundles.get('B').gameData.Party || [];
		expect(partyA.some((pm) => pm.id === aCompanion), "A's own party must hold A's companion").toBe(true);
		expect(partyA.some((pm) => pm.id === bCompanion), "A's party must NOT hold B's companion").toBe(false);
		expect(partyB.some((pm) => pm.id === bCompanion), "B's own party must hold B's companion").toBe(true);
		expect(partyB.some((pm) => pm.id === aCompanion), "B's party must NOT hold A's companion").toBe(false);
	}, BOOT_TIMEOUT);

	it('step 2: at peace, both companions help against a shared monster and never attack a player or a companion', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-peace', enemyType: null });
		s.join('A'); s.join('B');

		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		standTogether(s, 'B', 'A');
		const bCompanion = recruitCompanion(s, 'B', 'WitchFlame');

		const posA = s.posOf('A');
		const monster = spawnEntityDirect(s, posA.x + 2, posA.y, 'Rat');

		const willMaxA = s.vitalsOf.get('A').willMax;
		const willMaxB = s.vitalsOf.get('B').willMax;
		let monsterDamaged = false;

		for (let round = 1; round <= 20; round++) {
			standTogether(s, 'B', 'A');
			const aPos = s.posOf('A');
			s.world.moveAvatar(monster.id, aPos.x + 1, aPos.y);
			s.world.eval(`(function(){
				var m = KDMapData.Entities.find(function(en){ return en.id === ${monster.id}; });
				if (m) { m.aware = true; m.hostile = 0; }
				KDUpdateEnemyCache = true;
			})()`);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });

			const mhp = hpOf(s, monster.id);
			if (!mhp || mhp.hp < mhp.maxhp) monsterDamaged = true;

			expect(s.vitalsOf.get('A').will, `round ${round}: A must never be hurt by either companion at peace`).toBe(willMaxA);
			expect(s.vitalsOf.get('B').will, `round ${round}: B must never be hurt by either companion at peace`).toBe(willMaxB);
			const aC = hpOf(s, aCompanion), bC = hpOf(s, bCompanion);
			if (aC) expect(aC.hp, `round ${round}: A's companion must never be hurt by B's companion at peace`).toBe(aC.maxhp);
			if (bC) expect(bC.hp, `round ${round}: B's companion must never be hurt by A's companion at peace`).toBe(bC.maxhp);
		}

		expect(monsterDamaged,
			'liveness: at least one companion must be ABLE to damage a real hostile monster at peace -- ' +
			'otherwise the "never hurts a player/companion" assertions above would be vacuous').toBe(true);
	}, BOOT_TIMEOUT);

	it('step 3: at war, A\'s companion attacks B AND B\'s companion (separate teams)', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-war', pvp: true, enemyType: null });
		s.join('A'); s.join('B');

		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		standTogether(s, 'B', 'A');
		const bCompanion = recruitCompanion(s, 'B', 'WitchFlame');

		expect(s._isPvP('A', 'B'), 'setup: the session must actually be at war').toBe(true);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		// `_armPeerEnemies` runs once per apply -- one round is enough for both players' own applies to
		// have re-factioned the other's companions for the war. Each side gets its OWNER's own war-team
		// faction (`MPWarTeam_<cid>`), not a shared literal 'Enemy' -- see swap-session.js's own
		// "SEPARATE TEAMS AT WAR" comment for why a shared literal broke owner safety.
		const bCompanionAfter = rawFieldsOf(s, bCompanion);
		const aCompanionAfter = rawFieldsOf(s, aCompanion);
		expect(bCompanionAfter.faction, "B's companion must read as B's own war-team faction while at war")
			.toBe(s._warFactionFor('B'));
		expect(aCompanionAfter.faction, "A's companion must read as A's own war-team faction while at war")
			.toBe(s._warFactionFor('A'));

		const willMaxB = s.vitalsOf.get('B').willMax;
		let companionCombatHappened = false;
		for (let round = 1; round <= 20; round++) {
			standTogether(s, 'B', 'A');
			pinNextTo(s, 'B', aCompanion);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			const bC = hpOf(s, bCompanion);
			if (!bC || bC.hp < bC.maxhp) companionCombatHappened = true;
			if (s.vitalsOf.get('B').will < willMaxB) companionCombatHappened = true;
		}
		expect(companionCombatHappened,
			"at war, A's companion must be able to land damage on B (the player) or B's companion").toBe(true);
	}, BOOT_TIMEOUT);

	it('step 4: war -> peace is fully reversible, and a mid-war attacker stops at once on peace', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-war-peace', pvp: true, enemyType: null });
		s.join('A'); s.join('B');

		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		standTogether(s, 'B', 'A');
		const bCompanion = recruitCompanion(s, 'B', 'WitchFlame');

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(rawFieldsOf(s, bCompanion).faction, 'setup: war must have armed the hostility first')
			.toBe(s._warFactionFor('B'));
		expect(s.world.eval(`KDFactionRelation(${JSON.stringify(s._warFactionFor('A'))}, ` +
			`${JSON.stringify(s._warFactionFor('B'))})`),
			'setup: the two war-team factions must actually be mutually hostile').toBeLessThanOrEqual(-0.5);

		// Declare peace the real way -- the routed dialogue, same as mp-peace-session.spec.ts.
		s.apply('A', { mp: 'peace.offer' });
		s.apply('B', {
			kdType: 'dialogue',
			data: { dialogue: 'KDCoopPeace', dialogueStage: 'Accept', click: true },
		});
		expect(s._isPvP('A', 'B'), 'setup: peace must actually be in effect now').toBe(false);

		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		// Checked BEFORE the per-companion loop below: that loop calls `world.restorePlayer` to put each
		// owner in the slot (needed for `KDIsInParty`'s own per-player read), and restoring a bundle
		// captured DURING this round -- before `_reconcilePeers`' own end-of-round clear ran -- would
		// reintroduce the stale relation on the live Map (the same per-player-watched-state mechanism
		// `ensureWarFaction`'s doc comment describes, in reverse). Reading it first avoids that entirely.
		expect(s.world.eval(`KDFactionRelation(${JSON.stringify(s._warFactionFor('A'))}, ` +
			`${JSON.stringify(s._warFactionFor('B'))})`),
			'no residual faction RELATION between the two war-team factions after peace').toBe(0);

		for (const [eid, ownerCid] of [[aCompanion, 'A'], [bCompanion, 'B']] as [number, string][]) {
			const f = rawFieldsOf(s, eid);
			// `setEntityFaction(eid, null)` DELETES the own-field override (so `e.faction` itself reads
			// `undefined` -- confirming no residual STAMP is left standing), and KD's own `KDGetFaction`
			// fallback (`KDIsInParty(enemy) -> "Player"`) is what the engine actually evaluates hostility
			// against from here on -- that is the real-world "back to friendly" check. `KDIsInParty`
			// reads whichever player is CURRENTLY in the slot, so the owner must be swapped in to ask --
			// the exact "Party is per-player" lesson `recruitCompanion` already encodes.
			expect(f.faction, `entity ${eid}: no residual faction STAMP left on the entity after peace`)
				.toBeUndefined();
			s.world.restorePlayer(s.bundles.get(ownerCid));
			expect(factionOf(s, eid), `entity ${eid}: resolves back to the party default ('Player') after peace`)
				.toBe('Player');
			expect(f.hostile, `entity ${eid}: no residual hostile countdown after peace`).toBe(0);
			expect(f.factionorig, `entity ${eid}: no residual factionorig memory after peace`).toBeUndefined();
		}

		const willMaxA = s.vitalsOf.get('A').willMax;
		const willMaxB = s.vitalsOf.get('B').willMax;
		for (let round = 1; round <= 10; round++) {
			standTogether(s, 'B', 'A');
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });
			expect(s.vitalsOf.get('A').will, `round ${round}: no lingering attack after peace`).toBe(willMaxA);
			expect(s.vitalsOf.get('B').will, `round ${round}: no lingering attack after peace`).toBe(willMaxB);
		}

		// Repeatable: peace -> war -> peace again. A negotiated truce overrides the global PvP flag
		// (`_isPvP`'s own `atPeace` short-circuit), so merely leaving `pvp:true` standing is not enough
		// to re-enter war -- declare it again the same way a real attack would (`_reconcilePeers`'s own
		// aggro-based auto-declare), via the relation object's own symmetric war/peace pair.
		s.rel.declareWar('A', 'B');
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(rawFieldsOf(s, bCompanion).faction, 're-declaring war must re-arm the hostility')
			.toBe(s._warFactionFor('B'));

		s.apply('A', { mp: 'peace.offer' });
		s.apply('B', {
			kdType: 'dialogue',
			data: { dialogue: 'KDCoopPeace', dialogueStage: 'Accept', click: true },
		});
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(rawFieldsOf(s, bCompanion).faction, 'the second peace must clear the stamp again (repeatable)')
			.toBeUndefined();
	}, BOOT_TIMEOUT);

	it('war owner-safety: a companion stamped hostile for war must never attack its OWN owner, and must still attack the other player', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-war-owner-safety', pvp: true, enemyType: null });
		s.join('A'); s.join('B');

		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		const bPos0 = s.posOf('B');
		s.world.moveAvatar(s.avatars.get('A'), bPos0.x + 5, bPos0.y);
		const bCompanion = recruitCompanion(s, 'B', 'WitchFlame');

		expect(s._isPvP('A', 'B'), 'setup: the session must actually be at war').toBe(true);

		// One round lets `_armPeerEnemies` stamp both companions hostile for the war.
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		const willMaxA = s.vitalsOf.get('A').willMax;
		const willMaxB = s.vitalsOf.get('B').willMax;
		let aCompanionHurtOpponent = false;
		let bCompanionHurtOpponent = false;

		for (let round = 1; round <= 20; round++) {
			// Each companion placed next to its OWN owner (the scenario that must stay safe) -- plain
			// adjacency, NOT `pinNextTo`'s forced gx/gy lock (see `placeAdjacentTo`'s own doc comment for
			// why forcing a lock onto the real human's own tile would be the wrong probe for a safety
			// check). `standTogether` also puts the OTHER player's avatar within reach, so "must still
			// attack the other player" is exercised in the SAME round, not a separate scene.
			standTogether(s, 'B', 'A');
			placeAdjacentTo(s, 'A', aCompanion);
			placeAdjacentTo(s, 'B', bCompanion);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });

			expect(s.vitalsOf.get('A').will,
				`round ${round}: A's own companion must never hurt A, its own owner, even while war-armed`)
				.toBe(willMaxA);
			expect(s.vitalsOf.get('B').will,
				`round ${round}: B's own companion must never hurt B, its own owner, even while war-armed`)
				.toBe(willMaxB);

			if (s.vitalsOf.get('B').will < willMaxB) bCompanionHurtOpponent = true; // (never true, see above)
			const aC = hpOf(s, aCompanion), bC = hpOf(s, bCompanion);
			// Liveness in THIS same scene: each companion must still be able to reach the OTHER
			// player's avatar/companion -- "attacks B" is proven by B's own real Will dropping below
			// max for B's companion's own target (A), or by a companion's hp loss.
			if (!aC || aC.hp < aC.maxhp) bCompanionHurtOpponent = true; // B's side damaged A's companion
			if (!bC || bC.hp < bC.maxhp) aCompanionHurtOpponent = true; // A's side damaged B's companion
		}

		expect(aCompanionHurtOpponent,
			"liveness: A's companion must still be ABLE to fight the other team while war-armed -- " +
			'otherwise the owner-safety assertions above would be proving nothing').toBe(true);
		expect(bCompanionHurtOpponent,
			"liveness: B's companion must still be ABLE to fight the other team while war-armed -- " +
			'otherwise the owner-safety assertions above would be proving nothing').toBe(true);
	}, BOOT_TIMEOUT);

	it('war monster-side: each team\'s companion keeps fighting (and being fought by) a real hostile monster', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-war-monsters', pvp: true, enemyType: null });
		s.join('A'); s.join('B');

		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		const bPos0 = s.posOf('B');
		s.world.moveAvatar(s.avatars.get('A'), bPos0.x + 5, bPos0.y);
		const bCompanion = recruitCompanion(s, 'B', 'WitchFlame');
		expect(s._isPvP('A', 'B'), 'setup: the session must actually be at war').toBe(true);

		// One round lets `_armPeerEnemies` stamp both companions hostile for the war.
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		const aPos = s.posOf('A');
		const monsterA = spawnEntityDirect(s, aPos.x + 1, aPos.y, 'Rat');
		const bPos = s.posOf('B');
		const monsterB = spawnEntityDirect(s, bPos.x + 1, bPos.y, 'Rat');

		let companionDamagedMonster = false;
		let monsterDamagedCompanion = false;

		for (let round = 1; round <= 20; round++) {
			// `getEntityCombat`/`posOfEntity` return null once an entity is gone -- a one-shot kill (the
			// companion-avatar-immunity spec's own measured recipe: "the companion's spell nearly
			// one-shots a Rat") is itself proof of damage, in EITHER direction, not a setup failure.
			const aCPos = posOfEntity(s, aCompanion);
			if (aCPos) s.world.moveAvatar(monsterA.id, aCPos.x + 1, aCPos.y);
			else monsterDamagedCompanion = true;
			const bCPos = posOfEntity(s, bCompanion);
			if (bCPos) s.world.moveAvatar(monsterB.id, bCPos.x + 1, bCPos.y);
			else monsterDamagedCompanion = true;
			s.world.eval(`(function(){
				var ids = [${monsterA.id}, ${monsterB.id}];
				for (var i = 0; i < ids.length; i++) {
					var m = KDMapData.Entities.find(function(en){ return en.id === ids[i]; });
					if (m) { m.aware = true; m.hostile = 0; }
				}
				KDUpdateEnemyCache = true;
			})()`);
			s.submit('A', { kind: 'wait' });
			s.submit('B', { kind: 'wait' });

			const mA = hpOf(s, monsterA.id), mB = hpOf(s, monsterB.id);
			if (!mA || mA.hp < mA.maxhp || !mB || mB.hp < mB.maxhp) companionDamagedMonster = true;
			const cA = hpOf(s, aCompanion), cB = hpOf(s, bCompanion);
			if ((cA && cA.hp < cA.maxhp) || (cB && cB.hp < cB.maxhp)) monsterDamagedCompanion = true;
		}

		expect(companionDamagedMonster,
			'while war-armed, a companion must still be able to damage an ordinary hostile monster')
			.toBe(true);
		expect(monsterDamagedCompanion,
			'while war-armed, an ordinary hostile monster must still be able to damage a companion')
			.toBe(true);
	}, BOOT_TIMEOUT);
});
