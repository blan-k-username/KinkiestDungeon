/**
 * Node-layer (Vitest): KDM-206 — the snapshot delta must be lossless, and it must actually be small.
 *
 * `kd-delta.js` lets a changed `ui` reply carry only what moved instead of a whole 38.3 KB capture.
 * Two things have to hold or the optimisation is a corruption bug:
 *
 *   LOSSLESS  merge(prev, diff(prev, next)) must equal next, for every shape the capture produces —
 *             including deletions, type changes, arrays, and nested objects.
 *   SMALL     the patch for a realistic per-frame change must be orders of magnitude below the full
 *             snapshot. A correct-but-large diff would pass the first property and fix nothing.
 *
 * The size assertion is deliberately stated as a RATIO against the full snapshot, not an absolute byte
 * count, so it measures the encoding rather than the host or today's capture size.
 *
 * Also guards the CONSUME-ONCE contract (KDM-186/196): `snapshotFor` drains pending events, so a
 * one-shot event lives in exactly one snapshot. Those channels must be carried in full by every patch,
 * never diffed — otherwise a lost delta loses the event permanently, which is the anti-deletion trap
 * KDM-196 documents.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { kdDiff, kdMerge } = require('../../tools/mp-server/kd-delta');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 240_000;
const clone = (v: any) => JSON.parse(JSON.stringify(v));
const bytes = (v: any) => JSON.stringify(v).length;

/** merge(prev, diff(prev, next)) === next */
function roundTrip(prev: any, next: any, verbatim?: string[]) {
	const patch = kdDiff(clone(prev), clone(next), verbatim);
	const merged = kdMerge(clone(prev), patch === undefined ? {} : patch);
	return { patch, merged };
}

describe('KDM-206 — snapshot delta codec', () => {
	describe('LOSSLESS across every shape the capture produces', () => {
		const cases: [string, any, any][] = [
			['no change', { a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }],
			['scalar change', { a: 1 }, { a: 2 }],
			['nested scalar change', { g: { KinkyDungeonMoveDirection: { x: 1, y: 0 } } },
				{ g: { KinkyDungeonMoveDirection: { x: 0, y: -1 } } }],
			['key added', { a: 1 }, { a: 1, b: 2 }],
			['key deleted', { a: 1, b: 2 }, { a: 1 }],
			['nested key deleted', { g: { a: 1, b: 2 } }, { g: { a: 1 } }],
			['type change obj->scalar', { a: { b: 1 } }, { a: 5 }],
			['type change scalar->obj', { a: 5 }, { a: { b: 1 } }],
			['type change obj->array', { a: { b: 1 } }, { a: [1, 2] }],
			['array changed', { a: [1, 2, 3] }, { a: [1, 9, 3] }],
			['array shortened', { a: [1, 2, 3] }, { a: [1] }],
			['array of objects', { e: [{ id: 1, x: 2 }] }, { e: [{ id: 1, x: 3 }] }],
			['null handling', { a: null }, { a: { b: 1 } }],
			['to null', { a: { b: 1 } }, { a: null }],
			['false and zero survive', { a: true, b: 1 }, { a: false, b: 0 }],
			['empty object', {}, { a: 1 }],
			['deep nesting', { a: { b: { c: { d: { e: 1 } } } } }, { a: { b: { c: { d: { e: 2 } } } } }],
		];

		for (const [name, prev, next] of cases) {
			it(name, () => {
				const { merged } = roundTrip(prev, next);
				expect(merged).toEqual(next);
			});
		}

		it('an unchanged pair produces NO patch at all (so RULE 2 stays cheap)', () => {
			expect(kdDiff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toBeUndefined();
		});
	});

	describe('CONSUME-ONCE channels are carried in full, never diffed', () => {
		it('a verbatim key is present in the patch even when unchanged', () => {
			const prev = { events: [{ seq: 7, kind: 'noise' }], other: 1 };
			const next = { events: [{ seq: 7, kind: 'noise' }], other: 2 };
			const patch: any = kdDiff(prev, next, ['events']);
			expect(patch.events, 'a drained one-shot channel must ride every patch in full')
				.toEqual({ __kdSet: [{ seq: 7, kind: 'noise' }] });
		});

		it('and still round-trips', () => {
			const prev = { events: [{ seq: 1 }], a: 1 };
			const next = { events: [], a: 2 };
			const { merged } = roundTrip(prev, next, ['events']);
			expect(merged).toEqual(next);
		});
	});

	describe('SMALL — on a real snapshot, not a toy', () => {
		it('a per-frame move-direction patch is <1% of the full snapshot, and round-trips', () => {
			const s: any = new SwapSession({ requiredPlayers: 2, seed: 'kdm206-delta', seedInputKinds: true });
			s.join('A');
			s.join('B');

			s.apply('A', { kdType: 'setMoveDirection', data: { dir: { x: 1, y: 0 }, delta: 1 } });
			const first = clone(s.snapshotFor('A'));
			s.apply('A', { kdType: 'setMoveDirection', data: { dir: { x: 0, y: -1 }, delta: 1 } });
			const second = clone(s.snapshotFor('A'));

			const patch = kdDiff(first, second, ['events']);
			expect(patch, 'a real direction change must produce a patch').toBeDefined();

			const full = bytes(second);
			const delta = bytes(patch);
			const pct = (100 * delta) / full;

			// eslint-disable-next-line no-console
			console.log(`KDM-206 DELTA SIZE  full ${(full / 1024).toFixed(1)}KB -> patch ${delta}B ` +
				`(${pct.toFixed(2)}% of full, ${Math.round(full / delta)}x smaller)`);

			// ANTI-VACUITY: a patch that shrank to nothing would mean the change was lost.
			expect(delta, 'an empty patch means the change was dropped, not compressed').toBeGreaterThan(2);
			// THE POINT: ratio, not an absolute byte count.
			expect(pct, `patch is ${pct.toFixed(2)}% of the full snapshot — the delta is not delivering`)
				.toBeLessThan(1);
			// LOSSLESS on the real thing, which is what the wire depends on.
			expect(kdMerge(clone(first), patch)).toEqual(second);
		}, BOOT_TIMEOUT);
	});
});

/**
 * KDM-206 AC4 — the WIRE guard: a per-frame reply must not carry a whole capture.
 *
 * The codec tests above prove the encoding is lossless and small. This proves the BRIDGE actually
 * uses it, which is a separate failure mode: a correct codec that some send path bypasses would leave
 * `mp-real-input:112` red while every unit test above stayed green.
 *
 * Stated as an invariant ("a steady-state reply carries a delta, and it is a small fraction of a full
 * snapshot"), not as a byte budget — so it holds on any host, unlike the e2e it protects.
 */
describe('KDM-206 — the bridge sends deltas, not captures', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { WSBridge } = require('../../tools/mp-server/ws-bridge');

	it('first state is FULL, subsequent per-frame replies are DELTAS a fraction of its size', async () => {
		const bridge: any = new WSBridge({ requiredPlayers: 2, seed: 'kdm206-wire' });
		const port = await bridge.listen(0);
		const seen: any[] = [];
		// KDM-255 — the join gate is now the only road in, so each socket names the seat it wants. A
		// hand-rolled client rather than `seatPair` because this spec measures RAW frame bytes and
		// must not go through `MPClient`, which merges deltas into `m.snapshot` and would erase the
		// very distinction being asserted.
		const mk = (id: string, role: string) => new Promise<any>((res) => {
			// eslint-disable-next-line no-undef
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			ws.addEventListener('message', (e: any) => {
				const m = JSON.parse(e.data);
				if (m.type === 'state' && id === 'A') seen.push(m);
				// A is the host: it answers the guest's request, which is what admits B.
				if (m.type === 'join_pending') ws.send(JSON.stringify({ type: 'join_answer', accept: true }));
			});
			ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'join', clientId: id, role })); res(ws); });
		});
		try {
			const a: any = await mk('A', 'host');
			await mk('B', 'guest');
			await new Promise((r) => setTimeout(r, 400));       // let the initial state land

			for (const [x, y] of [[1, 0], [0, 1], [-1, 0]]) {
				a.send(JSON.stringify({ type: 'input',
					action: { kdType: 'setMoveDirection', data: { dir: { x, y }, delta: 1 } } }));
				await new Promise((r) => setTimeout(r, 250));
			}

			const full = seen.filter((m) => m.snapshot);
			const deltas = seen.filter((m) => m.delta && !m.snapshot);

			expect(full.length, 'the first state must be a full snapshot to seed the client').toBeGreaterThan(0);
			expect(deltas.length, 'no delta replies were sent — the bridge is still shipping captures')
				.toBeGreaterThan(0);

			const fullBytes = JSON.stringify(full[0].snapshot).length;
			const worst = Math.max(...deltas.map((m) => JSON.stringify(m.delta).length));
			// eslint-disable-next-line no-console
			console.log(`KDM-206 WIRE  full ${(fullBytes / 1024).toFixed(1)}KB · ` +
				`${deltas.length} deltas, largest ${worst}B (${((100 * worst) / fullBytes).toFixed(2)}% of full)`);
			expect(worst / fullBytes,
				`largest delta is ${worst}B against a ${fullBytes}B snapshot — not a delta in practice`)
				.toBeLessThan(0.1);
			// Sequence numbers must be present and monotonic, or the client cannot detect a gap.
			const seqs = seen.map((m) => m.seq);
			expect(seqs.every((s) => typeof s === 'number'), `state frames must carry seq: ${seqs}`).toBe(true);
			for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
		} finally {
			bridge.close();
		}
	}, BOOT_TIMEOUT);
});
