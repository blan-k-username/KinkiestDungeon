/**
 * KDM-200 — the snapshot must carry the fields KD's OWN gate reads.
 *
 * THE BUG THIS EXISTS FOR. The tie submenu evaluates `KDCanApplyBondage` in the BROWSER, against the
 * client's copy of the peer avatar. `serializeRenderState` copies entity fields through a whitelist
 * (`ENT_FIELDS`), and that whitelist omitted `stun`, `freeze`, `vulnerable` and `specialBoundLevel` —
 * precisely the fields the gate reads. So the server could compute "this peer is subdued" perfectly
 * and the client would never know: three successive server-side fixes had NO observable effect.
 *
 * The old code hid the omission by stamping `ent.stun = 6` onto the snapshot AFTER serialisation,
 * bypassing the whitelist. Removing that stamping (rightly — it was an invented rule) made the gap
 * visible for the first time.
 *
 * The lesson generalises past this bug: a wire whitelist is a silent truncation. When the receiver
 * runs the game's own predicates, the wire must carry what those predicates read, or the two sides
 * disagree and every fix lands on the wrong one.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

describe('KDM-200 — gate-relevant entity state must survive serialisation', () => {
	it('carries stun / vulnerable / boundLevel for a peer avatar to the client', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'wire-fields', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
		const eid = s.avatars.get('B');

		// Put the avatar into a state the gate cares about, using the game's own fields.
		s.world.restorePlayer(s.bundles.get('A'));
		s._armPeerEnemies('A');
		s.world.setAvatarVulnerable(eid, true);
		s.world.setAvatarBondage(eid, 5);
		s.world.eval(`(function(){ var e=KDMapData.Entities.find(function(x){return x.id===${eid};});
			if (e) e.stun = 3; })()`);

		const snap = s.snapshotFor('A');
		const ent = ((snap.map && snap.map.Entities) || []).find((e: any) => e.id === eid);
		expect(ent, 'precondition: the peer avatar must be in the snapshot').toBeTruthy();

		// PRECONDITION — the world really holds these, so a missing field is a WIRE fault, not a
		// state fault. Without this the test could pass by asserting nothing was ever set.
		const world = s.world.eval(`(function(){ var e=KDMapData.Entities.find(function(x){return x.id===${eid};});
			return { stun: e.stun || 0, vulnerable: e.vulnerable || 0, boundLevel: e.boundLevel || 0 }; })()`);
		expect(world.stun, 'precondition: the world avatar is stunned').toBeGreaterThan(0);
		expect(world.vulnerable, 'precondition: the world avatar is vulnerable').toBeGreaterThan(0);
		expect(world.boundLevel, 'precondition: the world avatar is bound').toBeGreaterThan(0);

		// eslint-disable-next-line no-console
		console.log('\nKDM-200 wire check — world: ' + JSON.stringify(world)
			+ '\n                     wire:  ' + JSON.stringify({
				stun: ent.stun, vulnerable: ent.vulnerable, boundLevel: ent.boundLevel,
				enemyName: ent.enemyName, hp: ent.hp }) + '\n  FULL: ' + JSON.stringify(ent) + '\n');

		for (const f of ['stun', 'vulnerable', 'boundLevel']) {
			expect(ent[f], `the snapshot must carry "${f}" — the client's KDCanApplyBondage reads it`)
				.toBeGreaterThan(0);
		}
		// The client re-links Enemy defs by name, and the gate divides by Enemy.maxhp.
		expect(ent.Enemy && ent.Enemy.maxhp, 'the gate divides by Enemy.maxhp, so it must reach the client')
			.toBeTruthy();
	}, BOOT_TIMEOUT);

	/**
	 * THE TEST EVERY PREVIOUS FIX WAS MISSING.
	 *
	 * The tie submenu runs `KDCanApplyBondage` in the BROWSER, on the snapshot entity. Three fixes in a
	 * row were verified against the SERVER's world object and had no effect in play, because the two
	 * are different objects and only the wire connects them. So: feed the snapshot entity back into
	 * KD's own gate and assert on THAT.
	 */
	it('a DEFEATED peer passes KDCanApplyBondage as evaluated on the SNAPSHOT entity', async () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'wire-gate', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();

		const gateOnWire = (victim: string, actor: string) => {
			const snap = s.snapshotFor(actor);
			const ent = ((snap.map && snap.map.Entities) || [])
				.find((e: any) => e.id === s.avatars.get(victim));
			if (!ent) return { missing: true };
			// Evaluate KD's OWN gate against the object the client would hold.
			s.world.restorePlayer(s.bundles.get(actor));
			return s.world.eval('(function(){ var e = ' + JSON.stringify(ent) + ';'
				+ ' return { hp: e.hp, maxhp: e.Enemy && e.Enemy.maxhp, vulnerable: e.vulnerable || 0,'
				+ '   can: (typeof KDCanApplyBondage === "function" && typeof KDPlayer === "function")'
				+ '     ? !!KDCanApplyBondage(e, KDPlayer()) : null }; })()');
		};

		const healthy = gateOnWire('B', 'A');
		expect(healthy.can, 'a healthy opponent must not be tie-able on the wire either').toBe(false);

		s.world.restorePlayer(s.bundles.get('B'));
		s.world.setWill(0);
		s.bundles.set('B', s.world.capturePlayer());
		s.vitalsOf.set('B', s.world.getVitals());
		s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' });
		expect(s.isDefeated('B'), 'precondition: B must really be defeated').toBe(true);

		const down = gateOnWire('B', 'A');
		// eslint-disable-next-line no-console
		console.log('\nKDM-200 gate on the WIRE entity: ' + JSON.stringify(down) + '\n');
		expect(down.vulnerable, 'a defeated peer must reach the client marked exposed').toBeGreaterThan(0);
		expect(down.hp, 'and reading as worn down, from their real Will')
			.toBeLessThanOrEqual(0.5 * down.maxhp);
		expect(down.can, "the CLIENT's own KDCanApplyBondage must allow the tie").toBe(true);
	}, BOOT_TIMEOUT);
});
