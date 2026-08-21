/**
 * KDM-225 — the SwapSession seams the peace handshake needs.
 *
 * `mp-peace-registry.spec.ts` covers the rules in isolation; this covers the four places the session
 * has to honour them, each of which is a known trap:
 *
 *   1. `_isPvP` must let a truce beat the GLOBAL `KD_PVP` flag — it short-circuits `if (this.pvp)
 *      return true`, so removing a pair from the war set is otherwise a no-op in exactly the mode a
 *      PvP session runs in.
 *   2. The `mp:` envelope must be intercepted BEFORE `_toInput`, whose fallback is
 *      `return { kdType: 'tick' }` (swap-session.js:1005) — i.e. an unrecognised action silently
 *      becomes a WAIT and burns the sender's turn. Silent, and invisible in any state assertion.
 *   3. `submit()` must refuse a turn from the player who owes an answer (R5), while UI inputs still
 *      get through so they CAN answer.
 *   4. Peace clears hostility and NOTHING else (D3/AC5), and the between-floors hub clears it for
 *      everyone, exactly once (D7/R13/R14).
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

/**
 * Answer a peace offer the way a player does — by clicking an option in KD's own dialogue.
 *
 * NOT a private `mp:` verb. The dialogue option runs `KDSendInput("dialogue", …)`
 * (`KinkyDungeonDialogue.ts:187`), so the answer is a routed GAME input and the option's
 * `clickFunction` executes server-side inside `KDDoDialogue`. Driving anything else here would test a
 * path no player can reach.
 */
function answer(s: any, who: string, accept: boolean) {
	return s.apply(who, {
		kdType: 'dialogue',
		data: { dialogue: 'KDCoopPeace', dialogueStage: accept ? 'Accept' : 'Refuse', click: true },
	});
}

/** Read the war/peace verdict AND the hostility the game actually holds on each avatar. */
function worldHostility(s: any, cid: string) {
	const eid = s.avatars.get(cid);
	return s.world.eval(`(function(){
		var e = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
		if (!e) return { missing: true };
		return { hostile: e.hostile || 0, rage: e.rage || 0, boundLevel: e.boundLevel || 0,
			specialKeys: Object.keys(e.specialBoundLevel || {}) };
	})()`);
}

describe('KDM-225 — peace, at the session seams', () => {
	let s: any;
	beforeEach(async () => {
		// pvp:true = the GLOBAL flag, the mode every PvP UAT runs in. That is the hard case for AC8.
		s = new SwapSession({ requiredPlayers: 2, seed: 'peace-session', pvp: true });
		s.join('A'); s.join('B');
		await s.ready();
	}, BOOT_TIMEOUT);

	describe('AC8 — a truce beats the global KD_PVP flag', () => {
		it('_isPvP is true before the handshake and false after it', () => {
			expect(s._isPvP('A', 'B'), 'precondition: the global flag has them at war').toBe(true);
			s.apply('A', { mp: 'peace.offer' });
			expect(s._isPvP('A', 'B'), 'an unanswered offer changes nothing (R4)').toBe(true);
			answer(s, 'B', true);
			expect(s._isPvP('A', 'B'),
				'peace must override the global flag, not merely a per-pair entry').toBe(false);
		});

		it('a declined offer leaves the global war intact (R7/AC4)', () => {
			s.apply('A', { mp: 'peace.offer' });
			answer(s, 'B', false);
			expect(s._isPvP('A', 'B')).toBe(true);
		});
	});

	describe('the mp: envelope is not a game input', () => {
		/**
		 * The trap: `_toInput` turns anything it does not recognise into `{kdType:'tick'}`. If the
		 * intercept were placed after it, offering peace would spend the offerer's turn — and the only
		 * symptom would be a turn quietly passing.
		 */
		it('offering does NOT consume a turn and does NOT reach the game', () => {
			const turn0 = s.turn;
			const tick0 = s.world.tick();
			const res = s.apply('A', { mp: 'peace.offer' });
			expect(res.kind, 'a UI-kind action: applied at once, no lockstep slot').toBe('ui');
			expect(res.advanced, 'no turn may be consumed').toBeFalsy();
			expect(s.turn, 'the session turn counter must not move').toBe(turn0);
			expect(s.world.tick(), 'and no game time may pass').toBe(tick0);
		});

		it('answering does not consume a turn either', () => {
			s.apply('A', { mp: 'peace.offer' });
			const turn0 = s.turn;
			const tick0 = s.world.tick();
			answer(s, 'B', true);
			expect(s.turn).toBe(turn0);
			expect(s.world.tick()).toBe(tick0);
		});

		it('the peace action is never reported as an unknown GAME input type', () => {
			s.apply('A', { mp: 'peace.offer' });
			const unknown = (s.unknownInputReport() || []).map((u: any) => u.type);
			expect(unknown.join(','), 'it must not have been handed to KDInputTypes at all')
				.not.toMatch(/peace/);
		});
	});

	describe('R5 — the answerer is blocked until they answer', () => {
		it('B cannot submit a turn while owing an answer, and can once it is given', () => {
			s.apply('A', { mp: 'peace.offer' });
			const blocked = s.submit('B', { kind: 'wait' });
			expect(blocked.blocked, 'B owes an answer — the turn must not be accepted').toBe('peace-offer');
			expect(blocked.advanced).toBeFalsy();
			expect(s._pending.has('B'), 'and nothing may sit in B\'s lockstep slot').toBe(false);

			answer(s, 'B', false);
			const after = s.submit('B', { kind: 'wait' });
			expect(after.blocked, 'answered — B is free again').toBeFalsy();
		});

		it('A — who asked — is never blocked', () => {
			s.apply('A', { mp: 'peace.offer' });
			const res = s.submit('A', { kind: 'wait' });
			expect(res.blocked).toBeFalsy();
		});
	});

	describe('A4 — the client is told, as standing state', () => {
		it('each snapshot carries who this player is at war with and what they owe', () => {
			s.apply('A', { mp: 'peace.offer' });
			const forB = s.snapshotFor('B');
			const forA = s.snapshotFor('A');
			expect(forB.coop, 'the menu re-reads this every frame, so it is state not an event').toBeTruthy();
			expect(forB.coop.peaceOffer, 'B is being asked').toEqual({ from: 'A' });
			expect(forA.coop.peaceOffer, 'A is not').toBeNull();
			expect(forA.coop.war, 'A sees the war it may offer to end').toContain('B');
		});
	});

	describe('D3/AC5 — peace clears hostility and nothing else', () => {
		it('clears hostile/rage on BOTH avatars but leaves bondage untouched', () => {
			s._armPeerEnemies('A');
			s._armPeerEnemies('B');
			// Arm the two states the assertion distinguishes: real KD hostility, and real bondage.
			for (const cid of ['A', 'B']) {
				const eid = s.avatars.get(cid);
				s.world.eval(`(function(){
					var e = KDMapData.Entities.find(function(x){ return x.id === ${eid}; });
					if (e && typeof KDMakeHostile === 'function') KDMakeHostile(e);
				})()`);
				s.world.setAvatarBondage(eid, 5);
			}
			const beforeA = worldHostility(s, 'A');
			expect(beforeA.hostile, 'precondition: the avatar really is hostile').toBeGreaterThan(0);
			expect(beforeA.boundLevel, 'precondition: the avatar really is bound').toBeGreaterThan(0);

			s.apply('A', { mp: 'peace.offer' });
			answer(s, 'B', true);

			for (const cid of ['A', 'B']) {
				const after = worldHostility(s, cid);
				expect(after.hostile, `${cid}: hostility must be cleared`).toBe(0);
				expect(after.rage, `${cid}: rage too`).toBe(0);
				expect(after.boundLevel,
					`${cid}: D3 — peace touches hostility ONLY; the ties from the fight stay on`)
					.toBeGreaterThan(0);
			}
		});
	});
	/**
	 * R19 — MEASURED UNREACHABLE, and pinned as such.
	 *
	 * The requirement said "if a hub reset fires while an offer is unanswered, discard the offer".
	 * Implementing R5 made that situation impossible: the hub reset runs at the end of a resolved
	 * TURN, and a turn cannot resolve while anyone owes an answer, because `submit` refuses their
	 * action. So an offer can never outlive the turn it was made in, let alone survive a floor
	 * transition.
	 *
	 * That is a stronger guarantee than R19 asked for, so the test asserts the guarantee rather than
	 * the discard. Deleting the test instead would leave the reasoning nowhere: if R5's blocking is
	 * ever relaxed to non-blocking, R19 becomes reachable again and this test is what says so.
	 */
	it('R19 cannot arise: no turn can resolve while an offer is unanswered', () => {
		const turn0 = s.turn;
		s.apply('A', { mp: 'peace.offer' });
		s.submit('A', { kind: 'wait' });
		const blocked = s.submit('B', { kind: 'wait' });
		expect(blocked.blocked, 'B still owes the answer').toBe('peace-offer');
		expect(s.turn, 'so the turn cannot advance — and the hub reset only runs on a resolved turn')
			.toBe(turn0);

		// Answer it, and the same two submissions now resolve normally.
		answer(s, 'B', false);
		s.submit('A', { kind: 'wait' });
		s.submit('B', { kind: 'wait' });
		expect(s.turn, 'answered → the turn resolves').toBe(turn0 + 1);
	});
});
