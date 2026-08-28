/**
 * KDM-274 — the drift guard for the direction nothing used to watch: SERVER → CLIENT.
 *
 * ── THE HOLE THIS FILLS ───────────────────────────────────────────────────────────────────────────
 * KDM-260 declared the join handshake's fields (`HOST_JOIN_FIELDS`) and guards them from two sides:
 * `mp-join-fields.spec.ts` reads the CLIENT's own source and fails when it sends a field no role
 * shape forwards, and drives a real message through `_handle` to assert what the gate received. It
 * exists because KDM-239 shipped a dropped field past a green 605-test suite, and it caught the same
 * class again on KDM-243.
 *
 * All of that watches the INBOUND half. A payload the server composes correctly and then fails to
 * send — or sends to the wrong socket — leaves the entire suite green while the feature does
 * nothing, because a session-level test asserts on what a method returned rather than on what left
 * the socket. `save_export` was the first field to travel that way and was guarded only by its own
 * per-feature spec (`mp-save-export-wire.spec.ts`), which protects the field whose author thought of
 * it and nothing else — exactly the pattern KDM-260 replaced on the way in.
 *
 * ── THE THREE GUARDS, AND WHY THREE ───────────────────────────────────────────────────────────────
 * Each one fails on a drift the other two cannot see, so none of them is redundant:
 *
 *   1. SOURCE (R1) — every `{ type: '…' }` `ws-bridge.js` puts on a socket is declared, and every key
 *      on it is named. Catches: a field added to a call site and not declared.
 *   2. LIVE (R2) — every declared kind is EXERCISED against a real `WSBridge`, and its `required`
 *      fields are on the DECODED WIRE OBJECT when it is. Catches: a declaration nothing produces,
 *      and a field that stops reaching the socket (a dropped `Object.assign`, a `JSON`-eliding
 *      `undefined`). This is the one the ACs ask for by name.
 *   3. CLIENT (R3) — every `m.<field>` `coop-bootstrap.js` reads for a kind is declared for that
 *      kind. Catches KDM-239 in reverse: a receiver depending on a field the sender quietly stopped
 *      sending. Note this direction is a SUBSET check only — the client not reading a field is not a
 *      fault (`save_export.version` is stored by nobody today), so guard 2 owns "is it still sent".
 *
 * ── R4: ADDRESSING IS PART OF THE DECLARATION ─────────────────────────────────────────────────────
 * `to: 'host'` is checked in guard 2 over EVERY frame every socket ever received, not over the next
 * one. A host-only payload reaching everybody is what a broadcast-written-where-a-unicast-was-meant
 * looks like, and for `save_export` — the whole world as a save string — that is a disclosure bug,
 * not a tidiness one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge, OUTBOUND_MESSAGES } = require('../../tools/mp-server/ws-bridge');

const BRIDGE_SRC = path.resolve(__dirname, '../../tools/mp-server/ws-bridge.js');
const BOOTSTRAP = path.resolve(__dirname, '../../tools/mp-server/client/coop-bootstrap.js');

const KINDS = Object.keys(OUTBOUND_MESSAGES);
const declared = (kind: string) => [
	...(OUTBOUND_MESSAGES[kind].required || []),
	...(OUTBOUND_MESSAGES[kind].optional || []),
];

/** Strip comments, so PROSE naming a field can neither invent one nor excuse a missing one. */
function code(file: string): string {
	return fs.readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R1 — the declaration itself
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('KDM-274 R1 — the declared outbound shapes', () => {
	it('is one frozen table, with a frozen field list per kind', () => {
		expect(Object.isFrozen(OUTBOUND_MESSAGES)).toBe(true);
		expect(KINDS.length, 'an empty table would make every guard below vacuous').toBeGreaterThan(10);
		for (const k of KINDS) {
			const m = OUTBOUND_MESSAGES[k];
			expect(Object.isFrozen(m), `${k} must be frozen`).toBe(true);
			expect(Array.isArray(m.required), `${k} must declare its required fields`).toBe(true);
			expect(Object.isFrozen(m.required)).toBe(true);
			if (m.optional) expect(Object.isFrozen(m.optional)).toBe(true);
			// `type` is the kind itself and is never listed as a field of it.
			expect(declared(k), `${k} must not list 'type' — that is the kind`).not.toContain('type');
			// A field declared twice would let `required` and `optional` disagree about it.
			expect(new Set(declared(k)).size, `${k} declares a field twice`).toBe(declared(k).length);
		}
	});

	it('R4 — the host-only kinds are named as such, and they are the ones that carry the world', () => {
		const hostOnly = KINDS.filter((k) => OUTBOUND_MESSAGES[k].to === 'host');
		// Named rather than merely counted: `save_export` is the whole run as a save string, and
		// `join_pending` is somebody's name and mod list going to the seat that answers the gate.
		expect(hostOnly.sort()).toEqual(['join_pending', 'save_export']);
		for (const k of KINDS) {
			const to = OUTBOUND_MESSAGES[k].to;
			expect(to === undefined || to === 'host', `${k}: unknown addressing '${to}'`).toBe(true);
		}
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R2 — the SOURCE guard: what the bridge writes must be what it declared
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Every outbound object literal in `ws-bridge.js`, as `{ kind, fields }`.
 *
 * A literal is found by its `type: '…'` key and sliced with a brace/quote-aware scan, so only its
 * TOP-LEVEL keys count — a nested object (a `srv` stamp, a `world`) contributes nothing.
 */
function bridgeLiterals(): Array<{ kind: string; fields: string[] }> {
	const src = code(BRIDGE_SRC);
	const out: Array<{ kind: string; fields: string[] }> = [];
	for (const m of src.matchAll(/type:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
		// Walk back to the `{` that opens this literal.
		let open = m.index as number;
		while (open >= 0 && src[open] !== '{') open--;
		if (open < 0) continue;
		// …and forward to its match, so the slice is exactly one literal.
		let depth = 0, i = open, quote = '';
		for (; i < src.length; i++) {
			const c = src[i];
			if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
			if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
			if (c === '{') depth++;
			else if (c === '}') { depth--; if (!depth) break; }
		}
		const body = src.slice(open + 1, i);
		// Top-level keys only: re-scan the body and record `name:` / shorthand `name,` at depth 0.
		// `inValue` is what separates the two: once a `:` has been seen the rest of that entry is a
		// VALUE, so `started: true` and `clientId: id` contribute `started`/`clientId` and not
		// `true`/`id`. (Both really appeared here before this flag existed.)
		const fields: string[] = [];
		let d = 0, q = '', tok = '', inValue = false;
		for (let j = 0; j <= body.length; j++) {
			const c = body[j];
			if (q) { if (c === '\\') j++; else if (c === q) q = ''; continue; }
			if (c === "'" || c === '"' || c === '`') { q = c; tok = ''; continue; }
			if (c === '{' || c === '(' || c === '[') { d++; tok = ''; continue; }
			if (c === '}' || c === ')' || c === ']') { d--; tok = ''; continue; }
			if (d === 0 && c === ':') { if (tok.trim()) fields.push(tok.trim()); tok = ''; inValue = true; continue; }
			if (d === 0 && (c === ',' || c === undefined)) {
				if (!inValue && tok.trim()) fields.push(tok.trim());
				tok = ''; inValue = false; continue;
			}
			if (d === 0) tok += c;
		}
		const clean = fields.filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) && f !== 'type');
		out.push({ kind: m[1], fields: clean });
	}
	return out;
}

describe('KDM-274 R2 — the bridge cannot send a field it did not declare', () => {
	it('SELF-CHECK: the reader really finds the literals we know are there', () => {
		// A source reader that has quietly stopped matching is a permanent false green, and this one
		// decides whether the guard below means anything at all.
		const lits = bridgeLiterals();
		expect(lits.length, 'a reader finding nothing would make the guard vacuous').toBeGreaterThan(12);
		const save = lits.find((l) => l.kind === 'save_export');
		expect(save, 'the field KDM-244 added — the reason this task exists').toBeTruthy();
		expect(save!.fields.sort()).toEqual(['reason', 'save', 'version']);
		// A multi-key literal proves the key scanner, and `srv: this._srvStamp(applyMs)` proves that a
		// CALL in a value position does not leak its arguments in as fields.
		const ack = lits.find((l) => l.kind === 'ack');
		expect(ack!.fields.sort()).toEqual(['srv', 'tick']);
		// KEYS, NOT VALUES. `{ started: true }` and `{ clientId: id }` must contribute `started` and
		// `clientId` — the reader's first draft reported `true` and `id` as fields, which is a red
		// that would be "fixed" by declaring nonsense.
		expect(lits.find((l) => l.kind === 'joined')!.fields.sort())
			.toEqual(['clientId', 'players', 'started']);
		// …and a SHORTHAND key still counts: `{ …, reason }` is a field like any other.
		expect(lits.find((l) => l.kind === 'peer_gone')!.fields.sort()).toEqual(['clientId', 'reason']);
	});

	it('DRIFT GUARD — every kind the bridge sends is declared, with every key it puts on it', () => {
		const undeclaredKinds: string[] = [];
		const undeclaredFields: string[] = [];
		for (const { kind, fields } of bridgeLiterals()) {
			if (!OUTBOUND_MESSAGES[kind]) { undeclaredKinds.push(kind); continue; }
			const ok = new Set(declared(kind));
			for (const f of fields) if (!ok.has(f)) undeclaredFields.push(`${kind}.${f}`);
		}
		expect(undeclaredKinds,
			'ws-bridge.js sends this message kind and OUTBOUND_MESSAGES does not declare it — add an '
			+ 'entry (KDM-274 R1). An undeclared kind is guarded by nothing.').toEqual([]);
		expect([...new Set(undeclaredFields)],
			'ws-bridge.js puts this field on the wire and OUTBOUND_MESSAGES does not name it — add it '
			+ 'to `required` (or to `optional` if only one branch carries it). This is how KDM-239 '
			+ 'shipped a dropped field past a green suite, in the other direction.').toEqual([]);
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R3 — the CLIENT guard: what the receiver reads must be what the sender declared
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * `{ kind: fields }` the CLIENT reads, from its own `ws.onmessage` dispatch.
 *
 * The dispatch is a chain of `if (m.type === '…') { … }` blocks, so a block runs from its own guard
 * to the next one. Bounded at `ws.onclose` so code after the chain cannot be attributed to the last
 * kind it happens to follow.
 */
function clientReadFields(): Record<string, string[]> {
	const src = code(BOOTSTRAP);
	const from = src.indexOf('ws.onmessage');
	const to = src.indexOf('ws.onclose', from);
	expect(from, 'the client dispatch moved — this reader must move with it').toBeGreaterThan(0);
	expect(to, 'the client dispatch moved — this reader must move with it').toBeGreaterThan(from);
	const region = src.slice(from, to);

	const guards = [...region.matchAll(/m\.type\s*===\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)];
	const out: Record<string, string[]> = {};
	for (let i = 0; i < guards.length; i++) {
		const kind = guards[i][1];
		const start = (guards[i].index as number);
		const end = i + 1 < guards.length ? (guards[i + 1].index as number) : region.length;
		const seen = out[kind] || (out[kind] = []);
		for (const f of region.slice(start, end).matchAll(/\bm\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
			if (f[1] !== 'type' && !seen.includes(f[1])) seen.push(f[1]);
		}
	}
	return out;
}

describe('KDM-274 R3 — the client cannot depend on a field the server never sends', () => {
	it('SELF-CHECK: the reader finds the blocks and the fields we know are there', () => {
		const read = clientReadFields();
		expect(Object.keys(read).length, 'a reader finding no blocks would be vacuous').toBeGreaterThan(10);
		// One from each half of the chain, so a reader that only sees the top is caught.
		expect(read.ping, 'the first block').toContain('t');
		expect(read.save_export, 'the last-but-one block').toEqual(expect.arrayContaining(['save', 'reason']));
		// The branch-specific extras: proves the reader reaches inside a nested expression, and that
		// `optional` is a real category rather than a place to hide a field.
		expect(read.reject).toEqual(expect.arrayContaining(['reason', 'hostBuild', 'guestBuild']));
	});

	it('DRIFT GUARD — every field the client reads for a kind is declared for that kind', () => {
		const read = clientReadFields();
		const orphans: string[] = [];
		for (const kind of Object.keys(read)) {
			if (!OUTBOUND_MESSAGES[kind]) { orphans.push(`${kind}.* (kind not declared)`); continue; }
			const ok = new Set(declared(kind));
			for (const f of read[kind]) if (!ok.has(f)) orphans.push(`${kind}.${f}`);
		}
		expect(orphans,
			'the client reads this off a server message and OUTBOUND_MESSAGES does not promise it. '
			+ 'Either the server stopped sending it — the KDM-239 failure, in the direction that used '
			+ 'to have no guard — or the declaration is missing an entry.').toEqual([]);
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * R2/R4 — the LIVE guard: the declaration is kept, on a real socket
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Decode one unmasked server→client text frame — i.e. read the bytes the client would read. */
function decodeServerFrame(buf: Buffer): any {
	let len = buf[1] & 0x7f;
	let off = 2;
	if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
	else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
	return JSON.parse(buf.slice(off, off + len).toString('utf8'));
}

function recSock(id: string) {
	const s: any = { id, frames: [] as any[], writableLength: 0, ended: false };
	s.write = (buf: Buffer) => { s.frames.push(decodeServerFrame(buf)); return true; };
	s.end = () => { s.ended = true; };
	return s;
}

/**
 * A real `WSBridge` — its own `_send`, `_stateFrame`, `_handle`, presence and seat methods — with the
 * session, gate and presence replaced by stubs and the sockets replaced by recorders.
 *
 * `Object.create(WSBridge.prototype)` rather than `new`, for the reason KDM-260's rig gives: the
 * constructor boots a whole `SwapSession` world, which is minutes. Nothing here needs a world; what
 * is under test is the wire, and the wire is the prototype's.
 *
 * Deliberately NOT stubbed: `_send`, `_stateFrame`, `_srvStamp`, `_reportMissing`, `_reportBack`,
 * `_seatGone`, `_joinLate`, `_sendExport`, `_broadcastState`, `_turnResolved`. Stub one of those and
 * the guard stops watching the code that actually addresses the frame.
 */
function rig() {
	const bridge: any = Object.create(WSBridge.prototype);
	const A = recSock('A');       // host
	const B = recSock('B');       // guest
	const G = recSock('G');       // a stranger at the gate
	bridge.sockets = new Map<string, any>([['A', A], ['B', B]]);
	bridge._lastSnap = new Map();
	bridge._snapSeq = new Map();
	bridge.autoAdvance = false;
	bridge.idleGraceMs = 0;
	bridge.hbIntervalMs = 0;
	bridge._hbTimer = null;
	bridge._graceTimer = null;
	bridge._statsLog = null;
	bridge._noteInput = () => { /* telemetry, not the wire */ };

	bridge.presence = {
		everPaired: true, paused: false,
		saw() {}, seat() {}, back() {}, sweep() { return []; },
		lost() { return true; }, remove() { return true; },
		state() { return 'here'; },
		roleOf(id: string) { return id === 'A' ? 'host' : 'guest'; },
		missing() { return [{ clientId: 'B' }]; },
	};
	bridge.gate = {
		host: 'A', pending: { name: 'Ada' },
		claimHost() { return { accept: true }; },
		requestJoin() {
			return { accept: false, pending: true, modDiff: { add: ['m'] }, world: { modes: [], seed: 's' } };
		},
		release() {}, has() { return true; },
		nameOf() { return ''; }, perksOf() { return []; },
		worldOf() { return null; }, saveOf() { return ''; },
	};
	bridge.session = {
		started: true, turn: 7, players: ['A', 'B'],
		// Distinct per client, so a frame composed for the wrong seat would be visible rather than
		// merely absent — and enough state that `_stateFrame` has something to diff.
		snapshotFor(cid: string) { return { who: cid, at: this.turn }; },
		takeDbg() { return ['a server line']; },
		waitingOn() { return ['B']; },
		apply() { return { kind: 'ui', changed: true }; },
		joinInProgress() { return { seated: true, deferred: false }; },
		exportRun() { return { ok: true, save: 'COMPRESSED-RUN', version: '1.2.3' }; },
		removePlayer() {}, pause() {}, resume() {}, _dbg() {},
		openHostLostDialogue() {}, openPeerLostDialogue() {}, closeHostLostDialogue() {},
	};
	return { bridge, A, B, G };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KDM-274 — every declared message is exercised, and keeps its declaration on the wire', () => {
	let bridge: any, A: any, B: any, G: any;

	beforeAll(async () => {
		({ bridge, A, B, G } = rig());

		// ── the gate: a stranger asks, the guest is told to wait and the HOST is told who is asking.
		bridge._handle(G, { type: 'join', clientId: 'G', role: 'guest', name: 'Ada' }, null);
		bridge.sockets.delete('G');           // asking is not joining — the seat map is untouched

		// ── a refusal, in words (KDM-233 E6). The build-mismatch branch is the one with extras.
		bridge._reject(recSock('X'), { reason: 'build_mismatch', hostBuild: '1.2.3', guestBuild: '1.2.4' });

		// ── a UI input: applied to this player alone, and pushed to a peer it happened to affect.
		bridge.session.apply = () => ({ kind: 'ui', changed: true, notify: ['B'] });
		bridge._handle(A, { type: 'input', action: {} }, 'A');

		// ── the same input when nothing moved: a bare ack, which is a reply and not a state frame.
		bridge.session.apply = () => ({ kind: 'ui', changed: false });
		bridge._handle(A, { type: 'input', action: {} }, 'A');

		// ── a refused action (KDM-225): NOT `waiting`, or the client locks itself out.
		bridge.session.apply = () => ({ kind: 'turn', blocked: 'peace-offer' });
		bridge._handle(A, { type: 'input', action: {} }, 'A');

		// ── an action that entered lockstep: the actor waits, and whoever holds it up is told.
		bridge.session.apply = () => ({ kind: 'turn', advanced: false, waitingOn: ['B'] });
		bridge._handle(A, { type: 'input', action: {} }, 'A');

		// ── the turn resolves, and with it the automatic export (KDM-275) — through the real
		//    `_turnResolved`, so `save_export`'s addressing is decided by the code that ships.
		bridge.session.apply = () => ({ kind: 'turn', advanced: true, exportDue: 'floor' });
		bridge._handle(A, { type: 'input', action: {} }, 'A');

		// ── an export the host asked for, and the same request from a GUEST (refused in words).
		bridge._handle(A, { type: 'export_request' }, 'A');
		bridge._sendExport('B', 'requested');

		// ── somebody joins a running session: they are seated, and the players already here are told.
		bridge.sockets.set('G', G);
		bridge._joinLate('G');
		// …and the seat that could not be given, which is the `error` channel's own path.
		bridge.session.joinInProgress = () => ({ seated: false, reason: 'session_full' });
		bridge._joinLate('G');
		bridge.sockets.delete('G');

		// ── presence: gone, back, and finally gone for good.
		bridge._reportMissing('B');
		bridge._reportBack('B');

		// ── the heartbeat. A real interval, because `_startHeartbeat` is what addresses the ping.
		bridge.hbIntervalMs = 5;
		bridge._startHeartbeat();
		await sleep(40);
		clearInterval(bridge._hbTimer); bridge._hbTimer = null;

		// LAST: this one removes B's socket from the map, so nothing after it could reach B.
		bridge._seatGone(['B'], 'dismissed');
	});

	/** Every frame that reached any recorded socket, with the seat it reached. */
	const allFrames = () => [
		...A.frames.map((f: any) => ({ to: 'A', f })),
		...B.frames.map((f: any) => ({ to: 'B', f })),
		...G.frames.map((f: any) => ({ to: 'G', f })),
	];

	it('COVERAGE — every declared kind was actually put on a socket', () => {
		// The anti-vacuity check, and the one that makes the next outbound message pay its way: a
		// declaration nothing produces is a promise nobody keeps, and the assertions below would
		// pass over it in silence. It is also what turns a DELETED send into a red.
		const seen = new Set(allFrames().map(({ f }) => f.type));
		expect(KINDS.filter((k) => !seen.has(k)),
			'declared in OUTBOUND_MESSAGES but never sent by the exercise above. Either the bridge '
			+ 'stopped sending it, or a new declaration arrived without a way to reach it — and an '
			+ 'unreachable declaration guards nothing.').toEqual([]);
	});

	it('R2 — every required field is on the decoded wire object, every time', () => {
		const missing: string[] = [];
		for (const { to, f } of allFrames()) {
			const spec = OUTBOUND_MESSAGES[f.type];
			if (!spec) { missing.push(`${f.type} → ${to}: undeclared kind reached a socket`); continue; }
			for (const field of spec.required) {
				// `in` on the DECODED object: `JSON.stringify` drops a key whose value is `undefined`,
				// so a field the call site names can still fail to arrive. That elision is precisely
				// the silent drop this guard exists for.
				if (!(field in f)) missing.push(`${f.type}.${field} → ${to}`);
			}
		}
		expect(missing,
			'this field is declared `required` and did not reach the socket. A payload composed '
			+ 'correctly and then not sent leaves every session-level test green (KDM-274).').toEqual([]);
	});

	it('R2 — and no frame carries a field nobody declared', () => {
		const extra: string[] = [];
		for (const { f } of allFrames()) {
			const ok = new Set([...declared(f.type), 'type']);
			for (const k of Object.keys(f)) if (!ok.has(k)) extra.push(`${f.type}.${k}`);
		}
		expect([...new Set(extra)],
			'an undeclared field on the wire is an undeclared promise: nothing stops it disappearing.')
			.toEqual([]);
	});

	it('R4 — a host-only payload never reaches a seat that is not the host', () => {
		const hostOnly = KINDS.filter((k) => OUTBOUND_MESSAGES[k].to === 'host');
		const leaks = allFrames()
			.filter(({ to, f }) => hostOnly.includes(f.type) && to !== 'A')
			.map(({ to, f }) => `${f.type} → ${to}`);
		// Over EVERY frame every socket ever received, not the next one: the failure this pins is a
		// broadcast written where a unicast was meant, and `save_export` is the whole world.
		expect(leaks,
			'a host-only payload reached another seat — the broadcast-where-unicast-was-meant leak '
			+ '(KDM-244 R11), and the one-word `_sendExport(clientId, …)` slip (KDM-275 R10).')
			.toEqual([]);
		// CONTROL: the check above would also read empty if no host-only payload had been sent AT
		// ALL, which is the shape of a guard that has quietly stopped watching.
		expect(A.frames.filter((f: any) => hostOnly.includes(f.type)).length,
			'the host must really have received the host-only payloads').toBeGreaterThan(1);
	});

	it('R4 — and a GUEST asking for the run is refused, rather than answered', () => {
		// The other half of host-only: not merely "the guest was not sent one", but "the guest asked
		// and was told no". `_sendExport('B', …)` above is that request.
		expect(B.frames.some((f: any) => f.type === 'save_export')).toBe(false);
		expect(B.frames.some((f: any) => f.type === 'error' && /host/i.test(String(f.error))),
			'a refusal must be REPORTED — a silent one is indistinguishable from a silent success')
			.toBe(true);
	});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * KDM-287 — `joined.lan`: the address a friend can type, and who is told it
 *
 * The exercise above reaches `joined` through `_joinLate`, which is the RUNNING-session road. The
 * field this task adds rides the PRE-START one, so it needs a rig whose session has not started —
 * and the two claims worth pinning are the ones no per-feature spec would think to make: the port
 * comes from the socket the client is actually on, and a GUEST is never told.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════ */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publicAddresses } = require('../../tools/mp-server/lan-address');

describe('KDM-287 — the host is sent an address a friend can use', () => {
	/** The pre-start `join` road, on a socket that has a real `localPort`. */
	function joinOn(role: 'host' | 'guest', localPort: number) {
		const { bridge } = rig();
		bridge.session.started = false;
		bridge.session.join = () => ({ started: false });
		bridge.gate.claimHost = () => ({ accept: true });
		bridge.gate.requestJoin = () => ({ accept: true, clientId: 'N' });
		const sock: any = recSock('N');
		sock.localPort = localPort;
		bridge._handle(sock, { type: 'join', clientId: 'N', role, name: 'Nyx' }, null);
		return sock.frames.find((f: any) => f.type === 'joined');
	}

	it('the port on the wire is the one the client actually connected to', () => {
		// NOT an env read. `KD_MP_PORT` / `PORT` / `listen(0)` all end up here as `socket.localPort`,
		// so this holds for every one of them — and a second reading of the env could not drift from
		// it, because there is no second reading.
		const joined = joinOn('host', 41337);
		for (const a of joined.lan || []) expect(a).toMatch(/:41337$/);
	});

	it('the host is told exactly what `lan-address.js` says, or is told nothing at all', () => {
		const joined = joinOn('host', 41337);
		const expected = publicAddresses(41337);
		if (expected.length) {
			expect(joined.lan).toEqual(expected);
			// The whole point of the task: not the one address that cannot be shared.
			expect(joined.lan.join(' ')).not.toMatch(/localhost|127\.0\.0\.1/);
		} else {
			// A machine with only loopback — a CI box, a locked-down container. The honest answer is
			// no field, which is why `lan` is declared `optional`; an empty array on the wire would be
			// a promise of an address that does not exist.
			expect('lan' in joined, 'nothing to offer must send nothing, not an empty list').toBe(false);
		}
	});

	it('a GUEST is never told — it has nothing to share, and its `joined` is unchanged', () => {
		const joined = joinOn('guest', 41337);
		expect(joined).toBeTruthy();
		expect('lan' in joined).toBe(false);
	});

	it('a socket with no usable port is answered with no address, not with half of one', () => {
		// A `:undefined` on that screen would be read out and typed in good faith.
		const joined = joinOn('host', 0 as any);
		expect('lan' in joined).toBe(false);
	});
});
