/**
 * The `GenericAlly` dialogue offers many options besides `Untie` (recruit/dismiss, follow/stay AI
 * commands, shop, leash, feed, an out-of-band attack, the flirt/bondage minigame). Most of them are
 * NPC-only: they either do nothing for a co-op peer avatar (it is rebuilt from the real player every
 * turn, so a follow/stay flag, a leash or a tied-on restraint written onto it is gone by the next
 * turn) or actively misrepresent a real second player (recruiting your partner into your own party,
 * "feeding" hp that is not theirs, attacking outside the real PvP arm). `Untie` and `Leave` are the
 * two that still make sense for a human partner.
 *
 * `HeadlessHost.installPeerAllyDialogueGuard` hides the rest the KD-native way: it wraps each
 * hidden option's own `prerequisiteFunction`, the exact gate KD's own dialogue renderer calls per
 * entry before drawing a button (`KDCheckDialoguePrereq`, `KinkyDungeonDialogue.ts:80-90,169`). This
 * drives the dialogue through the SAME entry point (`KDStartDialog`, `Click: true`) every real open
 * uses, then reads which options KD itself would currently offer — so a wrapper that only looked
 * right in isolation (e.g. one that always hid `Untie` too) would be caught here, same as the
 * control below catches a wrapper that hid everyone's options, not just a peer's.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** The full set of options the engine-native guard targets. */
const HIDDEN_FOR_PEER = ['Leash', 'ReleaseLeash', 'Shop', 'ShopBuy', 'Attack', 'AttackPlay',
	'AttackUnaware', 'Food', 'JoinParty', 'Flirt', 'LetMePass', 'StopFollowingMe', 'FollowMe',
	'DontStayHere', 'StayHere', 'Aggressive', 'Defensive', 'HelpMe', 'HelpMeCommandWord',
	'HelpMeKey', 'DontHelpMe', 'RemoveParty'];

/**
 * Open `GenericAlly` on `enemyId` for real (same `KDStartDialog` entry point a real click or the
 * dialogue-input path uses, `Click: true` so the dialogue's own `clickFunction` computes the untie
 * budget), then read which top-level options KD's OWN prerequisite check currently allows.
 */
function visibleOptionsOf(s: any, enemyId: number): string[] {
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${enemyId | 0}; });
		if (!e) return null;
		KDStartDialog('GenericAlly', e.Enemy.name, true, '', e);
		var opts = KDDialogue.GenericAlly.options;
		var gagged = false, player = KinkyDungeonPlayerEntity;
		var out = [];
		for (var k in opts) {
			var entry = opts[k];
			if (!entry.prerequisiteFunction || entry.prerequisiteFunction(gagged, player)) out.push(k);
		}
		return out;
	})()`);
}

/** Same primitive `mp-peer-avatar-interact-guard.spec.ts` uses to inject a real entity directly. */
function spawnEntityDirect(s: any, x: number, y: number, type: string): { id: number, name: string } {
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
	if (!out) throw new Error(`setup invalid: failed to spawn ${type} at (${x},${y})`);
	return out;
}

/** A real recruited ally (`KDAddToParty`), the control — not a peer avatar, so nothing should hide. */
function recruitedAllyAt(s: any, x: number, y: number, type: string): { id: number, name: string } {
	const spawned = spawnEntityDirect(s, x, y, type);
	const ok = s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(en){ return en.id === ${spawned.id}; });
		if (!e || typeof KDAddToParty !== 'function') return false;
		return !!KDAddToParty(e);
	})()`);
	if (!ok) throw new Error('setup invalid: KDAddToParty did not accept the summoned ally');
	return spawned;
}

describe('GenericAlly options are hidden for a peer avatar, not for a real recruited ally', () => {
	it('a bound peer avatar offers Untie and Leave, and none of the NPC-only options', async () => {
		const s: any = new SwapSession({
			requiredPlayers: 2, seed: 'peer-ally-options-bound', pvp: false, wearRestraint: 'DuctTapeHands',
		});
		s.join('A');
		s.join('B');
		await s.ready();

		const avB = s.avatars.get('B');
		s.world.restorePlayer(s.bundles.get('B'));
		expect(s.world.getVitals().bondage, 'precondition: B carries some bondage power').toBeGreaterThan(0);
		s.vitalsOf.set('B', s.world.getVitals());

		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');   // mirrors B's bondage onto the avatar (peace-safe: see its own doc comment)

		const visible = visibleOptionsOf(s, avB);
		expect(visible, 'setup invalid: dialogue did not open').toBeTruthy();

		expect(visible).toContain('Leave');
		expect(visible, 'bound, so the untie budget is > 0').toContain('Untie');
		for (const key of HIDDEN_FOR_PEER) {
			expect(visible, `${key} must be hidden for a peer avatar`).not.toContain(key);
		}
	}, BOOT_TIMEOUT);

	it('CONTROL: a real recruited ally still offers its normal (non-peer) option set', async () => {
		// Without this, "every NPC-only option is absent" above would pass just as well if the guard
		// blanket-suppressed those options for EVERYONE, peer or not.
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'peer-ally-options-control', pvp: false });
		s.join('A');
		s.join('B');
		await s.ready();

		const nb = { x: s.posOf('A').x, y: s.posOf('A').y };
		const ally = recruitedAllyAt(s, nb.x, nb.y, 'WitchFlame');
		expect(ally.name.indexOf('RemotePlayer'), 'sanity: this is not a peer avatar').toBe(-1);

		const visible = visibleOptionsOf(s, ally.id);
		expect(visible, 'setup invalid: dialogue did not open').toBeTruthy();

		// A real recruited ally is already in the party, so `JoinParty` itself correctly no longer
		// applies (KDIsInParty gate) — but options that have NOTHING to do with party membership, and
		// would only ever be hidden by a peer-avatar guard, must still be offered.
		expect(visible, 'stock KD still offers StopFollowingMe for an ordinary allied party member').toContain('StopFollowingMe');
		expect(visible, 'and the real party-member counterpart to JoinParty').toContain('RemoveParty');
		expect(visible).toContain('Leave');
	}, BOOT_TIMEOUT);
});
