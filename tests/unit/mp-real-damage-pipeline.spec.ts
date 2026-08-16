/**
 * KDM-164 — peer damage goes through KD's REAL player pipeline, not our arithmetic.
 *
 * Today a PvP hit lands on the victim's AVATAR (the entity pipeline, `KinkyDungeonDamageEnemy`), and
 * the server then converts the avatar's hp loss into Will by hand: `dmg = ARM_HP − hp`, `Will -= dmg`
 * (`swap-session.js`). That conversion is the invented model — it is a seam stitching KD's two damage
 * pipelines together with arithmetic the game does not have, it discards the damage TYPE entirely, and
 * it bypasses the victim's own resistances. It is also what caused the KDM-156 potion bug.
 *
 * Measured in the POC (`KDM-164/probes/poc-final.spec.ts`): the real chain is
 * `KinkyDungeonMove → KDDoAttack → KinkyDungeonAttackEnemy → KinkyDungeonDamageEnemy → KDDamageEnemy`,
 * the damageInfo arrives intact as `{damage, type}`, the call is NOT inside KD's enemy loop, and
 * `KinkyDungeonDealDamage` — the game's real PLAYER damage pipeline — is called ZERO times for a PvP
 * hit. That zero is the defect.
 *
 * ⚠️ Probe counters must live ON THE WRAPPER FUNCTION. `restorePlayer` resets globals to their
 * post-init baseline every turn, so a plain `globalThis.__x` counter reads as zero afterwards and makes
 * a live wrap look as though it were never called.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Install a call-recorder on the game's real PLAYER damage pipeline. */
const RECORDER = `
	(function () {
		var _deal = KinkyDungeonDealDamage;
		KinkyDungeonDealDamage = function (D) {
			var w = KinkyDungeonDealDamage;
			w.__calls = (w.__calls || 0) + 1;
			w.__seen = (w.__seen || '') + JSON.stringify({ damage: D && D.damage, type: D && D.type }) + ';';
			return _deal.apply(this, arguments);
		};
		KinkyDungeonDealDamage.__calls = 0;
		KinkyDungeonDealDamage.__seen = '';
	})();
`;

describe('KDM-164 — PvP damage uses the real player pipeline', () => {
	let s: any;

	beforeEach(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm164-real', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		s.world.loadMod(RECORDER);
		// A acts first, so B's avatar is still where we put it when A swings. With random order the
		// peer's own turn re-syncs its avatar back and silently undoes the setup (same mechanism as the
		// KDM-163 mp-coop-demo flake).
		s._shuffle = () => ['A', 'B'];
	}, BOOT_TIMEOUT);

	/** Put B's avatar directly below A and have A bump-attack it. */
	function bumpB() {
		const a = s.posOf('A');
		s.world.moveAvatar(s.avatars.get('B'), a.x, a.y + 1);
		s.submit('A', { kdType: 'move', data: { dir: { x: 0, y: 1 }, delta: 1, AllowInteract: true } });
		s.submit('B', { kind: 'wait' });
	}
	const dealt = () => JSON.parse(s.world.eval(
		'JSON.stringify({calls: KinkyDungeonDealDamage.__calls || 0, seen: KinkyDungeonDealDamage.__seen || ""})'));

	it('a peer hit reaches the victim through KinkyDungeonDealDamage', () => {
		const before = s.vitalsFor('B').will;
		bumpB();
		expect(s.vitalsFor('B').will, 'the hit must still cost the victim Will').toBeLessThan(before);
		expect(dealt().calls, "the game's real player-damage pipeline must carry the hit").toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('the damage TYPE survives — it is not flattened to a bare number', () => {
		bumpB();
		expect(dealt().seen, 'the real damage type must reach the victim, not be discarded')
			.toMatch(/"type":"[a-z]+"/);
	}, BOOT_TIMEOUT);

	/** AC1: the invented constants and the synthetic primitive are gone. */
	it('AC1: no invented combat constants remain in the MP layer', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src = require('fs').readFileSync(require.resolve('../../tools/mp-server/swap-session.js'), 'utf8');
		const code = src.split('\n').filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
		expect(code, 'DEFEAT_WILL is an invented threshold').not.toMatch(/\bDEFEAT_WILL\b/);
		expect(code, 'REVIVE_WILL_FRACTION is an invented hysteresis').not.toMatch(/\bREVIVE_WILL_FRACTION\b/);
		expect(code, '_armHp is the damage-gauge representation').not.toMatch(/\b_armHp\b/);
		expect(code, '_applyPvP bypasses the real pipeline').not.toMatch(/\b_applyPvP\b/);
	}, BOOT_TIMEOUT);

	/**
	 * KDM-156 forever-regression: the gauge must not re-charge. A hit is applied ONCE; a later heal
	 * must stick instead of being wiped by a stale hit re-read every turn.
	 */
	it('KDM-156: a hit is charged once and a later heal is not wiped', () => {
		bumpB();
		const afterHit = s.vitalsFor('B').will;
		// no further attacks — just quiet turns
		for (let i = 0; i < 3; i++) { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
		expect(s.vitalsFor('B').will, 'a hit must not be re-charged on later turns')
			.toBeGreaterThanOrEqual(afterHit - 1e-6);
	}, BOOT_TIMEOUT);
});
