/**
 * Node-layer (Vitest) tests for KD-094 (KD-073c) — peers-as-Enemy targeting.
 *
 * Design (user, 2026-06-21): in a PvP relationship two players see each other as a regular
 * Enemy faction, so STOCK attack mechanics originate the attack (nothing new). The client's
 * already-routed `doattack` reaches the server, which detects the target is a PvP-active peer's
 * avatar and routes it onto that peer's bundle (reusing KD-092's _applyPvP). PvP is per-pair.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-target-seed' });
	s.join('A');
	s.join('B');
	return s;
}

/** The avatar entity for `id` as seen in `viewer`'s composed snapshot. */
function peerInSnap(s: any, viewer: string, id: string) {
	const eid = s.avatars.get(id);
	return (s.snapshotFor(viewer).map.Entities || []).find((e: any) => e.id === eid) || null;
}

/** A issues a STOCK doattack at B's avatar (B waits); returns A's resolved result. */
function attackPeer(s: any) {
	const bEid = s.avatars.get('B');
	const bEnt = s.world.listEntities().find((e: any) => e.id === bEid);
	s.submit('A', { kdType: 'doattack', data: { tx: bEnt.x, ty: bEnt.y, id: bEid } });
	const r = s.submit('B', { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === 'A').result;
}

describe('PvP peers-as-Enemy targeting (KD-094)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('co-op: a peer renders as an ally (Player faction, not hostile)', () => {
		const b = peerInSnap(s, 'A', 'B');
		expect(b).toBeTruthy();
		expect(b.faction === 'Enemy').toBe(false);
		expect(b.hostile > 0).toBe(false);
	}, BOOT_TIMEOUT);

	it('PvP pair: each sees the other as Enemy faction in their snapshot', () => {
		s.setPvPPair('A', 'B', true);
		const bForA = peerInSnap(s, 'A', 'B');
		const aForB = peerInSnap(s, 'B', 'A');
		expect(bForA.faction).toBe('Enemy');
		expect(bForA.hostile > 0).toBe(true);
		expect(aForB.faction).toBe('Enemy');
	}, BOOT_TIMEOUT);

	it('a STOCK doattack at a PvP-active peer routes to the PvP apply (B takes the hit)', () => {
		s.setPvPPair('A', 'B', true);
		const r = attackPeer(s);
		expect(r.applied).toBe(true);
		expect(JSON.stringify(r.after)).not.toBe(JSON.stringify(r.before)); // B's vitals changed
	}, BOOT_TIMEOUT);

	it('co-op (no PvP pair): a peer-targeted doattack is NOT recognized as a PvP target', () => {
		// Without a PvP relationship the server does not route a doattack on the peer to PvP
		// (in the real browser the client can't even originate it — the peer is an ally).
		const bEid = s.avatars.get('B');
		expect(s._pvpTargetOf('A', { kdType: 'doattack', data: { id: bEid } }, 'doattack', { id: bEid })).toBeNull();
		// ...and once the pair IS in PvP, the same target IS recognized.
		s.setPvPPair('A', 'B', true);
		expect(s._pvpTargetOf('A', { kdType: 'doattack', data: { id: bEid } }, 'doattack', { id: bEid })).toBe('B');
	}, BOOT_TIMEOUT);
});
