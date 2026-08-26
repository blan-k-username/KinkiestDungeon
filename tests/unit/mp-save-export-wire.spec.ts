/**
 * Node-layer (Vitest) — KDM-244 on the WIRE: who may ask for the run, and who receives it.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM mp-save-export.spec.ts ───────────────────────────────────
 * R-h. KDM-260's drift guard — the one that caught KDM-243's `save` being sent by the client and
 * silently not forwarded by the bridge — watches the JOIN direction (`HOST_JOIN_FIELDS`,
 * `mp-gate-fields-on-wire`, `mp-join-fields`). Nothing watches SERVER → CLIENT. So `save_export`
 * could be produced correctly by the session, dropped on the way out, and the entire suite would
 * stay green while the feature did nothing.
 *
 * Everything here therefore asserts on **what actually arrives at a socket**, not on what a method
 * returned (memory: assert-at-the-deciding-layer). The session-level behaviour is
 * `mp-save-export.spec.ts`'s job and is not repeated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PEER_LOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT = 240_000;
const isState = (m: any) => m.type === 'state';
const isMissing = (m: any) => m.type === 'peer_missing';

/** Answer one of OUR dialogues the way the real client does (see mp-solo-teardown for the trap). */
function answerDialogue(dialogue: string, option: string) {
	return { type: 'input', action: { kdType: 'dialogue', data: { dialogue, dialogueStage: option, click: true } } };
}

/** A seated two-player session, host A, guest B. */
async function seated(seed: string) {
	const bridge = new WSBridge({ requiredPlayers: 2, seed, hbIntervalMs: 0 });
	const port = await bridge.listen(0);
	const A = await MPClient.connect(port);
	const B = await MPClient.connect(port);
	A.send({ type: 'join', clientId: 'A', role: 'host' });
	await A.next((m: any) => m.type === 'joined');
	B.send({ type: 'join', clientId: 'B', role: 'guest', name: 'Ada' });
	await A.next((m: any) => m.type === 'join_pending');
	A.send({ type: 'join_answer', accept: true });
	await A.next(isState);
	await B.next(isState);
	return { bridge, A, B };
}

describe('KDM-244 wire — the host asks, and the run comes back', () => {
	let bridge: any, A: MPClient, B: MPClient;

	beforeAll(async () => { ({ bridge, A, B } = await seated('kdm244-wire')); }, BOOT);
	afterAll(() => { A?.close(); B?.close(); try { bridge && bridge.close(); } catch (e) { /* noop */ } });

	it('R1 — the host asks and a real, loadable save arrives ON THE SOCKET', async () => {
		A.send({ type: 'export_request' });
		const m: any = await A.next((x: any) => x.type === 'save_export' || x.type === 'error');
		expect(m.type, m.error || '').toBe('save_export');
		expect(typeof m.save).toBe('string');
		// Not merely "a string arrived": the payload has to be the run. Decoded with the SERVER's own
		// world, so this checks the bytes that crossed the wire rather than re-deriving them.
		bridge.session.world._context.__KD_WIRE_CHK = m.save;
		const decoded = bridge.session.world.eval(
			'JSON.parse(DecompressB64(String(globalThis.__KD_WIRE_CHK).trim()))');
		expect(decoded.level).toBe(bridge.session.world.eval('MiniGameKinkyDungeonLevel'));
		expect(decoded.KDMapData.Entities.filter(
			(e: any) => String((e.Enemy && e.Enemy.name) || '').startsWith('RemotePlayer')).length,
		'the wire payload must already be stripped — the client does not clean saves').toBe(0);
	}, BOOT);

	it('R11 — a GUEST asking gets a refusal, and no save', async () => {
		B.send({ type: 'export_request' });
		const m: any = await B.next((x: any) => x.type === 'save_export' || x.type === 'error');
		expect(m.type, 'a guest must never receive a world').toBe('error');
		expect(String(m.error)).toMatch(/host/i);
	}, BOOT);

	it('R11 — and the guest is not sent one as a side effect of the HOST asking', async () => {
		/*
		 * The leak this catches is a broadcast written where a unicast was meant — the single most
		 * common way a host-only payload reaches everybody. `seen` is the client's whole receive log,
		 * so this asserts over every frame B has ever had, not just the next one.
		 */
		A.send({ type: 'export_request' });
		await A.next((x: any) => x.type === 'save_export');
		expect(B.seen((x: any) => x.type === 'save_export'),
			'a host-only payload reaching everybody is what a broadcast-where-unicast-was-meant looks like')
			.toBe(false);
	}, BOOT);

	it('R10/D3 — asking for the run does not end or disturb the session', async () => {
		expect(bridge.session.started).toBe(true);
		expect(bridge.session._joined).toEqual(['A', 'B']);
		// …and both seats still play. A turn needs both, which is also the proof lockstep is intact.
		A.send({ type: 'input', action: { kind: 'wait' } });
		B.send({ type: 'input', action: { kind: 'wait' } });
		await A.next(isState);
	}, BOOT);
});

describe('KDM-244 wire — going solo hands the host their run unprompted', () => {
	let bridge: any, A: MPClient, B: MPClient;

	beforeAll(async () => {
		({ bridge, A, B } = await seated('kdm244-wire-solo'));
		B.close();
		await A.next(isMissing);
	}, BOOT);
	afterAll(() => { A?.close(); try { bridge && bridge.close(); } catch (e) { /* noop */ } });

	it('D1 — choosing "go on alone" sends the save without being asked', async () => {
		/*
		 * The moment the run stops being co-op. Sent AFTER the seat is gone, which is what leaves the
		 * export stripping the HOST's own avatar — nothing else removes that one, and an export that
		 * keeps it is unopenable (see mp-save-export.spec.ts).
		 */
		A.send(answerDialogue(PEER_LOST_DIALOGUE, 'Solo'));
		const m: any = await A.next((x: any) => x.type === 'save_export' || x.type === 'error');
		expect(m.type, m.error || '').toBe('save_export');
		expect(m.reason).toBe('solo');

		bridge.session.world._context.__KD_WIRE_CHK = m.save;
		const decoded = bridge.session.world.eval(
			'JSON.parse(DecompressB64(String(globalThis.__KD_WIRE_CHK).trim()))');
		// THE CONTROL that makes this test about the solo path specifically: the departed guest is
		// gone from the session, so a save carrying an avatar would be carrying the HOST's own.
		expect(bridge.session._joined).toEqual(['A']);
		expect(decoded.KDMapData.Entities.filter(
			(e: any) => String((e.Enemy && e.Enemy.name) || '').startsWith('RemotePlayer')).length).toBe(0);
	}, BOOT);

	it('R9 — and the solo decision stands even though it now carries an export', () => {
		// The export is best-effort and must never be able to undo the decision that triggered it.
		expect(bridge.session.started).toBe(true);
		expect(bridge.gate.has('B')).toBe(false);
	}, BOOT);
});
