/**
 * KDM-253 — wait or continue solo: the host's choice, and a clean goodbye.
 *
 * The last slice of KDM-234. KDM-250 detects the drop, KDM-251 pauses honestly, KDM-252 brings the
 * peer back — this one covers the case where they do not come back, and gives the host a decision
 * instead of an indefinite wait they never chose.
 *
 * ⚠️ THE ABSENCE ORACLES ARE THE DANGEROUS PART. Every "no X survives the teardown" assertion goes
 * green on a test that removed nothing, on a session that never had an X, and on a query that was
 * looking in the wrong place. So each one here is paired with a **same-shape control taken before
 * the removal**, using the identical query — if the control does not find it, the test fails for
 * asking the wrong question rather than passing for the wrong reason.
 *
 * ⚠️ AND THE SWEEP IS THE POINT. `SwapSession` carries THIRTEEN per-client containers and `join()`
 * only ever pushed — nothing had ever been removed from any of them. A test that checked the seven
 * the ticket happened to name would be wrong the day a fourteenth is added, silently. So the
 * headline case walks the live session generically and demands that NOTHING reachable from it still
 * keys the departed player.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-253 (EARS text in KDM-234).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	KD_DISCONNECT_DIALOGUE, HOST_LOST_DIALOGUE, PEER_LOST_DIALOGUE,
} = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT_TIMEOUT = 240_000;

const isState = (m: any) => m.type === 'state';
const isWaiting = (m: any) => m.type === 'waiting';
const isMissing = (m: any) => m.type === 'peer_missing';

/**
 * Answer one of OUR dialogues the way the real client does — KD's own routed `dialogue` input.
 *
 * ⚠️ The option travels as `dialogueStage`, with `click: true` (`KinkyDungeonDialogue.ts:187`). An
 * earlier version of this helper sent `{ option }`, which KD ignores — so the click never ran, no
 * flag was ever set, and the "choosing Wait changes nothing" case below passed while doing literally
 * nothing. That is why that case now asserts the dialogue CLOSED as well: "nothing changed" and "the
 * answer never arrived" are otherwise the same green.
 */
function answerDialogue(dialogue: string, option: string) {
	return { type: 'input', action: { kdType: 'dialogue', data: { dialogue, dialogueStage: option, click: true } } };
}

/** Whatever dialogue this player's bundle currently has open, or ''. */
function dialogueOf(session: any, clientId: string): string {
	session.world.restorePlayer(session.bundles.get(clientId));
	return session.world.eval(
		`(typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : ''`,
	);
}

/**
 * Every container reachable from the session that is keyed by clientId, found by SHAPE rather than
 * by name — the whole point being that a container nobody remembered to register is still caught.
 *
 * Returns the field names that still hold `clientId`. A `Map` is checked by key, a `Set` by
 * membership, an array by inclusion.
 */
function stillMentioning(session: any, clientId: string): string[] {
	const hits: string[] = [];
	for (const key of Object.keys(session)) {
		const v = session[key];
		if (v instanceof Map) { if (v.has(clientId)) hits.push(key); }
		else if (v instanceof Set) { if (v.has(clientId)) hits.push(key); }
		else if (Array.isArray(v)) { if (v.includes(clientId)) hits.push(key); }
	}
	return hits.sort();
}

/** Does the world still carry this entity? The same query, used for the control and the assertion. */
function entityExists(session: any, entityId: number): boolean {
	return !!session.world.eval(
		`KDMapData.Entities.some(function(e){ return e.id === ${entityId | 0}; })`,
	);
}

// ---------------------------------------------------------------------------------------------
// The dialogue DEFINITION, read as data — no session boot needed. Same shape as the KDM-251 case
// for `KDCoopHostLost`: this is source text with two consumers (server eval + browser script), so
// what is worth pinning is what it declares.
// ---------------------------------------------------------------------------------------------
describe('KDM-253 A4 — what the host is actually offered', () => {
	function registered() {
		const scope: any = { KDDialogue: {}, addTextKey: (k: string, v: string) => { scope._keys[k] = v; } };
		scope._keys = {};
		// eslint-disable-next-line no-new-func
		new Function('KDDialogue', 'addTextKey', KD_DISCONNECT_DIALOGUE)(scope.KDDialogue, scope.addTextKey);
		return { dialogues: scope.KDDialogue, keys: scope._keys };
	}

	it('S4/D1 — the host gets exactly two options: wait, or carry on alone', () => {
		const d = registered().dialogues[PEER_LOST_DIALOGUE];
		expect(d, 'the peer-lost dialogue is declared').toBeTruthy();
		expect(Object.keys(d.options).sort()).toEqual(['Solo', 'Wait']);
	});

	it('D1 — and the guest\'s dialogue is still the asymmetric one, unchanged by this slice', () => {
		// The roles are not symmetric (KDM-234 D5): a guest who lost the HOST has no world to
		// continue in, so "carry on alone" must never appear on their side.
		const d = registered().dialogues[HOST_LOST_DIALOGUE];
		expect(Object.keys(d.options)).toEqual(['Quit']);
	});

	it('A4 — every key either dialogue can paint is registered; no "[NotFound] …" at the player', () => {
		const { dialogues, keys } = registered();
		// KD resolves the body as "r" + response and each option as "d" + <dialogue>_<option>
		// (KinkyDungeonDialogue.ts:132/176). This epic has shipped a missing key twice.
		for (const name of [PEER_LOST_DIALOGUE, HOST_LOST_DIALOGUE]) {
			const d = dialogues[name];
			expect(keys['r' + d.response], `${name} body`).toBeTruthy();
			for (const opt of Object.keys(d.options)) {
				expect(keys[`d${name}_${opt}`], `${name} ${opt} button`).toBeTruthy();
			}
		}
	});

	it('control — the key oracle can fail, so "all present" is not a green a typo also gives', () => {
		expect(registered().keys[`d${PEER_LOST_DIALOGUE}_NoSuchOption`]).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------------------------
// The teardown itself, on a real session. No sockets: `removePlayer` is session-level, and driving
// it directly is what lets each of the seven steps be asserted separately.
// ---------------------------------------------------------------------------------------------
describe('KDM-253 E5/N3 — letting them go is clean', () => {
	let s: any = null;
	let avB: number;
	let joinedBefore: string[];

	beforeAll(async () => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'solo-teardown', pvp: true });
		s.join('A');
		s.join('B');
		await s.ready();
		avB = s.avatars.get('B');
		joinedBefore = s.players;
		// Give B a footprint in as many containers as possible, so the sweep below has something to
		// find: a war with A, a per-player log line, a pending action, a known vitals record.
		s.rel.declareWar('A', 'B');
		s.submit('B', { kind: 'wait' });
	}, BOOT_TIMEOUT);

	afterAll(() => { try { s && s.close && s.close(); } catch (e) { /* noop */ } });

	it('control — before the removal, B is everywhere the sweep looks', () => {
		// This is the same-shape control for EVERY absence assertion below. If it ever stops finding
		// B, the sweep is asking the wrong question and its silence afterwards means nothing.
		const before = stillMentioning(s, 'B');
		expect(before, 'the sweep must find the player while they are still here').toContain('_joined');
		expect(before.length, `expected several containers to key B, found ${before}`)
			.toBeGreaterThan(3);
		expect(entityExists(s, avB), 'and B has an avatar entity in the world').toBe(true);
		expect(s.rel.atWar('A', 'B'), 'and a live relationship with A').toBe(true);
		expect(joinedBefore).toEqual(['A', 'B']);
	});

	it('E5/N3 — after removePlayer, NOTHING reachable from the session still keys them', () => {
		s.removePlayer('B');
		expect(stillMentioning(s, 'B'),
			'a container still keyed by a player who no longer exists — add it to _perClientStores')
			.toEqual([]);
	});

	it('N3 — the avatar entity is gone from the world', () => {
		expect(entityExists(s, avB)).toBe(false);
	});

	it('N3 — and no relationship names them', () => {
		expect(s.rel.atWar('A', 'B')).toBe(false);
		expect(s.rel.atPeace('A', 'B')).toBe(false);
		expect(s.rel.pendingFor('A'), 'no unanswered offer from a player who has left').toBeNull();
	});

	it('N3 — nothing is left open on the host whose speaker has gone', () => {
		s.world.restorePlayer(s.bundles.get('A'));
		const open = s.world.eval(
			`(typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : ''`,
		);
		expect(open, 'the choice the host just answered is closed, and nothing replaced it').toBe('');
	});

	it('E5 — the host plays on: they are the only seat, and their own submit resolves a turn', () => {
		expect(s.players).toEqual(['A']);
		expect(s.waitingOn(), 'lockstep waits on the host alone').toEqual(['A']);
		const t0 = s.turn;
		const res = s.submit('A', { kind: 'wait' });
		expect(res.advanced, 'one player, one submit, one turn').toBe(true);
		expect(s.turn).toBe(t0 + 1);
	}, BOOT_TIMEOUT);

	it('E5 — and a snapshot for the host still composes, with no trace of the departed peer', () => {
		// The failure this catches is a teardown that satisfies every container check and then throws
		// (or emits a half-built view) the first time anything reads the world afterwards.
		const snap = s.snapshotFor('A');
		expect(snap, 'the survivor can still be rendered').toBeTruthy();
		expect(snap.coop.war, 'no war with a player who is gone').toEqual([]);
		expect(snap.coop.canOffer, 'and nobody left to offer peace to').toEqual([]);
		const ids = (snap.map && snap.map.Entities || []).map((e: any) => e.id);
		expect(ids, 'the departed avatar is not in the rendered world').not.toContain(avB);
	});

	it('removing an unknown player is a no-op, not a crash', () => {
		expect(() => s.removePlayer('nobody-here')).not.toThrow();
		expect(s.players).toEqual(['A']);
	});
});

// ---------------------------------------------------------------------------------------------
// The decision, over the wire — the half the session cannot see: who is ASKED, what `Wait` does,
// and that the seat is really given up.
// ---------------------------------------------------------------------------------------------
describe('KDM-253 S4/D1/E6 — the host is asked, and their answer is honoured', () => {
	let bridge: any = null;
	let A: MPClient;      // seat 0 — the host, the survivor
	let B: MPClient;      // seat 1 — the guest, who leaves

	beforeAll(async () => {
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'solo-choice', hbIntervalMs: 0 });
		const port = await bridge.listen(0);
		A = await MPClient.connect(port);
		B = await MPClient.connect(port);
		/*
		 * ⚠️ THE ROLE-BASED LOBBY HANDSHAKE, not the legacy `#coop=<id>` one — and that is not
		 * incidental. Only this path puts anyone in the JOIN GATE, and the gate seat is half of what
		 * this describe asserts (E6: `Solo` must hand slot 1 back). Booted the legacy way, the gate
		 * never seats anybody, so `gate.has('B')` is false from the start and the release assertion
		 * passes whether or not the code releases anything. Measured: a mutant that deleted the
		 * `gate.release` call survived the legacy-boot version of this spec.
		 */
		A.send({ type: 'join', clientId: 'A', role: 'host' });
		await A.next((m) => m.type === 'joined');
		B.send({ type: 'join', clientId: 'B', role: 'guest', name: 'Ada' });
		await A.next((m) => m.type === 'join_pending');
		A.send({ type: 'join_answer', accept: true });
		await A.next(isState);
		await B.next(isState);
		expect(bridge.gate.has('B'), 'precondition: the gate really seated the guest').toBe(true);
		B.close();
		await A.next(isMissing);
	}, BOOT_TIMEOUT);

	afterAll(() => {
		A?.close(); B?.close();
		try { bridge && bridge.close(); } catch (e) { /* noop */ }
	});

	it('S3/S4 — the host is asked IN THE GAME, on their own bundle', () => {
		expect(dialogueOf(bridge.session, 'A')).toBe(PEER_LOST_DIALOGUE);
	}, BOOT_TIMEOUT);

	it('D1 — and the GUEST is never asked to choose; only the survivor decides', () => {
		expect(dialogueOf(bridge.session, 'B'),
			'the person who left is not offered a choice about themselves')
			.not.toBe(PEER_LOST_DIALOGUE);
	}, BOOT_TIMEOUT);

	it('D1 — choosing Wait is an ANSWER that changes nothing: still paused, seat still held', async () => {
		A.send(answerDialogue(PEER_LOST_DIALOGUE, 'Wait'));
		await A.next((m) => m.type === 'state' || m.type === 'ack');
		expect(bridge.gate.has('B'), 'waiting keeps their seat in the gate too').toBe(true);
		// The answer really ARRIVED — without this, every assertion below is also satisfied by an
		// input the game silently ignored, which is exactly how this case first passed while the
		// payload shape was wrong.
		expect(dialogueOf(bridge.session, 'A'), 'the question was answered and is closed').toBe('');
		expect(bridge.presence.state('B'), 'the seat is held, not surrendered').toBe('missing');
		expect(bridge.session.paused, 'and the session is still waiting for them').toBe(true);
		expect(bridge.session.players, 'B keeps their seat').toContain('B');
	}, BOOT_TIMEOUT);

	it('S4/E5 — choosing Solo gives the seat up and lets the host play', async () => {
		// The dialogue must be re-openable to be answerable a second time; the host is asked again
		// only because this test answered `Wait` first.
		bridge.session.openPeerLostDialogue('A');
		A.send(answerDialogue(PEER_LOST_DIALOGUE, 'Solo'));
		await A.next((m) => m.type === 'state' || m.type === 'ack');

		expect(bridge.presence.state('B'), 'U1/E6 — the seat is now terminal').toBe('gone');
		expect(bridge.session.players, 'and the session is one player').toEqual(['A']);
		expect(bridge.session.paused, 'nothing is being waited for any more').toBe(false);

		// The turn loop really does resolve on the host alone, over the wire.
		//
		// ⚠️ A TURN frame, not just any state frame. The departure itself pushes one
		// (`kind:'push'` — the survivor's world changed), and waiting for "a state" happily
		// consumed THAT and then read its unchanged tick. The distinction the client depends on is
		// the same one the assertion has to make.
		const before = bridge.session.turn;
		A.send({ type: 'input', action: { kind: 'wait' } });
		const s = await A.next((m: any) => m.type === 'state' && m.kind == null, 60_000);
		expect(s.tick, 'a turn resolved on one player\'s submit').toBeGreaterThan(before);
		expect(bridge.session.turn).toBe(before + 1);
		await A.never(isWaiting, 300);
	}, BOOT_TIMEOUT);

	it('E6 — the gate seat is released too, or slot 1 leaks for the life of the process', () => {
		// KDM-252 stopped a mid-session close from freeing the SEAT (a returning player must find
		// their own). `gone` is where it is finally given back — and nothing else gives it back.
		expect(bridge.gate.has('B'), 'the join gate no longer holds a seat for them').toBe(false);
	});

	it('E6 — and the departed clientId reconnecting is refused in words', async () => {
		const ghost = await MPClient.connect(bridge.port);
		try {
			ghost.send({ type: 'join', clientId: 'B' });
			const r = await ghost.next((m) => m.type === 'reject' || m.type === 'joined', 5_000);
			expect(r.type, 'a session that has moved on does not re-admit a ghost').toBe('reject');
			expect(r.reason).toBe('seat_gone');
		} finally {
			ghost.close();
		}
	}, BOOT_TIMEOUT);
});
