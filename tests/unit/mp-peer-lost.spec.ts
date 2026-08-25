/**
 * KDM-251 — a paused session refuses turns OUT LOUD.
 *
 * KDM-250 made the server notice that a peer is gone. This is the half the surviving player actually
 * experiences: the turn loop stops, and every key and click they press is refused *with a reason*,
 * instead of being swallowed by a barrier that will never close.
 *
 * THE FAILURE THIS GUARDS IS NOT "THE TURN DID NOT ADVANCE" — it is "the input looked accepted".
 * KDM-225 shipped exactly that: the client sets `coop.submitted = true` on a `waiting` reply and then
 * suppresses every later input as already-acted, so a player whose action entered a barrier that
 * never resolves is locked out of the very controls that could unblock them. Hence every assertion
 * here comes in a pair — `blocked` arrived AND `waiting` did not.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE. Reconnect (KDM-252) and the wait/solo choice (KDM-253). This
 * slice only has to make the pause honest.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-251 (EARS text in KDM-234).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient, seatPair } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_DISCONNECT_DIALOGUE, HOST_LOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT_TIMEOUT = 240_000;

const isState = (m: any) => m.type === 'state';
const isBlocked = (m: any) => m.type === 'blocked';
const isWaiting = (m: any) => m.type === 'waiting';
const isMissing = (m: any) => m.type === 'peer_missing';

describe('KDM-251 — the pause is honest', () => {
	let bridge: any = null;
	let A: MPClient;      // seat 0 — the host
	let B: MPClient;      // seat 1 — the guest

	beforeAll(async () => {
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'peer-lost', hbIntervalMs: 0 });
		const port = await bridge.listen(0);
		// KDM-255 — through the join gate, the only road in.
		({ host: A, guest: B } = await seatPair(port));
		await A.next(isState);
		await B.next(isState);
		// B leaves. One boot serves every case below; the session stays paused throughout except
		// where a case explicitly resumes it and puts it back.
		B.close();
		await A.next(isMissing);
	}, BOOT_TIMEOUT);

	afterAll(() => { A?.close(); B?.close(); try { bridge && bridge.close(); } catch (e) { /* noop */ } });

	it('S2/N1 — a turn-consuming input is refused with a stated reason', async () => {
		A.send({ type: 'input', action: { kind: 'wait' } });
		const b = await A.next(isBlocked);
		expect(b.reason).toBe('peer-missing');
	}, BOOT_TIMEOUT);

	it('N1 — and it is NOT answered `waiting`, which is what soft-locked the client in KDM-225', async () => {
		A.send({ type: 'input', action: { kind: 'wait' } });
		await A.next(isBlocked);
		await A.never(isWaiting, 300);
	}, BOOT_TIMEOUT);

	it('S2 — no turn resolves while paused', async () => {
		const t0 = bridge.session.turn;
		A.send({ type: 'input', action: { kind: 'wait' } });
		await A.next(isBlocked);
		expect(bridge.session.turn, 'the shared turn counter must not move').toBe(t0);
	}, BOOT_TIMEOUT);

	it('A3 — a ui input still flows, so the survivor can still reach their controls', async () => {
		// `setMoveDirection` is KD's own per-frame hover input and is classified `ui`, so it is routed
		// around `submit` entirely and must be unaffected by the gate. Without this, the disconnect
		// dialogue (KDM-253) would be unanswerable and the pause would be a soft-lock of its own.
		A.send({ type: 'input', action: { kdType: 'setMoveDirection', data: { dir: { x: 1, y: 0 } } } });
		const reply = await A.next((m) => m.type === 'state' || m.type === 'ack');
		expect(['state', 'ack']).toContain(reply.type);
	}, BOOT_TIMEOUT);

	it('the gate is not permanent — resuming accepts turns again', async () => {
		// Narrow on purpose: this proves the MECHANISM releases, not the reconnect flow (KDM-252).
		bridge.session.resume();
		try {
			A.send({ type: 'input', action: { kind: 'wait' } });
			const w = await A.next(isWaiting);
			expect(w.waitingOn, 'back to normal lockstep, waiting on the absent peer').toContain('B');
		} finally {
			bridge.session.pause('peer-missing');   // put the fixture back for any later case
		}
	}, BOOT_TIMEOUT);
});

/**
 * The dialogue DEFINITION, read as data. No session boot: this is a source-text module with two
 * consumers (server eval + browser script), exactly like `kd-peace-dialogue.js`, so the thing worth
 * pinning is what it declares.
 */
describe('KDM-251 — S5/D7: the guest waiting on a lost host is offered exactly one way out', () => {
	/** Evaluate the shared source text in a bare scope and read back what it registered. */
	function registered() {
		const scope: any = { KDDialogue: {}, addTextKey: (k: string, v: string) => { scope._keys[k] = v; } };
		scope._keys = {};
		// eslint-disable-next-line no-new-func
		new Function('KDDialogue', 'addTextKey', KD_DISCONNECT_DIALOGUE)(scope.KDDialogue, scope.addTextKey);
		return { dialogues: scope.KDDialogue, keys: scope._keys };
	}

	it('registers the host-lost dialogue', () => {
		expect(registered().dialogues[HOST_LOST_DIALOGUE]).toBeTruthy();
	});

	it('offers Quit and NOTHING else — no "continue", ever (D7, KDM-244 C3)', () => {
		const d = registered().dialogues[HOST_LOST_DIALOGUE];
		expect(Object.keys(d.options)).toEqual(['Quit']);
	});

	it('every text key it can paint is registered — no "[NotFound] …" at the player', () => {
		const { dialogues, keys } = registered();
		const d = dialogues[HOST_LOST_DIALOGUE];
		// KD resolves the body as "r" + response and each option as "d" + <dialogue>_<option>
		// (KinkyDungeonDialogue.ts:132/176). This epic has shipped a missing key twice.
		expect(keys['r' + d.response], 'the dialogue body').toBeTruthy();
		for (const opt of Object.keys(d.options)) {
			expect(keys[`d${HOST_LOST_DIALOGUE}_${opt}`], `the ${opt} button`).toBeTruthy();
		}
	});

	/** Control: the key oracle must be able to fail, or "all present" is a green a typo also gives. */
	it('control — a key that was never registered is reported missing', () => {
		expect(registered().keys['dKDCoopHostLost_NoSuchOption']).toBeFalsy();
	});
});
