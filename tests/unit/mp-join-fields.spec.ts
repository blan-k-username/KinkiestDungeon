/**
 * KDM-260 — the join handshake's fields reach the gate, and a new one cannot be forgotten.
 *
 * ── THE BUG THIS EXISTS FOR, WHICH ALREADY HAPPENED ───────────────────────────────────────────────
 * `ws-bridge.js` forwarded the `join` message into the gate by naming each field by hand:
 *
 *     this.gate.claimHost(clientId, { name: msg.name, build: msg.build, mods: msg.mods, perks: msg.perks });
 *
 * KDM-239 added a `world` field to the handshake and did not add it here. The failure was SILENT:
 * the gate held an empty declaration, the world was built on KD's defaults, and the entire 605-test
 * unit layer stayed green — because every one of those tests calls `claimHost` / `requestJoin`
 * DIRECTLY and so never crosses the bridge. It was caught only by an e2e that asserted what reached
 * the guest's screen.
 *
 * So there are two tests here and they are deliberately different in kind:
 *
 *  - the DRIFT GUARD (R4) reads the client's own source and fails when it sends a field no role
 *    shape forwards. This is the one that would have caught KDM-239 the day it happened.
 *  - the DISPATCH test (R5) drives a real message through `_handle` and asserts what the gate
 *    actually received. This is the layer no existing unit test occupies.
 *
 * ── R3: `mods_declare` MUST STAY PARTIAL ──────────────────────────────────────────────────────────
 * The third `claimHost` call site (`ws-bridge.js:332`) passes `{mods}` ALONE on purpose. `claimHost`
 * guards each field on `!== undefined`, so a partial object updates the mods and leaves the seated
 * host's name/perks/world alone. "Unifying" it with the host join shape would let a later message
 * overwrite a declaration with absent values. Asserted below so the tidying instinct is checked.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WSBridge, HOST_JOIN_FIELDS, GUEST_JOIN_FIELDS } = require('../../tools/mp-server/ws-bridge');

const BOOTSTRAP = path.resolve(__dirname, '../../tools/mp-server/client/coop-bootstrap.js');

/**
 * Fields the client puts on the join message that are ROUTING, not a declaration (F4).
 * `role` selects the branch; `clientId` identifies the socket. Neither belongs in a seat.
 */
const ROUTING_FIELDS = ['role', 'clientId', 'type'];

describe('KDM-260 — the declared shapes (R1, R2)', () => {
	it('exports a frozen shape per role', () => {
		expect(Array.isArray(HOST_JOIN_FIELDS)).toBe(true);
		expect(Array.isArray(GUEST_JOIN_FIELDS)).toBe(true);
		expect(Object.isFrozen(HOST_JOIN_FIELDS)).toBe(true);
		expect(Object.isFrozen(GUEST_JOIN_FIELDS)).toBe(true);
	});

	it('R2 — the host may declare a world and the guest may not, and that gap is the point', () => {
		expect(HOST_JOIN_FIELDS).toContain('world');
		expect(GUEST_JOIN_FIELDS,
			'a guest declaring a world is KDM-239 A5 — one host, no silent blending').not.toContain('world');
	});

	it('the guest shape is otherwise the host shape — no accidental second difference', () => {
		const hostMinusWorld = [...HOST_JOIN_FIELDS].filter((f: string) => f !== 'world').sort();
		expect([...GUEST_JOIN_FIELDS].sort()).toEqual(hostMinusWorld);
	});
});

describe('KDM-260 — R4: the client cannot send a field the server ignores', () => {
	/** Every `join.<field> = …` the client assigns, read from its own source. */
	function clientJoinFields(): string[] {
		const src = fs.readFileSync(BOOTSTRAP, 'utf8');
		// Strip comments so PROSE mentioning a field cannot invent one.
		const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
		const out = new Set<string>();
		// `join.perks = …`, `join.world = …`  — and the object literal's own `type`/`clientId`.
		for (const m of code.matchAll(/\bjoin\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) out.add(m[1]);
		for (const m of code.matchAll(/var join = \{([^}]*)\}/g)) {
			for (const k of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) out.add(k[1]);
		}
		return [...out];
	}

	it('SELF-CHECK: the reader finds the fields we know are there', () => {
		// A source-reading guard that has quietly stopped matching is a permanent false green, and
		// this one decides whether every other assertion here means anything.
		const found = clientJoinFields();
		expect(found.length, 'a reader that finds nothing would make the guard below vacuous')
			.toBeGreaterThan(3);
		expect(found).toContain('perks');
		expect(found, 'the field KDM-239 added — the whole reason this task exists').toContain('world');
		expect(found).toContain('role');   // routing, filtered below — proves the filter is exercised
	});

	it('DRIFT GUARD — every declared field the client sends is forwarded by some role shape', () => {
		const forwarded = new Set([...HOST_JOIN_FIELDS, ...GUEST_JOIN_FIELDS, ...ROUTING_FIELDS]);
		const orphans = clientJoinFields().filter((f) => !forwarded.has(f));
		expect(orphans,
			'the client sends this on `join` and no role shape forwards it into the gate — add it to '
			+ 'HOST_JOIN_FIELDS / GUEST_JOIN_FIELDS (KDM-260 R1), or to ROUTING_FIELDS if it is not a '
			+ 'seat declaration. This is exactly how KDM-239 shipped a dropped field past a green suite.')
			.toEqual([]);
	});
});

/**
 * A bridge with its gate and reply path replaced, so `_handle` can be driven without a socket, a
 * session or a booted world. The assertion is on what the GATE received — the boundary the
 * direct-call unit tests never cross.
 *
 * ⚠️ `presence` is not optional scaffolding. `_handle` records `presence.saw(clientId)` for EVERY
 * inbound message that carries a client id, before it dispatches on type (KDM-250) — so a rig
 * without it throws on any message except an anonymous one. Learned by omitting it.
 *
 * One rig for all four tests: two near-identical ones drifted apart within minutes of being written.
 */
function rig() {
	const seen: any = { claim: null, request: null };
	const bridge = Object.create(WSBridge.prototype);
	bridge.sockets = new Map();
	bridge.presence = { state: () => 'here', back: () => {}, saw: () => {} };
	bridge.session = { started: false, players: [] };
	bridge.gate = {
		host: null,
		pending: null,
		claimHost(id: string, info: any) { seen.claim = { id, info }; return { accept: true }; },
		requestJoin(id: string, info: any) { seen.request = { id, info }; return { accept: false, pending: true }; },
		worldOf: () => ({ modes: [], seed: '' }),
	};
	bridge._send = () => true;
	bridge._reject = () => {};
	return { bridge, seen };
}

describe('KDM-260 — R5: a real message through _handle reaches the gate', () => {

	/** A join message carrying a DISTINCT value per field, so a mix-up is visible, not merely absent. */
	const FULL_JOIN = {
		type: 'join', clientId: 'H', role: 'host',
		name: 'Nyx', build: 'kd-1.2.3', mods: [{ name: 'm', hash: 'h' }],
		perks: ['Submissive'], world: { modes: ['randomMode'], seed: 'run-42' },
	};

	it('a HOST claim receives every field in the host shape, with the right values', () => {
		const { bridge, seen } = rig();
		bridge._handle({}, FULL_JOIN, null);
		expect(seen.claim, '_handle never reached claimHost').not.toBeNull();
		for (const f of HOST_JOIN_FIELDS) {
			expect(seen.claim.info[f], `host field '${f}' was not forwarded`)
				.toEqual((FULL_JOIN as any)[f]);
		}
	});

	it('a GUEST request receives the guest shape, and its `world` is not readable at all', () => {
		const { bridge, seen } = rig();
		bridge.gate.host = 'H';
		bridge._handle({}, Object.assign({}, FULL_JOIN, { clientId: 'G', role: 'guest' }), null);
		expect(seen.request, '_handle never reached requestJoin').not.toBeNull();
		for (const f of GUEST_JOIN_FIELDS) {
			expect(seen.request.info[f], `guest field '${f}' was not forwarded`)
				.toEqual((FULL_JOIN as any)[f]);
		}
		// R2 — not merely dropped downstream: the gate is never even told.
		expect('world' in seen.request.info,
			'a guest must not be able to declare a world (KDM-239 A5)').toBe(false);
	});

	it('a field the client did not send arrives ABSENT, not as an undefined value (F2)', () => {
		// `claimHost` distinguishes "said nothing" from "said none" with `!== undefined`. A pick that
		// stamped every key would collapse that distinction and make an empty declaration overwrite
		// a real one.
		const { bridge, seen } = rig();
		bridge._handle({}, { type: 'join', clientId: 'H', role: 'host', name: 'Nyx' }, null);
		expect('name' in seen.claim.info).toBe(true);
		expect('perks' in seen.claim.info, 'an unsent field must not be materialised').toBe(false);
		expect('world' in seen.claim.info).toBe(false);
	});
});

describe('KDM-260 — R3: mods_declare stays a PARTIAL re-statement', () => {
	it('carries mods alone, so it cannot blank a seated host\'s other fields', () => {
		const { bridge, seen } = rig();
		bridge.gate.host = 'H';
		bridge._handle({}, { type: 'mods_declare', mods: [{ name: 'm', hash: 'h2' }] }, 'H');
		expect(seen.claim, 'mods_declare never reached claimHost').not.toBeNull();
		expect(seen.claim.info.mods).toBeDefined();
		// The whole point: everything else is ABSENT, so claimHost's `!== undefined` guards leave the
		// host's name/perks/world exactly as they were. Widening this to the host join shape would let
		// a post-publish message silently blank a declaration.
		expect(Object.keys(seen.claim.info),
			'mods_declare must not be "unified" with the host join shape — R3').toEqual(['mods']);
	});

});
