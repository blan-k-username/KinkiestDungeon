/**
 * KDM-297 — a guest who knocks on a RUNNING session is asked about IN THE GAME.
 *
 * Before this, the host was only ever asked through the lobby: the server sent `join_pending`, the
 * host's page wrote it into the lobby object, and the lobby is painted only on the Multiplayer screen.
 * A host already in the dungeon — the whole join-late use case (KDM-235) — saw nothing, and the guest
 * waited on "Waiting for the host to let you in…" for ever. The join-late suite never noticed because
 * it boots with `#coop=`, whose host answers by itself.
 *
 * WHAT IS ASSERTED, AND WHERE. On the WIRE, from the host's own merged snapshot: the dialogue is
 * per-player state the host's browser re-adopts from every frame, so "the server opened it" and "it
 * reached the host" are the same observation only if it is read here. `MPClient.snapshot` is the
 * NEWEST state, never a buffered frame from before the dialogue opened.
 *
 * Requirement ids refer to the `## Requirements` section of KDM-297.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MPClient } from '../helpers/mp-ws-client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge } = require('../../tools/mp-server/ws-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KD_DISCONNECT_DIALOGUE, JOIN_ASK_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

const BOOT_TIMEOUT = 240_000;
const ASK = 'KDCoopJoinAsk';

const gd = (c: MPClient) => (c.snapshot && c.snapshot.bundle && c.snapshot.bundle.gameData) || {};
const dialogueOf = (c: MPClient) => gd(c).CurrentDialog || '';

/** Wait until `fn` is true, naming what was being waited for. */
async function until(fn: () => boolean, what: string, ms = 15_000) {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timeout after ${ms}ms waiting for: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** KD's own click on one of the dialogue's options (`KinkyDungeonDialogue.ts` → `KDSendInput`). */
const answer = (option: string) => ({
	type: 'input', action: { kdType: 'dialogue', data: { dialogue: ASK, dialogueStage: option, click: true } },
});

async function guestAsks(port: number, clientId: string, name: string) {
	const g = await MPClient.connect(port);
	g.send({ type: 'join', clientId, role: 'guest', name });
	await g.next((m) => m.type === 'awaiting_approval');
	return g;
}

describe('KDM-297 — the dialogue definition', () => {
	function registered() {
		const scope: any = { KDDialogue: {}, keys: {} };
		// eslint-disable-next-line no-new-func
		new Function('KDDialogue', 'addTextKey', KD_DISCONNECT_DIALOGUE)(
			scope.KDDialogue, (k: string, v: string) => { scope.keys[k] = v; });
		return { dialogues: scope.KDDialogue, keys: scope.keys };
	}

	it('is exported under the name the session opens', () => {
		expect(JOIN_ASK_DIALOGUE).toBe(ASK);
	});

	it('R1 — offers exactly Accept and Decline', () => {
		expect(Object.keys(registered().dialogues[ASK].options).sort()).toEqual(['Accept', 'Decline']);
	});

	it('every text key it can paint is registered — named and anonymous bodies, both buttons', () => {
		const { keys } = registered();
		expect(keys[`r${ASK}`], 'named body').toMatch(/GUESTNAME/);
		expect(keys[`r${ASK}Anon`], 'blank-name body (R6)').toBeTruthy();
		expect(keys[`r${ASK}Anon`], 'and it has no token to leave unfilled').not.toMatch(/GUESTNAME/);
		for (const o of ['Accept', 'Decline']) expect(keys[`d${ASK}_${o}`], o).toBeTruthy();
	});

	it('control — a key that was never registered is reported missing', () => {
		expect(registered().keys[`d${ASK}_NoSuchOption`]).toBeFalsy();
	});
});

describe('KDM-297 — a host who is already playing is asked in the game', () => {
	let bridge: any = null;
	let port = 0;
	let A: MPClient;
	const guests: MPClient[] = [];

	beforeAll(async () => {
		// requiredPlayers: 1 — the host is playing ALONE, which is the situation join-late exists for.
		bridge = new WSBridge({ requiredPlayers: 1, seed: 'join-ask', hbIntervalMs: 0 });
		port = await bridge.listen(0);
		A = await MPClient.connect(port);
		A.send({ type: 'join', clientId: 'A', role: 'host' });
		const j = await A.next((m) => m.type === 'joined');
		expect(j.started, 'the host is in a running game before anybody asks').toBe(true);
		await A.next((m) => m.type === 'state');
	}, BOOT_TIMEOUT);

	afterAll(() => {
		A?.close();
		for (const g of guests) g.close();
		try { bridge && bridge.close(); } catch (e) { /* noop */ }
	});

	it('control — nobody has asked, so nothing is on the host\'s screen', () => {
		expect(A.snapshot, 'the control can see a snapshot at all').toBeTruthy();
		expect(dialogueOf(A)).not.toBe(ASK);
	});

	it('R1 + R3 — the host is asked BY NAME, and Decline refuses the guest in words', async () => {
		const g = await guestAsks(port, 'G1', 'Bee');
		guests.push(g);
		await until(() => dialogueOf(A) === ASK, 'the join dialogue on the host');
		expect(gd(A).CurrentDialogMsgData, 'the dialogue names who is asking').toEqual({ GUESTNAME: 'Bee' });

		A.send(answer('Decline'));
		const r = await g.next((m) => m.type === 'reject');
		expect(r.reason).toBe('declined');
		expect(bridge.session.players, 'the host plays on alone').toEqual(['A']);
		await until(() => dialogueOf(A) !== ASK, 'the answered dialogue to close');
	}, BOOT_TIMEOUT);

	it('R4 + R6 — a nameless guest is announced without a blank, and withdrawing closes the question', async () => {
		const g = await guestAsks(port, 'G2', '');
		await until(() => dialogueOf(A) === ASK, 'the join dialogue on the host');
		expect(gd(A).CurrentDialogMsg, 'the anonymous body, not "  is asking…"').toBe(`${ASK}Anon`);

		g.close();
		await until(() => dialogueOf(A) !== ASK, 'the withdrawn question to close');
		expect(bridge.gate.pending, 'and the gate forgot the request').toBe(null);
	}, BOOT_TIMEOUT);

	it('R2 — Accept seats the guest into the running game, and the question is gone', async () => {
		// `$&` is String.replace's "the matched text" — KD fills tokens with replace(), so an unescaped
		// name would paint the TOKEN instead of the name. Read back the way KD reads it.
		const g = await guestAsks(port, 'G3', 'a$&b');
		guests.push(g);
		await until(() => dialogueOf(A) === ASK, 'the join dialogue on the host');
		const data = gd(A).CurrentDialogMsgData;
		expect('GUESTNAME'.replace('GUESTNAME', data.GUESTNAME), 'painted literally').toBe('a$&b');

		const turn = bridge.session.turn;
		A.send(answer('Accept'));
		const j = await g.next((m) => m.type === 'joined');
		expect(j.started, 'straight into the game — a join-late, not a lobby wait').toBe(true);
		expect(bridge.session.players).toEqual(['A', 'G3']);
		expect(bridge.session.turn, 'the run was not restarted').toBe(turn);
		await until(() => dialogueOf(A) !== ASK, 'the answered dialogue to close');
	}, BOOT_TIMEOUT);
});

describe('KDM-297 — before the game starts, the lobby still asks (unchanged)', () => {
	let bridge: any = null;
	let A: MPClient;
	let g: MPClient;

	afterAll(() => { A?.close(); g?.close(); try { bridge && bridge.close(); } catch (e) { /* noop */ } });

	it('no dialogue is opened — there is no game to open it in; `join_pending` still arrives', async () => {
		bridge = new WSBridge({ requiredPlayers: 2, seed: 'join-ask-prestart', hbIntervalMs: 0 });
		const port = await bridge.listen(0);
		A = await MPClient.connect(port);
		A.send({ type: 'join', clientId: 'A', role: 'host' });
		const j = await A.next((m) => m.type === 'joined');
		expect(j.started, 'control: the session has NOT started').toBe(false);

		g = await guestAsks(port, 'G', 'Bee');
		const p = await A.next((m) => m.type === 'join_pending');
		expect(p.name, 'the lobby is asked exactly as before').toBe('Bee');
		await A.never((m) => m.type === 'state', 500);
	}, BOOT_TIMEOUT);
});
