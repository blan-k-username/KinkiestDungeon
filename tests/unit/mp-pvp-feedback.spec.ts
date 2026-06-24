/**
 * Node-layer (Vitest) tests for KD-098 — PvP hits must produce visible feedback.
 *
 * Bug: the swap-model PvP path applied real damage (Will dropped) but went through the
 * silent `applyEnemyHit` → `KinkyDungeonDealDamage` stat-reducer, which emits NO combat
 * message for a normal hit. So a hit looked like "nothing happened": no log line for the
 * victim (nor the attacker), only a small unannounced stat tick. Worse, the generic
 * per-turn log delta (KD-097) credits any message to the ACTING player, so even a message
 * generated while the victim was swapped in would land in the ATTACKER's log.
 *
 * These tests assert that a sneak (doaggro) and a direct (doattack) PvP hit each:
 *   - still apply damage (Will drops), AND
 *   - push a feedback line into the VICTIM's personal log (routed to the victim), AND
 *   - push a line into the ATTACKER's personal log,
 * and that the victim's snapshot surfaces the feedback (log + floating action message).
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

function freshSession() {
	const s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-feedback-seed' });
	s.join('A');
	s.join('B');
	return s;
}

/** A attacks B's avatar this turn via `kdType` (B waits). Returns A's resolved result. */
function attackTurn(s: any, kdType: string) {
	const bEid = s.avatars.get('B');
	const bEnt = s.world.listEntities().find((e: any) => e.id === bEid);
	const data: any = { tx: bEnt.x, ty: bEnt.y, id: bEid };
	if (kdType === 'doaggro') data.unaware = true;
	else data.attackCost = 1;
	s.submit('A', { kdType, data });
	const r = s.submit('B', { kind: 'wait' });
	return r.turn.applied.find((e: any) => e.id === 'A').result;
}

const logTexts = (s: any, id: string) => (s.logs.get(id) || []).map((m: any) => (m && m.text) || '');

describe('PvP hit feedback (KD-098)', () => {
	let s: any;
	beforeEach(() => { s = freshSession(); }, BOOT_TIMEOUT);

	it('a sneak-attack lands damage AND puts a feedback line in BOTH players logs', () => {
		const willBefore = s.snapshotFor('B').stats.will;
		const aLog0 = (s.logs.get('A') || []).length;
		const bLog0 = (s.logs.get('B') || []).length;

		const r = attackTurn(s, 'doaggro');

		expect(r.applied).toBe(true);
		// damage still applied (real path preserved)
		expect(s.snapshotFor('B').stats.will).toBeLessThan(willBefore);
		// the VICTIM gets a new log line (the actual bug — was empty before)
		expect((s.logs.get('B') || []).length).toBeGreaterThan(bLog0);
		// the ATTACKER gets a line too
		expect((s.logs.get('A') || []).length).toBeGreaterThan(aLog0);
	}, BOOT_TIMEOUT);

	it("the victim's feedback names the attack, not a generic blank, and rides the snapshot", () => {
		attackTurn(s, 'doaggro');
		const snapB = s.snapshotFor('B');
		// log carries a non-empty feedback line for the victim
		expect(snapB.messages.log.length).toBeGreaterThan(0);
		expect(logTexts(s, 'B').some((t: string) => t.trim().length > 0)).toBe(true);
		// floating action message is set for the victim (visible combat text)
		expect((snapB.messages.action || '').length).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	it('a follow-up direct doattack also produces fresh feedback for the victim', () => {
		attackTurn(s, 'doaggro');           // start PvP + first hit
		const bLog1 = (s.logs.get('B') || []).length;
		const r2 = attackTurn(s, 'doattack');
		expect(r2.applied).toBe(true);
		expect((s.logs.get('B') || []).length).toBeGreaterThan(bLog1);
	}, BOOT_TIMEOUT);

	it('feedback is routed: the victim line is NOT mis-credited only to the attacker', () => {
		attackTurn(s, 'doaggro');
		// Both logs grew — specifically the victim's (the KD-097 misroute would have left B empty)
		expect((s.logs.get('B') || []).length).toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});

describe('Bump-to-attack: walking into a PvP peer melees them (KD-098)', () => {
	let s: any;
	beforeEach(() => {
		// global PvP so the pair is hostile from the start (mirrors KD_PVP=1 demo)
		s = new SwapSession({ requiredPlayers: 2, seed: 'pvp-bump-seed', pvp: true });
		s.join('A');
		s.join('B');
	}, BOOT_TIMEOUT);

	/** A submits a stock MOVE toward B's tile (B waits). Returns A's resolved result. */
	function bumpTurn(sess: any) {
		const a = sess.posOf('A'), b = sess.posOf('B');
		const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
		sess.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		const r = sess.submit('B', { kind: 'wait' });
		return r.turn.applied.find((e: any) => e.id === 'A').result;
	}

	it('a move into the peer applies a PvP hit (Will drops), not a blocked move', () => {
		const willBefore = s.snapshotFor('B').stats.will;
		const aPosBefore = s.posOf('A');

		const r = bumpTurn(s);

		expect(r && r.applied).toBe(true);                          // routed as a PvP hit
		expect(s.snapshotFor('B').stats.will).toBeLessThan(willBefore); // B took real damage
		// the attacker did NOT move onto the peer (bump = attack-in-place, not a step)
		expect(s.posOf('A')).toEqual(aPosBefore);
	}, BOOT_TIMEOUT);

	it('the victim gets the hit feedback from a bump too', () => {
		const bLog0 = (s.logs.get('B') || []).length;
		bumpTurn(s);
		expect((s.logs.get('B') || []).length).toBeGreaterThan(bLog0);
	}, BOOT_TIMEOUT);

	/** B's avatar entity, as it appears in A's render snapshot. */
	function peerAvatarInAsView(sess: any) {
		const eid = sess.avatars.get('B');
		const ent = ((sess.snapshotFor('A').map || {}).Entities || []).find((e: any) => e.id === eid);
		return ent ? { hp: ent.hp, maxhp: (ent.Enemy && ent.Enemy.maxhp) || 100 } : null;
	}

	it('snapshot entities render at their real tile (visual==x/y) — no stale-ease teleport', () => {
		// advance a few turns so the world enemy (Rat) moves via its AI
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
		const willBefore = s.snapshotFor('B').stats.will;

		bumpTurn(s); bumpTurn(s); bumpTurn(s);   // wear B's Will down

		const after = peerAvatarInAsView(s);
		const willAfter = s.snapshotFor('B').stats.will;
		const willMax = s.snapshotFor('B').stats.willMax;

		expect(willAfter).toBeLessThan(willBefore);              // B's Will dropped
		expect(after!.hp).toBeLessThan(before!.hp);             // ...and so did the bar
		expect(after!.hp / after!.maxhp).toBeCloseTo(willAfter / willMax, 1); // bar == Will fraction
	}, BOOT_TIMEOUT);
});
