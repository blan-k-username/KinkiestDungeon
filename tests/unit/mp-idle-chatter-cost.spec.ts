/**
 * Node-layer (Vitest): KDM-203 — REPEATED IDENTICAL per-frame chatter must cost a bare ack, not state.
 *
 * WHY THIS FILE EXISTS. `tests/e2e/mp-real-input.spec.ts:112` ("idle per-frame input costs no state
 * traffic") is red with the byte-identical value **234 KB** against a 100 KB budget, on three separate
 * runs. That determinism is the clue: a contended host produces jitter, not the same number three
 * times. So the red is a MECHANISM, and a mechanism is testable without a browser.
 *
 * The e2e sends the SAME action 200 times:
 *
 *     __coop.sendAction({ kdType: 'setMoveDirection', data: { dir: {x:1,y:0}, delta: 1 } })
 *
 * KDM-186 RULE 2 (`ws-bridge.js`) says an input that moves no state gets a bare `ack`:
 *
 *     if (res.changed === false) { send({type:'ack', …}); return; }
 *     send({type:'state', kind:'ui', …, snapshot: session.snapshotFor(clientId)});   // ~40 KB
 *
 * and `changed` is a whole-bundle djb2 fingerprint diff (`swap-session.js:_stateChanged`). After the
 * first apply, 199 IDENTICAL move-directions cannot have moved the player's state — so the steady
 * state must be `changed === false`. If it is not, some field in the captured bundle churns on every
 * apply regardless of input, which defeats RULE 2 wholesale: every frame of mouse chatter then ships a
 * full snapshot. That is the same defect class as KDM-196/KDM-186 (consume-once presentation
 * replicated as state), and it plausibly also explains the 6-8 fps co-op client in `mp-fps-control`
 * (the client applies a full snapshot every frame) and the >120 ms round-trip in `mp-uat-repro:496`
 * (each reply pays capture + JSON.stringify of the whole bundle).
 *
 * ⚠️ NOT A BUDGET TEST. The owner's constraint on KDM-203 is explicit: the fix may not be a raised
 * threshold or timeout. This asserts the INVARIANT ("identical input ⇒ no state on the wire"), which
 * no amount of host contention can change, rather than a number that a slow machine can miss.
 *
 * The DIAGNOSTIC test below names the churning field, so the fix targets a cause and not a symptom.
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

/** Exactly the action `mp-real-input.spec.ts:112` sends 200 times. */
const CHATTER = { kdType: 'setMoveDirection', data: { dir: { x: 1, y: 0 }, delta: 1 } };

function makeSession(seed: string) {
	const s = new SwapSession({ requiredPlayers: 2, seed, seedInputKinds: true });
	s.join('A');
	s.join('B');
	return s;
}

/** Walk the two bundles and return the dotted paths whose JSON differs. */
function diffPaths(a: any, b: any, path = '', out: string[] = [], depth = 0): string[] {
	if (depth > 6 || out.length > 40) return out;
	const ja = JSON.stringify(a), jb = JSON.stringify(b);
	if (ja === jb) return out;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		out.push(`${path} : ${String(ja).slice(0, 60)} -> ${String(jb).slice(0, 60)}`);
		return out;
	}
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	let leaf = true;
	for (const k of keys) {
		if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
		leaf = false;
		diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out, depth + 1);
	}
	if (leaf) out.push(`${path} : (differs, no differing key)`);
	return out;
}

describe('KDM-203 — repeated identical chatter must not ship state', () => {
	let s: any;
	let kinds: string[] = [];
	let changes: boolean[] = [];

	beforeAll(() => {
		s = new SwapSession({ requiredPlayers: 2, seed: 'kdm203-chatter', seedInputKinds: true });
		s.join('A');
		s.join('B');
		// Warm up: the FIRST use of a UI type legitimately goes through lockstep, and the first apply
		// legitimately changes state (the direction really did move). Send a few, then measure.
		for (let i = 0; i < 3; i++) { s.apply('A', CHATTER); }
		for (let i = 0; i < 12; i++) {
			const r = s.apply('A', CHATTER) || {};
			kinds.push(r.kind);
			changes.push(r.changed);
		}
	}, BOOT_TIMEOUT);

	/**
	 * ANTI-VACUITY. If the chatter never reaches the immediate `ui` path at all, every assertion below
	 * is trivially satisfied by a code path that does nothing. (Same trap KDM-196 documents.)
	 */
	it('ANTI-VACUITY: the chatter is actually applied on the immediate ui path', () => {
		expect(kinds.length).toBeGreaterThan(0);
		expect(kinds.every((k) => k === 'ui'), `kinds seen: ${JSON.stringify(kinds)}`).toBe(true);
	}, BOOT_TIMEOUT);

	/**
	 * THE INVARIANT. 12 identical move-directions in a row moved nothing, so the bridge must answer
	 * each with a bare ack. One `changed === true` in the steady state is one full snapshot on the
	 * wire per frame of mouse movement.
	 */
	it('identical repeated input reports changed === false', () => {
		const changedCount = changes.filter(Boolean).length;
		expect(changedCount,
			`${changedCount} of ${changes.length} IDENTICAL repeats reported a state change, so the ` +
			`bridge answers each with a ~40 KB snapshot instead of a bare ack (KDM-186 RULE 2). ` +
			`changed=${JSON.stringify(changes)}`).toBe(0);
	}, BOOT_TIMEOUT);

	/**
	 * DIAGNOSTIC — names the churning field(s). Skipped-as-passing when the invariant above holds;
	 * its value is the failure message when it does not.
	 */
	it('DIAGNOSTIC: names any bundle field that churns on an identical repeat', () => {
		const d = new SwapSession({ requiredPlayers: 2, seed: 'kdm203-diag', seedInputKinds: true });
		d.join('A');
		d.join('B');
		for (let i = 0; i < 3; i++) d.apply('A', CHATTER);
		const b1 = JSON.parse(JSON.stringify(d.bundles.get('A')));
		d.apply('A', CHATTER);
		const b2 = JSON.parse(JSON.stringify(d.bundles.get('A')));
		const paths = diffPaths(b1, b2);
		expect(paths.length,
			`an identical repeat churned these bundle fields:\n  ${paths.join('\n  ')}`).toBe(0);
	}, BOOT_TIMEOUT);
});
