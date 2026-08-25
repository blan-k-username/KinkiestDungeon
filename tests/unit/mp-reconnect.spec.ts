/**
 * KDM-252 — a reconnecting player resumes THEIR OWN character, not a copy of it.
 *
 * KDM-250 noticed the drop; KDM-251 made the pause honest. This is the slice that makes the waiting
 * pay off: the same `clientId` comes back, takes back its own seat and bundle, and the session runs
 * again from where it stopped.
 *
 * ⚠️ THE ORACLE IS A VALUE, NOT A PRESENCE. "A player exists after the reconnect" is the classic
 * vacuous shape here — it passes just as happily on a freshly rolled character, which is the exact
 * failure this slice exists to prevent. So every case below fingerprints a distinctive value stamped
 * BEFORE the drop and looks for that same value after, and each fingerprint is paired with a control
 * (the OTHER player's value, untouched) so a test that stamped nothing cannot pass.
 *
 * WHY THE HOST IS THE ONE WHO DROPS. Only a guest who has lost the HOST gets a dialogue put in front
 * of them (KDM-251 S5), so dropping the host is the only arrangement in which "the survivor's modal
 * closes by itself" is observable at all.
 *
 * ONE BOOT, ORDERED CASES. A session boot is ~30 s of real game bundle; the cases below share it and
 * run in order — drop, resume, then the terminal `gone` case LAST, because `gone` is terminal by
 * construction and would poison anything after it.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-252 (EARS text in KDM-234).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient, seatPair } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HOST_LOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT_TIMEOUT = 240_000;

const isState = (m: any) => m.type === 'state';
const isBlocked = (m: any) => m.type === 'blocked';
const isWaiting = (m: any) => m.type === 'waiting';
const isMissing = (m: any) => m.type === 'peer_missing';
const isBack = (m: any) => m.type === 'peer_back';

/** A distinctive value stamped into a player's own bundle — the fingerprint every case reads back. */
const FINGERPRINT = { A: 41.5, B: 17.25 };

/**
 * Stamp `hp` into ONE player's captured bundle, through the session's own swap sequence.
 *
 * `hp` is per-player state carried by the bundle, so it travels the whole path this slice is about:
 * capture → drop → re-attach → `snapshotFor`. A fractional value nothing in the game would produce
 * makes an accidental match implausible.
 */
function stamp(session: any, clientId: string, hp: number) {
	session.world.restorePlayer(session.bundles.get(clientId));
	session.world.eval(`KinkyDungeonPlayerEntity.hp = ${hp};`);
	session.bundles.set(clientId, session.world.capturePlayer());
}

/** What the world says about an avatar id — the count is the point (E4: exactly one). */
function avatarCount(session: any, entityId: number): number {
	return session.world.eval(
		`KDMapData.Entities.filter(function(e){ return e.id === ${entityId | 0}; }).length`,
	);
}

/** Whichever dialogue this player's own bundle currently has open, or ''. */
function dialogueOf(session: any, clientId: string): string {
	session.world.restorePlayer(session.bundles.get(clientId));
	return session.world.eval(
		`(typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : ''`,
	);
}

describe('KDM-252 — the same character comes back', () => {
	let bridge: any = null;
	let A: MPClient;      // seat 0 — the HOST, the one who drops
	let B: MPClient;      // seat 1 — the guest, the survivor
	let A2: MPClient;     // the host's SECOND socket — the reconnect

	beforeAll(async () => {
		// No heartbeat: every drop below is a socket close, which is its own evidence (KDM-250 E2).
		// A timer running underneath would make the cases race a sweep they are not testing.
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'reconnect', hbIntervalMs: 0 });
		const port = await bridge.listen(0);
		// KDM-255 — through the join gate, the only road in. The RECONNECT frames below stay roleless
		// on purpose: a known id re-attaching short-circuits above the role branch, and that is
		// precisely the behaviour these cases exist to pin.
		({ host: A, guest: B } = await seatPair(port));
		await A.next(isState);
		await B.next(isState);
	}, BOOT_TIMEOUT);

	afterAll(() => {
		A?.close(); B?.close(); A2?.close();
		try { bridge && bridge.close(); } catch (e) { /* noop */ }
	});

	it('E4 — the host drops, and the guest is paused and told', async () => {
		// The fingerprints are stamped HERE, before the drop, so everything after them is downstream
		// of a value that only this test could have written.
		stamp(bridge.session, 'A', FINGERPRINT.A);
		stamp(bridge.session, 'B', FINGERPRINT.B);
		expect(bridge.presence.state('A'), 'precondition: the host is here').toBe('connected');

		A.close();
		const gone = await B.next(isMissing);
		expect(gone.clientId).toBe('A');
		expect(gone.role, 'the roles are not symmetric — the guest must know it was the HOST').toBe('host');
		expect(bridge.presence.state('A')).toBe('missing');
		expect(bridge.session.paused, 'KDM-251: the turn loop stops').toBe(true);
		expect(dialogueOf(bridge.session, 'B'), 'the survivor is told in the game (KDM-251 S5)')
			.toBe(HOST_LOST_DIALOGUE);
	}, BOOT_TIMEOUT);

	it('E4 — and until they are back, the guest\'s turn is refused (the control for "unpaused" below)',
		async () => {
			B.send({ type: 'input', action: { kind: 'wait' } });
			const b = await B.next(isBlocked);
			expect(b.reason).toBe('peer-missing');
		}, BOOT_TIMEOUT);

	it('E4/N4/U1 — the same clientId reconnects: own seat, own character, full snapshot, seq reset',
		async () => {
			const avA = bridge.session.avatars.get('A');
			expect(avA, 'precondition: the host had an avatar before the drop').toBeTruthy();

			A2 = await MPClient.connect(bridge.port);
			A2.send({ type: 'join', clientId: 'A' });

			const joined = await A2.next((m) => m.type === 'joined');
			expect(joined.started, 'it rejoins the RUNNING session, it does not start a new one').toBe(true);
			expect(joined.players, 'and takes back its own seat').toEqual(['A', 'B']);

			const first = await A2.next(isState);
			// ── N4: never a delta onto a base this socket never held ────────────────────────────────
			// `MPClient` re-exposes a merged delta as `m.snapshot`, so `snapshot` alone would be true
			// either way. `delta` is the discriminator that cannot be forged by the merge.
			expect(first.delta, 'the first frame after a resume must not be a delta').toBeUndefined();
			expect(first.snapshot, 'it must be a FULL snapshot').toBeTruthy();
			expect(first.seq, 'and the sequence base restarts, so a gap check has a base to count from')
				.toBe(1);

			// ── E4: the SAME character, fingerprinted by value ──────────────────────────────────────
			expect(first.snapshot.player, 'the resumed frame carries this player\'s own entity').toBeTruthy();
			expect(first.snapshot.player.hp,
				'a freshly rolled character would not carry the value stamped before the drop')
				.toBe(FINGERPRINT.A);

			// ── E4: one avatar, not two ─────────────────────────────────────────────────────────────
			expect(bridge.session.avatars.get('A'), 'the same avatar entity, not a new one').toBe(avA);
			expect(avatarCount(bridge.session, avA), 'a re-join that called join() again would leave two')
				.toBe(1);
			// Same-shape control: a counter that answered 1 to everything would pass the line above
			// while seeing nothing at all.
			expect(avatarCount(bridge.session, -1), 'the counter can answer something other than 1').toBe(0);

			// ── U1 ──────────────────────────────────────────────────────────────────────────────────
			expect(bridge.presence.state('A')).toBe('connected');
		}, BOOT_TIMEOUT);

	it('E4 — the survivor\'s modal is closed for them, and they are told the peer is back', async () => {
		const back = await B.next(isBack, 5_000);
		expect(back.clientId).toBe('A');
		expect(dialogueOf(bridge.session, 'B'), 'nobody clicked anything — the server closed it')
			.toBe('');
		// The CONTROL for the close: B's own character was not disturbed while its dialogue was shut.
		// `_closeOwnDialogue` restores/captures B's bundle, which is exactly where a wrong capture
		// would quietly overwrite the survivor's state.
		expect(bridge.session.bundles.get('B'), 'the survivor still has a bundle').toBeTruthy();
	}, BOOT_TIMEOUT);

	it('E4 — the session is unpaused: the very input that was refused is now accepted', async () => {
		expect(bridge.session.paused).toBe(false);
		B.send({ type: 'input', action: { kind: 'wait' } });
		const w = await B.next(isWaiting);
		expect(w.waitingOn, 'normal lockstep again — waiting on the returned peer, not refusing').toContain('A');
		await B.never(isBlocked, 300);
	}, BOOT_TIMEOUT);

	it('E4 — and the RETURNED player still holds their own character on the next turn', async () => {
		// The resume frame proved the bundle survived the re-attach. This proves it survived being
		// swapped through a real turn afterwards — the point at which a bad capture would surface.
		A2.send({ type: 'input', action: { kind: 'wait' } });
		const s = await A2.next(isState, 60_000);
		expect(s.snapshot.player.hp).toBe(FINGERPRINT.A);
		// Control: the survivor's fingerprint is intact and DIFFERENT, so this is not one shared value.
		bridge.session.world.restorePlayer(bridge.session.bundles.get('B'));
		expect(bridge.session.world.eval('KinkyDungeonPlayerEntity.hp')).toBe(FINGERPRINT.B);
	}, BOOT_TIMEOUT);

	it('D7 — the wait is unbounded: nothing schedules a deadline on a missing seat', async () => {
		// Read the SOURCE rather than wait one out — a timer that fires in an hour is untestable by
		// waiting, and D7 is a statement about the code, not about a duration.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		const src = ['ws-bridge.js', 'presence.js'].map(
			(f) => fs.readFileSync(`${__dirname}/../../tools/mp-server/${f}`, 'utf8'),
		).join('\n');
		expect(/reconnect(Deadline|Timeout|Grace|Limit|Attempts)/i.test(src),
			'a reconnect deadline would contradict KDM-234 D7 — the survivor decides, not a timer')
			.toBe(false);
		// The heartbeat sweep is the ONLY timer allowed to touch a seat, and it lives in the bridge:
		// it moves `connected` → `missing`, never `missing` → `gone`. Presence itself owns no clock at
		// all (its own header: "TIME IS INJECTED, NEVER READ"), so no rule in it can expire a seat.
		const presenceSrc = fs.readFileSync(`${__dirname}/../../tools/mp-server/presence.js`, 'utf8');
		expect(/set(Timeout|Interval)\s*\(/.test(presenceSrc),
			'a timer inside the seat rules is how an unbounded wait quietly acquires a bound')
			.toBe(false);
	}, BOOT_TIMEOUT);

	// ⚠️ LAST. `gone` is terminal by construction, so this case cannot be followed by another.
	it('U1/E6 — a seat the survivor has already dismissed does NOT come back', async () => {
		expect(bridge.presence.remove('A'), 'the survivor plays on without them').toBe(true);
		expect(bridge.presence.state('A')).toBe('gone');

		const ghost = await MPClient.connect(bridge.port);
		try {
			ghost.send({ type: 'join', clientId: 'A' });
			const r = await ghost.next((m) => m.type === 'reject' || m.type === 'joined', 5_000);
			expect(r.type, 'a ghost must be refused in words, not walked back into a moved-on session')
				.toBe('reject');
			expect(r.reason).toBe('seat_gone');
			expect(bridge.presence.state('A'), 'and `gone` stays gone').toBe('gone');
		} finally {
			ghost.close();
		}
	}, BOOT_TIMEOUT);
});
