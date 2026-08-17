/**
 * KDM-193 PROBE — what actually lets a peer be tied in co-op?
 *
 * ⚠️ EARLIER VERSIONS OF THIS FILE ENCODED THE WRONG GATE and produced a wrong conclusion. They
 * checked `KinkyDungeonIsDisabled(t) || t.vulnerable > 0`, copied from the per-restraint quick-bind
 * table (`NPCRestrainList.ts:243`). That is NOT the gate the "Attempt to Tie" submenu uses.
 *
 * The real gate is `KDCanApplyBondage` (`KinkyDungeonEnemies.ts:11264`):
 *
 *     KinkyDungeonIsDisabled(target)
 *       || (!target.player && target.vulnerable && target.hp <= 0.5 * target.Enemy?.maxhp)
 *       || KDWillingBondage(target, player)
 *
 * The `vulnerable` branch ALSO requires hp <= 50% of maxhp — and the proxy resets a peer avatar's hp
 * to FULL every turn (`_armPeerEnemies` → `setAvatarEnemy`), because the avatar is a per-turn damage
 * GAUGE, not the peer's health. So on the server that branch is unreachable BY CONSTRUCTION.
 *
 * ⇒ `KinkyDungeonIsDisabled(target)` is the only route that can hold for a peer, which is exactly
 * what the proxy's disabled-state mirroring provides. Removing it removed co-op tying entirely
 * (owner UAT, 2026-08-17: "I am trying to use sub-menu 'attempt to tie'… it worked before, now
 * doesn't"). It was restored.
 *
 * This probe now evaluates the REAL gate, so it can never again be read as saying the vulnerability
 * route is available.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('KDM-193 probe — the REAL bondage gate on a peer avatar', () => {
	it('shows which branch of KDCanApplyBondage a peer can actually satisfy', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'bindability-real-gate', pvp: true });
		s.join('A');
		s.join('B');
		await s.ready();
		const avId = s.avatars.get('B');
		expect(avId, 'precondition: B must have an avatar').toBeTruthy();

		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');

		/** Evaluate KD's own gate, and each branch separately, on the peer avatar. */
		const gate = () => s.world.eval(`(function(){
			var e = KDMapData.Entities.find(function(en){ return en.id === ${avId | 0}; });
			if (!e) return null;
			var maxhp = (e.Enemy && e.Enemy.maxhp) || 0;
			return {
				hp: e.hp, maxhp: maxhp,
				hpBelowHalf: maxhp > 0 && e.hp <= 0.5 * maxhp,
				vulnerable: e.vulnerable || 0,
				stun: e.stun || 0,
				isDisabled: (typeof KinkyDungeonIsDisabled === 'function') ? !!KinkyDungeonIsDisabled(e) : null,
				canApplyBondage: (typeof KDCanApplyBondage === 'function' && typeof KDPlayer === 'function')
					? !!KDCanApplyBondage(e, KDPlayer()) : null
			};
		})()`);

		const armed = gate();

		// eslint-disable-next-line no-console
		console.log([
			'',
			'KDM-193 — KDCanApplyBondage branches on a peer avatar',
			'-'.repeat(68),
			'  ' + JSON.stringify(armed),
			'',
			'  hp <= 50% branch reachable? ' + armed.hpBelowHalf
				+ '   (the avatar hp is reset to FULL every turn — a damage gauge, not health)',
			'  IsDisabled branch          ' + armed.isDisabled,
			'  ⇒ KDCanApplyBondage        ' + armed.canApplyBondage,
			'',
		].join('\n'));

		// The structural fact that makes the vulnerability route a dead end for peers, asserted so it
		// cannot silently change: the avatar is armed at FULL hp, so the hp<=50% branch cannot hold.
		expect(armed.hp, 'precondition: the avatar is armed at full hp').toBe(armed.maxhp);
		expect(armed.hpBelowHalf,
			'the hp<=50% branch is unreachable for a peer — hp is a per-turn gauge, always full')
			.toBe(false);
	}, BOOT_TIMEOUT);
});
