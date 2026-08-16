/**
 * Node-layer (Vitest) tests for the PvP RENDER-STATE mappings (KD-098), kept after the KD-100
 * real-combat rework removed the synthetic feedback/bump/defeat path. Gameplay (real damage, real
 * messages, real defeat) is covered by `mp-pvp-realcombat.spec.ts`. Here we only assert the
 * render-state the client draws from:
 *   - the peer's overhead HP bar tracks their REAL Will (avatar hp in the snapshot = Will fraction),
 *   - snapshot entities render at their authoritative tile (visual_x/y == x/y — no stale-ease teleport).
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

describe('PvP render-state mappings (KD-098)', () => {
	let s: any;
	beforeEach(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-render-seed', pvp: true });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	/** A walks into B (real bump-attack) to drain B's Will; B waits. */
	function bumpB(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		sess.submit('B', { kind: 'wait' });
	}
	function peerAvatarInAsView(sess: any) {
		const eid = sess.avatars.get('B');
		const ent = ((sess.snapshotFor('A').map || {}).Entities || []).find((e: any) => e.id === eid);
		return ent ? { hp: ent.hp, maxhp: (ent.Enemy && ent.Enemy.maxhp) || 100 } : null;
	}

	it('snapshot entities render at their real tile (visual==x/y) — no stale-ease teleport', () => {
		for (let i = 0; i < 3; i++) { s.submit('A', { kind: 'wait' }); s.submit('B', { kind: 'wait' }); }
		const ents = (s.snapshotFor('A').map || {}).Entities || [];
		expect(ents.length).toBeGreaterThan(0);
		for (const e of ents) {
			expect(e.visual_x).toBe(e.x);
			expect(e.visual_y).toBe(e.y);
		}
	}, BOOT_TIMEOUT);

	it("the peer's HP bar tracks their real Will fraction, not a static 100", () => {
		const before = peerAvatarInAsView(s);
		expect(before).not.toBeNull();
		const willBefore = s.vitalsFor('B').will;

		bumpB(s); bumpB(s);   // wear B's Will down with real hits

		const after = peerAvatarInAsView(s);
		const willAfter = s.vitalsFor('B').will;
		const willMax = s.vitalsFor('B').willMax;

		expect(willAfter).toBeLessThan(willBefore);
		expect(after!.hp).toBeLessThan(before!.hp);
		expect(after!.hp / after!.maxhp).toBeCloseTo(willAfter / willMax, 1);
	}, BOOT_TIMEOUT);
});
