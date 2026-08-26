/**
 * Node-layer (Vitest) — KDM-244 on the WIRE: who may ask for the run, and who receives it.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM mp-save-export.spec.ts ───────────────────────────────────
 * R-h. `save_export` could be produced correctly by the session, dropped on the way out, and the
 * entire suite would stay green while the feature did nothing. Everything here therefore asserts on
 * **what actually arrives at a socket**, not on what a method returned (memory:
 * assert-at-the-deciding-layer). The session-level behaviour is `mp-save-export.spec.ts`'s job and
 * is not repeated.
 *
 * ── WHAT THIS FILE NO LONGER OWNS (KDM-274) ───────────────────────────────────────────────────────
 * When it was written, nothing at all watched SERVER → CLIENT, so it also carried the GENERIC
 * claims: that a declared outbound field reaches the socket, and that a host-only payload does not
 * reach a guest. `tests/unit/mp-outbound-fields.spec.ts` now declares both for every outbound kind
 * (`OUTBOUND_MESSAGES`) and holds `save_export` to them like any other message — which is the point
 * of generalising: a per-feature test protects the field whose author thought of it and nothing
 * else, exactly as KDM-260 found on the inbound side.
 *
 * So what stays here is what is genuinely ABOUT THE EXPORT and could not be stated generically: that
 * the bytes decode to this run at this floor, stripped of every avatar; that `reason` distinguishes
 * the four moments a save is produced; and that each TRIGGER fires when it should. A generic guard
 * cannot reach a floor transition, and cannot know that a save carrying a `RemotePlayer` entity is
 * unopenable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// KDM-275: the SHARED descent helper. Its doc names two traps that make a hand-rolled descent pass
// without moving the party; a third copy would be a third chance to hit them.
import { descend, mapId } from './helpers/world';
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
		// Not merely "a string arrived" — that `save` is present at all is the generic guard's job
		// now (KDM-274). The payload has to be THE RUN. Decoded with the SERVER's own
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

	/*
	 * KDM-274 — "and the guest is not sent one as a side effect of the HOST asking" used to be a test
	 * here. It was the generic claim, not an export one: a broadcast written where a unicast was
	 * meant, which is the commonest way ANY host-only payload reaches everybody.
	 *
	 * It now lives in `mp-outbound-fields.spec.ts` as `to: 'host'`, checked over every frame every
	 * socket receives, for every host-only kind rather than this one — and mutation-tested by turning
	 * `_sendExport`'s unicast into a broadcast. Restating it here would protect `save_export` alone
	 * and leave the next such payload exactly as unguarded as this one used to be.
	 */

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

/**
 * KDM-275 on the WIRE — the AUTOMATIC export reaches the host and nobody else.
 *
 * Here rather than in `mp-save-autoexport.spec.ts` for the reason this whole file exists (R-h, and
 * now [[KDM-274]]): nothing guards the server→client direction, so the session could arm the flag
 * perfectly, the bridge could drop it, and every session-level test would stay green. The `reason`
 * field is the specific thing at risk — it is what tells an automatic export from a requested one,
 * and it is new (memory `assert_at_the_deciding_layer`).
 *
 * It reuses `seated()` above rather than growing a second copy of the same fixture.
 */
describe('KDM-275 wire — the run saves itself, to the host only', () => {
	let bridge: any, A: MPClient, B: MPClient;

	beforeAll(async () => { ({ bridge, A, B } = await seated('kdm275-wire')); }, BOOT);
	afterAll(() => { A?.close(); B?.close(); try { bridge && bridge.close(); } catch (e) { /* noop */ } });

	it('R5 — a floor transition puts a save on the HOST\'s socket, labelled `floor`', async () => {
		const before = mapId(bridge.session);
		expect(descend(bridge.session, 'A')).toBe('ok');
		// Trap 3 again: a descent that moved nobody would make the whole test vacuous.
		expect(mapId(bridge.session), 'the party must really be on a different map').not.toBe(before);

		A.send({ type: 'input', action: { kind: 'wait' } });
		B.send({ type: 'input', action: { kind: 'wait' } });

		const m: any = await A.next((x: any) => x.type === 'save_export' || x.type === 'error');
		expect(m.type, m.error || '').toBe('save_export');
		// `reason` is what tells an automatic export from a requested one. That it ARRIVES AT ALL is
		// now a generic promise (KDM-274, `OUTBOUND_MESSAGES.save_export.required`); which VALUE this
		// particular trigger produces is not, and is the export-specific half that stays here.
		expect(m.reason, 'the client tells automatic from requested by this alone').toBe('floor');

		// Not merely "a string arrived": decoded with the SERVER's own world, so this asserts the
		// bytes that crossed the wire rather than re-deriving them.
		bridge.session.world._context.__KD_WIRE_CHK = m.save;
		const decoded = bridge.session.world.eval(
			'JSON.parse(DecompressB64(String(globalThis.__KD_WIRE_CHK).trim()))');
		expect(decoded.level).toBe(bridge.session.world.eval('MiniGameKinkyDungeonLevel'));
		expect(decoded.KDMapData.Entities.filter(
			(e: any) => String((e.Enemy && e.Enemy.name) || '').startsWith('RemotePlayer')).length,
		'an automatic export is stripped exactly like a requested one').toBe(0);
	}, BOOT);

	it('R10 — the GUEST is sent no save, on a trigger they never asked for', async () => {
		// The failure this pins is a one-word slip: `_sendExport(clientId, …)` instead of
		// `_sendExport(this.gate.host, …)`. The acting player on the transition turn may be either
		// seat, so passing the actor through would export the world to a guest.
		//
		// `never` rather than a bare filter, because it says out loud how long it watched — and the
		// guest's copy, if the bug existed, would have arrived on the same turn as the host's, which
		// the test above has already awaited.
		await B.never((m: any) => m.type === 'save_export');
	}, BOOT);
});
