/**
 * Node-layer (Vitest): KDM-206 — WHERE are the bytes in a changed `ui` reply, and how much of it
 * actually changes between consecutive replies?
 *
 * `mp-real-input.spec.ts:112` ("idle per-frame input costs no state traffic") is red at 195-273 KB
 * against a 100 KB budget. KDM-203 established that KDM-186 RULE 2 works — an input that moves nothing
 * gets a bare ack (`tests/unit/mp-idle-chatter-cost.spec.ts` proves it) — so the 5-7 replies in that
 * test are LEGITIMATE: the real client's draw loop emits `setMoveDirection` carrying the live mouse
 * position, which genuinely moves state. The defect is what a legitimate reply COSTS:
 *
 *     ws-bridge.js →  { type:'state', kind:'ui', snapshot: session.snapshotFor(clientId) }   // whole capture
 *
 * Before designing a delta encoding, measure what a delta could actually buy. That is this file's only
 * job. It answers three questions with numbers:
 *
 *   1. how big is one reply, and how is that split across its top-level keys?
 *   2. between two consecutive replies driven by DIFFERENT move directions (the real per-frame case),
 *      which top-level keys change at all?
 *   3. what fraction of the payload is therefore redundant — i.e. the headroom a diff would recover?
 *
 * DIAGNOSTIC. Asserts only that the measurement is valid (a reply exists, it is non-trivial, and the
 * inputs really did change state). It deliberately asserts NO size threshold — the point is to size a
 * fix, and `mp-real-input:112` already owns the budget assertion.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;

const bytes = (v: any) => { try { return JSON.stringify(v).length; } catch (e) { return -1; } };
const kb = (n: number) => +(n / 1024).toFixed(1);

/** Per-top-level-key size of one reply, largest first. */
function sizeByKey(snap: any) {
	return Object.keys(snap)
		.map((k) => ({ key: k, kb: kb(bytes(snap[k])) }))
		.sort((a, b) => b.kb - a.kb);
}

/**
 * Top-level keys whose serialised value differs between two replies.
 *
 * `kb` here is the size of the WHOLE key, i.e. what the current protocol pays to carry it — NOT the
 * size of the difference. Those two numbers are wildly different (26 KB vs ~14 bytes) and conflating
 * them understates the problem; `movedBytes` below measures the real change.
 */
function changedKeys(a: any, b: any) {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	const out: { key: string; kb: number }[] = [];
	for (const k of keys) {
		if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
		out.push({ key: k, kb: kb(bytes(b[k])) });
	}
	return out.sort((x, y) => y.kb - x.kb);
}

/** Bytes that ACTUALLY differ, found by walking to the deepest differing leaves. */
function movedBytes(a: any, b: any, depth = 0): number {
	if (JSON.stringify(a) === JSON.stringify(b)) return 0;
	if (depth > 5 || a === null || b === null || typeof a !== 'object' || typeof b !== 'object'
		|| Array.isArray(a) !== Array.isArray(b)) return bytes(b);
	let sum = 0;
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) sum += movedBytes(a[k], b[k], depth + 1);
	return sum;
}

describe('KDM-206 — cost of one changed `ui` reply', () => {
	it('profiles reply size and how much of it is redundant between consecutive replies', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'kdm206-reply-size', seedInputKinds: true });
		s.join('A');
		s.join('B');

		// Drive DISTINCT directions, exactly as KD's draw loop does off a moving mouse — each one
		// genuinely moves state, so each legitimately earns a reply under RULE 2.
		const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]];
		const snaps: any[] = [];
		const changes: boolean[] = [];
		for (const [x, y] of dirs) {
			const r = s.apply('A', { kdType: 'setMoveDirection', data: { dir: { x, y }, delta: 1 } }) || {};
			changes.push(r.changed);
			snaps.push(JSON.parse(JSON.stringify(s.snapshotFor('A'))));
		}

		const total = bytes(snaps[snaps.length - 1]);

		// ---- VALIDITY (a vacuous profile is worse than none) -------------------------------------
		expect(snaps.length, 'no replies captured').toBeGreaterThan(1);
		expect(total, 'a reply must be non-trivial for this profile to mean anything').toBeGreaterThan(1000);
		expect(changes.some(Boolean),
			`none of the ${dirs.length} DISTINCT directions moved state, so these are not the ` +
			`legitimate replies the profile is about. changed=${JSON.stringify(changes)}`).toBe(true);

		// ---- THE PROFILE ------------------------------------------------------------------------
		const perKey = sizeByKey(snaps[snaps.length - 1]);
		const diffs = [];
		for (let i = 1; i < snaps.length; i++) {
			const ch = changedKeys(snaps[i - 1], snaps[i]);
			const shippedKb = ch.reduce((sum, c) => sum + c.kb, 0);
			const moved = movedBytes(snaps[i - 1], snaps[i]);
			diffs.push({
				step: i,
				changedKeys: ch.map((c) => `${c.key}:${c.kb}KB`),
				shippedKb: +shippedKb.toFixed(1),
				movedB: moved,
				totalKb: kb(bytes(snaps[i])),
				// The real figure: of the whole reply, how little actually changed.
				amplification: moved > 0 ? Math.round(bytes(snaps[i]) / moved) : -1,
			});
		}

		// ---- DRILL DOWN into the one key that does change --------------------------------------
		// Top-level "changed: bundle" is not actionable — `bundle` is 26 KB. What matters is how much
		// of it a single move-direction actually touches, since that is the floor a delta can reach.
		const drill: string[] = [];
		for (let i = 1; i < snaps.length && drill.length < 12; i++) {
			const prevB = snaps[i - 1].bundle, curB = snaps[i].bundle;
			if (!prevB || !curB) continue;
			for (const sect of Object.keys(curB)) {
				if (JSON.stringify(prevB[sect]) === JSON.stringify(curB[sect])) continue;
				const sub = curB[sect];
				// one more level: which NAMES inside this section moved
				let names: string[] = [];
				let movedBytes = 0;
				if (sub && typeof sub === 'object') {
					for (const n of Object.keys(sub)) {
						if (JSON.stringify((prevB[sect] || {})[n]) === JSON.stringify(sub[n])) continue;
						names.push(`${n}(${bytes(sub[n])}B)`);
						movedBytes += bytes(sub[n]);
					}
				}
				drill.push(`  step ${i} bundle.${sect}: section ${kb(bytes(sub))}KB, ` +
					`actually moved ${kb(movedBytes)}KB across ${names.length} name(s) → ` +
					names.slice(0, 6).join(', ') + (names.length > 6 ? ` …+${names.length - 6}` : ''));
			}
		}

		// eslint-disable-next-line no-console
		console.log('KDM-206 UI REPLY SIZE PROFILE\n' +
			`  one reply = ${kb(total)} KB · changed=${JSON.stringify(changes)}\n` +
			'  by key: ' + perKey.filter((p) => p.kb >= 0.1).map((p) => `${p.key} ${p.kb}KB`).join(' · ') + '\n' +
			diffs.map((d) => `  step ${d.step}: reply ${d.totalKb}KB · ACTUALLY MOVED ${d.movedB}B ` +
				`· amplification ${d.amplification}x · keys shipped [${d.changedKeys.join(', ')}]`).join('\n') +
			'\n── inside the changed key ──\n' + drill.join('\n'));
	}, BOOT_TIMEOUT);
});
