/**
 * CO-OP UNTIE — part 1: the peer's bondage is mirrored onto their avatar even at peace.
 *
 * In single player you untie a bound ally through the `GenericAlly` dialogue: `KDAllyDialogue`
 * (KinkyDungeonDialogue.ts:631) offers `Untie` (:845) gated on
 * `KDGetPlayerUntieBindAmt(enemy) > 0` (:2924) — i.e. on the ENTITY's `boundLevel`.
 *
 * A peer avatar only ever had its bondage mirrored by `_armPeerEnemies`, which skipped anyone the
 * actor was not at WAR with. So in co-op the avatar always read as unbound, `KDGetPlayerUntieBindAmt`
 * returned NaN (`enemy.boundLevel` undefined ⇒ `baseAmnt -= minimumBondage` ⇒ NaN), `NaN > 0` was
 * false, and the option was never offered — the UAT report "players cannot help each other to remove
 * bondage".
 *
 * Bondage is not a combat stance: it is what the peer IS wearing. It is mirrored for every peer now,
 * at war or not; only the hostility/hp/defence arming stays PvP-only.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

/** The gates KD itself evaluates when A talks to B's avatar. */
function gatesFor(s: any, avatarId: number) {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${avatarId | 0}; });
		if (!e) return null;
		var amt = KDGetPlayerUntieBindAmt(e);
		return {
			boundLevel: e.boundLevel || 0,
			canTalk: !!KDTalkToEnemy(e),
			allied: !!KDAllied(e),
			untieBindAmt: String(amt),
			untieOptionShown: amt > 0,
			helpless: !!KDHelpless(e),
			boundEffects: KDBoundEffects(e),
		};
	})()`);
}

describe('co-op: untying a peer', () => {
	it('offers the Untie option on a bound peer at peace', async () => {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'coop-untie', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();

		const avB = s.avatars.get('B');
		expect(avB, 'precondition: B has an avatar').toBeTruthy();

		// B really is bound (the wearRestraint seed put it on the shared player template).
		s.world.restorePlayer(s.bundles.get('B'));
		const bVitals = s.world.getVitals();
		expect(bVitals.bondage, 'precondition: B carries some bondage power').toBeGreaterThan(0);
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', bVitals);

		// A's turn: the actor is swapped in, their own avatar parked, peers armed.
		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);
		s.world.moveAvatar(s.avatars.get('A'), 1, 1);
		s._armPeerEnemies('A');

		const g = gatesFor(s, avB);

		// A can open the ally dialogue on a peer at peace — that half always worked.
		expect(g.allied).toBe(true);
		expect(g.canTalk).toBe(true);

		// …and the peer now reads as bound, so KD offers Untie.
		expect(g.boundLevel).toBeGreaterThan(0);
		expect(g.untieBindAmt).not.toBe('NaN');
		expect(g.untieOptionShown).toBe(true);
	}, BOOT_TIMEOUT);

	it('offers nothing to untie when the peer is not bound (the option is theirs, not ours)', async () => {
		// CONTROL: same path, no restraint. If this passed too, the assertion above would be measuring
		// nothing but "we always mirror something".
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'coop-untie-unbound', pvp: false });
		s.join('A');
		s.join('B');
		await s.ready();

		const avB = s.avatars.get('B');
		s.world.restorePlayer(s.bundles.get('B'));
		expect(s.world.getVitals().bondage).toBe(0);
		s.vitalsOf.set('B', s.world.getVitals());

		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);
		s.world.moveAvatar(s.avatars.get('A'), 1, 1);
		s._armPeerEnemies('A');

		const g = gatesFor(s, avB);
		expect(g.canTalk).toBe(true);          // still talkable…
		expect(g.boundLevel).toBe(0);
		expect(g.untieOptionShown).toBe(false); // …but there is nothing to untie
	}, BOOT_TIMEOUT);
});

/**
 * CO-OP UNTIE — part 2: the untie reaches the peer's REAL restraints.
 *
 * `KDUntieEnemy` only lowers the avatar's bind LEVEL, and the avatar is a per-turn stand-in that is
 * rebuilt from the peer every turn — so on its own an untie is forgotten before it means anything.
 * The one bondage channel from avatar back to owner was `ec.npcRestraints`, which is ADDITIVE ONLY
 * (KD-101 mirrors ties). This is the missing half: the per-turn DROP in the avatar's bind level is
 * spent as real escape progress on the victim's own worn restraints, through the game's own
 * `KinkyDungeonRemoveRestraint` — the exact mirror of the tie path's `KinkyDungeonAddRestraint`.
 */
describe('co-op: an untie reaches the peer', () => {
	/** Everything a turn does before the actor acts, with B standing next to A. */
	async function coopPair(seed: string) {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed, pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();
		const avB = s.avatars.get('B');
		s.world.restorePlayer(s.bundles.get('B'));
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', s.world.getVitals());
		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);
		s.world.moveAvatar(s.avatars.get('A'), 1, 1);
		s._armPeerEnemies('A');
		return { s, avB };
	}

	/** B's real worn state, read off their own bundle. */
	function wornOf(s: any, id: string) {
		s.world.restorePlayer(s.bundles.get(id));
		return s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return {
			name: r.name, struggleProgress: r.struggleProgress || 0 }; })`);
	}

	it('spends the untied bind level on the peer\'s own restraints', async () => {
		const { s, avB } = await coopPair('coop-untie-reaches');
		expect(wornOf(s, 'B').map((r: any) => r.name)).toEqual(['DuctTapeHands']);
		s.world.restorePlayer(s.bundles.get('A'));

		// Exactly what the ally dialogue's Untie option does (KinkyDungeonDialogue.ts:865).
		const untied = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${avB | 0}; });
			var before = e.boundLevel || 0;
			KDUntieEnemy(e, KDGetPlayerUntieBindAmt(e), false, true);
			return { before: before, after: e.boundLevel || 0 };
		})()`);
		expect(untied.after, 'the untie lowered the avatar bind level').toBeLessThan(untied.before);

		s._reconcilePeers();

		const worn = wornOf(s, 'B');
		const freed = worn.length === 0;
		const progressed = worn.length > 0 && worn[0].struggleProgress > 0;
		expect(freed || progressed,
			`B must be freed or partly freed, got ${JSON.stringify(worn)}`).toBe(true);
		expect(s.vitalsOf.get('B').bondage).toBeLessThan(untied.before);
	}, BOOT_TIMEOUT);

	it('leaves the peer alone when nobody unties them', async () => {
		// CONTROL: same reconcile, no untie. Without this the assertion above would also pass if the
		// reconciler simply stripped everyone's restraints every turn.
		const { s } = await coopPair('coop-untie-control');
		const before = wornOf(s, 'B');
		s.world.restorePlayer(s.bundles.get('A'));

		s._reconcilePeers();

		expect(wornOf(s, 'B')).toEqual(before);
	}, BOOT_TIMEOUT);
});

/**
 * REGRESSION: the untie delta is only meaningful for an avatar armed THIS turn.
 *
 * `_reconcilePeers` walks every joined player, including the actor — whose own avatar is parked at
 * PARK and never armed, so its `boundLevel` is stale. Reading an untie off that charged every player
 * a phantom untie on their own turn and quietly stripped their restraints. Caught first by
 * `mp-slow-per-player` (a hobbled player walked away unslowed); pinned here at the source.
 */
describe('co-op: an unarmed avatar is not a phantom untie', () => {
	it('leaves the actor\'s own restraints alone across their own turn', async () => {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'coop-untie-phantom', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();

		const worn = (id: string) => {
			s.world.restorePlayer(s.bundles.get(id));
			return s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return r.name; })`);
		};
		expect(worn('A')).toEqual(['DuctTapeHands']);

		// A real lockstep turn: both players act, nobody unties anybody.
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });

		expect(worn('A'), 'A keeps their own bondage through their own turn').toEqual(['DuctTapeHands']);
		expect(worn('B'), 'and so does B').toEqual(['DuctTapeHands']);
	}, BOOT_TIMEOUT);
});

/**
 * END TO END through the REAL input path: A opens the ally dialogue on B's avatar and clicks Untie.
 *
 * The tests above drive `KDUntieEnemy` directly, which proves the reconcile channel but assumes the
 * dialogue reaches it. This one makes no such assumption: both steps go through `submit` as
 * `kdType: 'dialogue'` — the exact input KD's own dialogue buttons send
 * (KinkyDungeonDialogue.ts:191 for an option, :552 to open) — so if the option were unreachable, or
 * the speaker/entity plumbing wrong, this fails where the others would not.
 */
describe('co-op untie, driven through the dialogue input', () => {
	it('A talking to B and choosing Untie loosens B for real', async () => {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'coop-untie-e2e', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();

		const avB = s.avatars.get('B');
		const speaker = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${avB | 0}; });
			return e && e.Enemy && e.Enemy.name;
		})()`);
		expect(speaker, 'the avatar has its own def name').toMatch(/^RemotePlayer/);

		const wornB = () => {
			s.world.restorePlayer(s.bundles.get('B'));
			return s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return {
				name: r.name, struggleProgress: r.struggleProgress || 0 }; })`);
		};
		expect(wornB().map((r: any) => r.name)).toEqual(['DuctTapeHands']);

		// Stand B next to A so the dialogue is reachable at all.
		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);

		// Turn 1 — A opens the ally dialogue on the peer.
		s.submit('A', { kdType: 'dialogue', data: { dialogue: 'GenericAlly', dialogueStage: '', click: true, speaker: speaker, enemy: avB } });
		s.submit('B', { kind: 'wait' });

		// Turn 2 — A picks Untie.
		s.submit('A', { kdType: 'dialogue', data: { dialogue: 'GenericAlly', dialogueStage: 'Untie', click: true, speaker: speaker, enemy: avB } });
		s.submit('B', { kind: 'wait' });

		const after = wornB();
		const freed = after.length === 0;
		const progressed = after.length > 0 && after[0].struggleProgress > 0;
		expect(freed || progressed,
			`B must be freed or partly freed by the dialogue, got ${JSON.stringify(after)}`).toBe(true);
	}, BOOT_TIMEOUT);

	it('…and a different option in the same dialogue does not', async () => {
		// CONTROL for the test above: identical shape, identical turns, only the chosen option
		// differs. Without it, "two dialogue turns happened and B ended up free" would also pass if
		// ANY dialogue turn freed a peer.
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'coop-untie-e2e-control', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();

		const avB = s.avatars.get('B');
		const speaker = s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${avB | 0}; });
			return e && e.Enemy && e.Enemy.name;
		})()`);
		const wornB = () => {
			s.world.restorePlayer(s.bundles.get('B'));
			return s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return {
				name: r.name, struggleProgress: r.struggleProgress || 0 }; })`);
		};
		const before = wornB();

		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);

		s.submit('A', { kdType: 'dialogue', data: { dialogue: 'GenericAlly', dialogueStage: '', click: true, speaker: speaker, enemy: avB } });
		s.submit('B', { kind: 'wait' });
		s.submit('A', { kdType: 'dialogue', data: { dialogue: 'GenericAlly', dialogueStage: 'Leave', click: true, speaker: speaker, enemy: avB } });
		s.submit('B', { kind: 'wait' });

		expect(wornB(), 'Leave must not untie anybody').toEqual(before);
	}, BOOT_TIMEOUT);
});

/**
 * WHAT AN ALLY'S UNTIE MUST NOT REACH.
 *
 * `KDGetPlayerUntieBindAmt` is documented "10% of current binding or 10, whichever is more, but NOT
 * INCLUDING PROTECTED BONDAGE" (KinkyDungeonDialogue.ts:2924): it subtracts the bind level backed by
 * real items and anything flagged `helpImmune`, and `KDUntieEnemy` is called with
 * `includeUnlocked = true` — an ally loosens what is merely tied, never what is locked on.
 *
 * The player-side mirror of that rule: a LOCKED restraint needs a key or a pick, and a CURSED one
 * cannot come off at all. Neither is something a friend can talk you out of, so neither may be spent
 * by an untie — the untie budget skips them and moves on.
 */
describe('co-op untie respects protected bondage', () => {
	async function boundPeer(seed: string, prepare: string, wear = 'DuctTapeHands') {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed, pvp: false, wearRestraint: wear,
		});
		s.join('A');
		s.join('B');
		await s.ready();
		s.world.restorePlayer(s.bundles.get('B'));
		s.world.eval(prepare);
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', s.world.getVitals());
		return s;
	}
	const wornOf = (s: any, id: string) => {
		s.world.restorePlayer(s.bundles.get(id));
		return s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return r.name; })`);
	};
	/** Spend a generous untie budget straight at the host method — the channel, isolated. */
	const untieAll = (s: any) => {
		s.world.restorePlayer(s.bundles.get('B'));
		const res = s.world.untieRestraints(9999, 0);
		s.bundles.set('B', s.world.capturePlayer());
		return res;
	};

	it('cannot untie a LOCKED restraint', async () => {
		// Cuffs, not tape: `KinkyDungeonLock` only writes `item.lock` when the restraint is LOCKABLE
		// (KinkyDungeonRestraints.ts:696), and tape is not. The first version of this test locked tape,
		// so the lock silently never took and it was measuring an unlocked item — hence the assertion
		// on `locked` below, which makes that failure mode impossible to repeat.
		const s = await boundPeer('untie-locked', `(function(){
			var it = KinkyDungeonAllRestraint()[0];
			KinkyDungeonLock(it, 'Red');
			return { name: it.name, lock: it.lock || null };
		})()`, 'HingedCuffs');
		const locked = s.world.eval(`(function(){
			var it = KinkyDungeonAllRestraint()[0];
			return it ? (it.lock || null) : null;
		})()`);
		expect(locked, 'precondition: the restraint really is locked').toBeTruthy();

		const res = untieAll(s);
		expect(res.removed, 'a locked restraint is not an ally\'s to remove').toEqual([]);
		expect(res.protectedItems.map((p: any) => p.why)).toEqual(['locked']);
		expect(wornOf(s, 'B')).toEqual(['HingedCuffs']);
	}, BOOT_TIMEOUT);

	it('cannot untie a CURSED restraint', async () => {
		const s = await boundPeer('untie-cursed', `(function(){
			var it = KinkyDungeonAllRestraint()[0];
			it.curse = 'DollPlug';
			return KDGetCurse(it);
		})()`);
		const res = untieAll(s);
		expect(res.removed, 'a curse is not an ally\'s to lift').toEqual([]);
		expect(wornOf(s, 'B')).toEqual(['DuctTapeHands']);
	}, BOOT_TIMEOUT);

	it('CONTROL: the same budget frees an ordinary restraint', async () => {
		// Without this, the two assertions above would pass just as well if untieRestraints were
		// broken outright and never removed anything.
		const s = await boundPeer('untie-plain', `1`);
		const res = untieAll(s);
		expect(res.removed).toEqual(['DuctTapeHands']);
		expect(wornOf(s, 'B')).toEqual([]);
	}, BOOT_TIMEOUT);
});

/**
 * The two consequences of parts 1 and 2 that are easy to leave untested.
 */
describe('co-op untie: knock-on effects', () => {
	it('a restraint untied off a peer can be tied onto them again', async () => {
		// `tiedOf` de-dups the tie mirror BY NAME, so an item that is freed has to leave that set or
		// the de-dup swallows the next tie of the same restraint forever ("already mirrored").
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'untie-retie', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();
		const wornB = () => {
			s.world.restorePlayer(s.bundles.get('B'));
			return s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return r.name; })`);
		};
		// Pretend the tie path already mirrored this restraint onto B (that is what tiedOf records).
		s.tiedOf.set('B', new Set(['DuctTapeHands']));

		// A frees it.
		s.world.restorePlayer(s.bundles.get('B'));
		const freed = s.world.untieRestraints(9999, 0);
		s.bundles.set('B', s.world.capturePlayer());
		expect(freed.removed).toEqual(['DuctTapeHands']);
		for (const n of freed.removed) s.tiedOf.get('B').delete(n);
		expect(wornB()).toEqual([]);

		// …and it can be put back on: the name is no longer marked as already-mirrored.
		expect(s.tiedOf.get('B').has('DuctTapeHands'),
			'a freed restraint must not stay marked as already tied').toBe(false);
		s.world.restorePlayer(s.bundles.get('B'));
		s.world.addRestraint('DuctTapeHands');
		s.bundles.set('B', s.world.capturePlayer());
		expect(wornB()).toEqual(['DuctTapeHands']);
	}, BOOT_TIMEOUT);

	it('a peer bound past KD\'s own threshold stops being able to help you struggle', async () => {
		// Mirroring bondage onto co-op peers (part 1) switches on KD's OWN rule about a bound helper:
		// `KinkyDungeonHasAllyHelp` requires `KDBoundEffects(enemy) < 4`
		// (KinkyDungeonRestraints.ts:1086). A hogtied partner being no use is the game's answer, not
		// one this layer invents — so pin it, because it is a real behaviour change.
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'untie-helper-bound', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();
		const avB = s.avatars.get('B');

		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);
		s.world.moveAvatar(s.avatars.get('A'), 1, 1);

		const helpWith = (bondage: number) => {
			s.vitalsOf.set('B', { bondage });
			s._armPeerEnemies('A');
			return s.world.eval(`(function(){
				var e = KDMapData.Entities.find(function(en){ return en.id === ${avB | 0}; });
				return { help: !!KinkyDungeonHasAllyHelp(), boundEffects: KDBoundEffects(e) };
			})()`);
		};

		const lightly = helpWith(1);
		expect(lightly.boundEffects, 'precondition: a lightly bound peer is under the threshold')
			.toBeLessThan(4);
		expect(lightly.help, 'a lightly bound partner still helps').toBe(true);

		const trussed = helpWith(500);
		expect(trussed.boundEffects, 'precondition: this peer really is past the threshold')
			.toBeGreaterThanOrEqual(4);
		expect(trussed.help, 'a trussed partner cannot help').toBe(false);
	}, BOOT_TIMEOUT);
});

/**
 * AC3 — THE UNTIE IS A PEACE AFFORDANCE. At war there is no dialogue to open at all.
 *
 * Asserted at the DECIDING LAYER, which is not `KDGetPlayerUntieBindAmt`. Both of KD's player-facing
 * routes to an ally dialogue — the bump (`KinkyDungeonGame.ts:2699`) and the context menu
 * (`KDContextMenu.ts:173`) — gate on `KDTalkToEnemy` BEFORE any dialogue exists, and
 * `KDTalkToEnemy` is false for an aggressive non-ally (`KinkyDungeonGame.ts:4572`). So the honest
 * question is "does walking into your peer open a dialogue", not "would the option have passed its
 * prerequisite", and that is what these arms ask.
 *
 * Two levels, because the gate and its consequence fail differently:
 *  - the GATE, read on a freshly armed avatar (the same `_armPeerEnemies` + read the first describe
 *    uses), where the peace/war arms differ in `KDTalkToEnemy` alone;
 *  - the CONSEQUENCE, driven by the one real input a player actually sends. The pair spawn adjacent,
 *    so a single `move` toward the peer IS the interaction.
 *
 * What deliberately does NOT change between the arms is the untie budget: bondage is mirrored onto
 * the avatar at war too (`_armPeerEnemies`), so `KDGetPlayerUntieBindAmt` is > 0 either way. That
 * makes this a test about HOSTILITY rather than one that would pass because there was nothing to
 * untie.
 *
 * The context-menu half of the same gate is asserted in a browser by `tests/e2e/mp-coop-untie.spec.ts`
 * and cannot be asserted here: headless, the menu is behind a vision gate that drops every entity
 * entry, so the peer's tile builds to `["Wait","Special"]` at war AND at peace — an absence that
 * would read as a pass for the wrong reason.
 */
describe('co-op untie is refused at war', () => {
	/** Arm A's turn against a bound peer and read the gates KD evaluates, at war or at peace. */
	async function armedGates(pvp: boolean) {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'untie-war-gates', pvp, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();
		const avB = s.avatars.get('B');
		s.world.restorePlayer(s.bundles.get('B'));
		s.vitalsOf.set('B', s.world.getVitals());
		s.world.restorePlayer(s.bundles.get('A'));
		const pos = s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		s.world.moveAvatar(avB, pos.x + 1, pos.y);
		s.world.moveAvatar(s.avatars.get('A'), 1, 1);
		s._armPeerEnemies('A');
		return { s, g: gatesFor(s, avB), aggressive: s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${avB | 0}; });
			return !!KinkyDungeonAggressive(e);
		})()`) };
	}

	it('at war KD\'s talk gate is shut, while the untie budget stays exactly what it was', async () => {
		const war = await armedGates(true);
		expect(war.aggressive, 'precondition: this arm really is at war').toBe(true);
		expect(war.g.allied, 'an enemy is not an ally').toBe(false);
		expect(war.g.canTalk,
			'AC3: KDTalkToEnemy is the gate BOTH player routes to the dialogue read').toBe(false);
		// The refusal is about hostility, not about an empty target — the peer is just as untieable.
		expect(war.g.untieBindAmt).not.toBe('NaN');
		expect(war.g.untieOptionShown,
			'the target is worth untying the whole time; only the way in is shut').toBe(true);
	}, BOOT_TIMEOUT);

	it('CONTROL: at peace the same arming leaves the gate open', async () => {
		// Without this arm, the assertions above would pass just as well if peers were never talkable,
		// or if the arming had failed and left an avatar nobody could interact with at all.
		const peace = await armedGates(false);
		expect(peace.aggressive, 'precondition: this arm is at peace').toBe(false);
		expect(peace.g.allied).toBe(true);
		expect(peace.g.canTalk, 'the ONLY verdict that differs between the arms').toBe(true);
		expect(peace.g.untieOptionShown, '…with the same budget as the war arm').toBe(true);
	}, BOOT_TIMEOUT);

	/**
	 * …and the consequence, through the real input. Bump A into B and see what the game did with it.
	 * Everything here is read from DURABLE state (the dialogue on A's own bundle, B's worn restraints,
	 * B's Will) rather than from the shared world entity, whose arming belongs to whichever turn ran
	 * last by the time `submit` returns.
	 */
	async function bumpPeer(pvp: boolean) {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'untie-war-bump', pvp, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();
		const posOf = (id: string) => {
			s.world.restorePlayer(s.bundles.get(id));
			return s.world.eval(`({x: KinkyDungeonPlayerEntity.x, y: KinkyDungeonPlayerEntity.y})`);
		};
		const a0 = posOf('A');
		const b0 = posOf('B');
		expect(Math.max(Math.abs(b0.x - a0.x), Math.abs(b0.y - a0.y)),
			'precondition: the pair spawn adjacent, so one move bumps A into B').toBe(1);

		const willBefore = (s.vitalsOf.get('B') || {}).will;
		s.submit('A', { kdType: 'move', data: {
			dir: { x: Math.sign(b0.x - a0.x), y: Math.sign(b0.y - a0.y) }, delta: 1, AllowInteract: true,
		} });
		s.submit('B', { kind: 'wait' });

		s.world.restorePlayer(s.bundles.get('A'));
		const opened = s.world.eval(`({
			dialogue: KDGameData.CurrentDialog || null,
			speaker: KDGameData.CurrentDialogMsgSpeaker || null,
			bindAmt: String((KDGameData.CurrentDialogMsgValue || {}).BINDAMNT),
		})`);
		s.world.restorePlayer(s.bundles.get('B'));
		const worn = s.world.eval(`KinkyDungeonAllRestraint().map(function(r){ return {
			name: r.name, struggleProgress: r.struggleProgress || 0 }; })`);
		return { opened, worn, willBefore, willAfter: (s.vitalsOf.get('B') || {}).will };
	}

	it('at war, walking into your peer opens no dialogue — the Untie option is unreachable', async () => {
		const r = await bumpPeer(true);
		expect(r.opened.dialogue, 'AC3: no dialogue opened, so there is no Untie to pick').toBeNull();
		// …and NOT because the input vanished. The same bump resolved as KD's stock attack, which is
		// what makes "no dialogue" a refusal rather than a silently dropped input.
		expect(r.willAfter, 'the bump WAS delivered — at war it lands as an attack')
			.toBeLessThan(r.willBefore);
		expect(r.worn, 'and B keeps every restraint')
			.toEqual([{ name: 'DuctTapeHands', struggleProgress: 0 }]);
	}, BOOT_TIMEOUT);

	it('CONTROL: at peace the SAME bump opens the ally dialogue with an untie budget ready', async () => {
		const r = await bumpPeer(false);
		expect(r.opened.dialogue, 'at peace the bump opens KD\'s ally dialogue').toBe('GenericAlly');
		expect(r.opened.speaker, '…on the peer\'s own avatar def').toMatch(/^RemotePlayer/);
		// `KDAllyDialogue`'s clickFunction has already computed the budget the Untie option is gated on
		// (KinkyDungeonDialogue.ts:639), so Untie is one click away rather than behind a further gate.
		expect(Number(r.opened.bindAmt), 'the untie budget is ready on arrival').toBeGreaterThan(0);
		// A talk is not an attack: speaking to a peer must not hurt them…
		expect(r.willAfter, 'talking to a peer must not hurt them').toBe(r.willBefore);
		// …and opening the dialogue is not yet an untie, which is what the Untie click adds.
		expect(r.worn, 'opening the dialogue alone unties nothing')
			.toEqual([{ name: 'DuctTapeHands', struggleProgress: 0 }]);
	}, BOOT_TIMEOUT);
});
