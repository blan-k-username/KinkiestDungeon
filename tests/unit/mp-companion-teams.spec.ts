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
import { freeNeighbour, spawnEntityDirect } from '../helpers/session-tiles';

const BOOT_TIMEOUT = 240_000;

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

/**
 * Record every hit a HUMAN takes, attributed: who was hit (the war team of the human in the slot at the
 * moment of damage, `__kdSlotWarTeam`) and by whom (a bullet's `source`, else the enemy whose own turn
 * is running -- KD deals an enemy's own attack from `KinkyDungeonEnemyLoop`, KinkyDungeonEnemies.ts:7499).
 * Node-side sink: the slot swap captures and restores in-world state, not this array.
 */
function recordPlayerHits(s: any): Array<{ team: string, by: number | null, dw: number }> {
	const hits: any[] = [];
	s.world._context.__hitSink = (j: string) => hits.push(JSON.parse(j));
	s.world.eval(`(function(){
		var cur = null, loop = KinkyDungeonEnemyLoop, deal = KinkyDungeonDealDamage;
		KinkyDungeonEnemyLoop = function(e){ var o = cur; cur = e; try { return loop.apply(this, arguments); } finally { cur = o; } };
		KinkyDungeonDealDamage = function(d, b){
			var w0 = KinkyDungeonStatWill, r = deal.apply(this, arguments);
			var by = (b && b.bullet && b.bullet.source != null) ? b.bullet.source : (cur ? cur.id : null);
			__hitSink(JSON.stringify({ team: globalThis.__kdSlotWarTeam, by: by, dw: KinkyDungeonStatWill - w0 }));
			return r;
		};
	})()`);
	return hits;
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

		const hits = recordPlayerHits(s);
		// CONTROL: the recorder sees a hit and attributes it to nobody, on A's own team.
		s.world.restorePlayer(s.bundles.get('A'));
		s._assertHumanContext('A');
		s.world.eval("KinkyDungeonDealDamage({ damage: 1, type: 'crush' }, undefined, true, true, true);");
		expect(hits.splice(0), 'control: the hit recorder works').toEqual([expect.objectContaining({ team: s._warFactionFor('A'), by: null })]);
		s.bundles.set('A', s.world.capturePlayer());

		const ownerOf: Record<number, string> = { [aCompanion]: s._warFactionFor('A'), [bCompanion]: s._warFactionFor('B') };
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

			// Attributed, not total Will: the OTHER team hurting a player is the liveness this test wants.
			const roundHits = hits.splice(0).filter((h) => h.by != null && ownerOf[h.by]);
			for (const h of roundHits) {
				expect(h.team, `round ${round}: companion ${h.by} must never hurt its own owner, even while war-armed`)
					.not.toBe(ownerOf[h.by]);
				if (h.by === aCompanion) aCompanionHurtOpponent = true; // hurt B
				if (h.by === bCompanion) bCompanionHurtOpponent = true; // hurt A
			}
			const aC = hpOf(s, aCompanion), bC = hpOf(s, bCompanion);
			// Liveness in THIS same scene: each companion must still be able to reach the OTHER
			// team -- the other player (recorded above) or the other player's companion (hp loss).
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

	it('war bullets: a companion\'s own spell never hits its owner, on the owner\'s turn or on the partner\'s, and still hits the other player', () => {
		// KD's bullet gates spare the player only from a bullet whose faction is FAVORABLE to "Player"
		// (KDBulletCanHitEntity / KDBulletAoECanHitEntity, KinkyDungeonFight.ts:3178-3221). A single-player
		// companion's bullets carry "Player"; a war companion's carry its owner's war faction, which has
		// no relation to "Player" at all. Asked at the deciding layer with a REAL cast bullet, so the
		// answer does not depend on whether the companion happens to choose to cast in a given round.
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'companion-war-bullets', pvp: true, enemyType: null });
		s.join('A'); s.join('B');
		const aCompanion = recruitCompanion(s, 'A', 'WitchEarth');
		const bPos0 = s.posOf('B');
		s.world.moveAvatar(s.avatars.get('A'), bPos0.x + 5, bPos0.y);
		recruitCompanion(s, 'B', 'WitchFlame');
		expect(s._isPvP('A', 'B'), 'setup: the session must actually be at war').toBe(true);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		/** `holder` takes the slot; A's companion casts a real WitchBoulder; the bullet is put on `onCid`'s
		 *  tile and KD's own gates are asked whether it hits whoever stands there (slot player or avatar). */
		const gate = (holder: string, onCid: string) => {
			s.world.restorePlayer(s.bundles.get(holder));
			s._assertHumanContext(holder);
			const avatarId = holder === onCid ? -1 : s.avatars.get(onCid);
			// The companion casts from beside the target, never from the target's own tile.
			placeAdjacentTo(s, onCid, aCompanion);
			return s.world.eval(`(function(){
				var c = KDMapData.Entities.find(function(en){ return en.id === ${aCompanion}; });
				var target = ${avatarId} < 0 ? KinkyDungeonPlayerEntity
					: KDMapData.Entities.find(function(en){ return en.id === ${avatarId}; });
				var old = KDMapData.Bullets.slice();
				KinkyDungeonCastSpell(target.x, target.y, KinkyDungeonFindSpell('WitchBoulder', true), c, undefined, undefined);
				var made = KDMapData.Bullets.filter(function(x){ return old.indexOf(x) < 0; });
				KDMapData.Bullets = old;
				var b = made[0];
				if (made.length !== 1 || b.bullet.source !== c.id) return { cast: false, made: made.length };
				b.x = target.x; b.y = target.y;
				var direct = !!KDBulletCanHitEntity(b, target);
				var spell = b.bullet.spell;
				// The AoE gate's own sparing clause only exists for noHitAlliedPlayer spells: ask it with one.
				b.bullet.spell = Object.assign({}, spell, { noHitAlliedPlayer: true });
				var aoe = !!KDBulletAoECanHitEntity(b, target);
				b.bullet.spell = spell;
				return { cast: true, faction: b.bullet.faction, direct: direct, aoe: aoe, after: b.bullet.faction };
			})()`);
		};

		const ownTurn = gate('A', 'A');
		expect(ownTurn, 'setup: A\'s companion really cast a war-faction bullet').toMatchObject({ cast: true, faction: 'MPWarTeam_A' });
		expect(ownTurn.direct, 'A holds the slot: A\'s own companion\'s bolt must not hit A').toBe(false);
		expect(ownTurn.aoe, 'A holds the slot: an ally-sparing AoE of A\'s own companion must not hit A').toBe(false);
		expect(ownTurn.after, 'the gate leaves the bullet\'s own faction untouched').toBe('MPWarTeam_A');

		const partnersTurn = gate('B', 'A');
		expect(partnersTurn.cast, 'setup: cast on B\'s turn').toBe(true);
		expect(partnersTurn.direct, 'B holds the slot: A\'s companion\'s bolt must not hit A\'s avatar').toBe(false);

		// Liveness, same bullet shape: the other team IS hit, on either human's turn.
		const onB = gate('B', 'B');
		expect(onB.direct, 'B holds the slot: A\'s companion\'s bolt hits B').toBe(true);
		expect(onB.aoe, 'B holds the slot: A\'s companion\'s AoE hits B').toBe(true);
		expect(gate('A', 'B').direct, 'A holds the slot: A\'s companion\'s bolt hits B\'s avatar').toBe(true);
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
