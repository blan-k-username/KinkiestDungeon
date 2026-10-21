/**
 * Node-layer (Vitest) tests for the serve-time bundle patches that work around UPSTREAM
 * crashes (`BUNDLE_PATCHES` in demo-server.js; policy in DESIGN-NOTES.md → "Bundle-patch policy").
 *
 * The first entry this file covered — `NPCRestrain.ts`'s unguarded
 * `KDGetNPCBindingSlotForItem(...).sgroup` — was retired when upstream guarded both reads
 * (`NPCRestrain.ts:312`, `:401`). What remains is the struggle-group family below.
 *
 * We fix it at SERVE time (demo-server rewrites the bundle on the way out), not on
 * disk: `Game/src/**` stays byte-identical to upstream, matching the branch's
 * zero-game-source-edits principle.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { patchServedBundle } = require('../../tools/mp-server/demo-server');

// An unguarded Array.find() result.
// KDInventoryActions.ts:424/429 — `KinkyDungeonStruggleGroups.find(...)` returns undefined when no
// struggle group matches the worn item's Group, then `.noCut` / `.blocked` throws while the Inventory
// screen is being DRAWN (so the game dies every frame, not just on click).
const SG_CASES = [
	{ bad: '!sg.noCut', good: '!sg?.noCut' },
	{ bad: '!sg.blocked', good: '!sg?.blocked' },
];

describe('serve-time bundle patch: struggle-group find() crash', () => {
	it('touches nothing else', () => {
		const src = 'let untouched = KDGetNPCBindingSlotForItem(r, id)?.sgroup; let x = 1;';
		expect(patchServedBundle(src)).toBe(src);
	});

	it('guards the struggle-group find() reads (Cut action crash on the Inventory screen)', () => {
		for (const c of SG_CASES) {
			const out = patchServedBundle(`return !KDGetCurse(item) && ${c.bad};`);
			expect(out).toContain(c.good);
			expect(out).not.toContain(c.bad);
			expect(patchServedBundle(out)).toBe(out);          // idempotent
		}
	});

	it('leaves a similarly-named but different expression alone', () => {
		const src = 'let x = !sgOther.noCut; let y = other.sg.noCutSomething;';
		expect(patchServedBundle(src)).toBe(src);
	});

	it('actually removes the unguarded reads from the real bundle', () => {
		const bundle = path.resolve(__dirname, '../../out/main.js');
		if (!fs.existsSync(bundle)) return;  // bundle not built in this environment
		const out = patchServedBundle(fs.readFileSync(bundle, 'utf8'));
		for (const c of SG_CASES) expect(out).not.toContain(c.bad);
		// Site COUNTS (stale / upstream-fixed) are policed by mp-bundle-patch-policy.spec.ts —
		// one audit for every entry, rather than a per-entry copy of the same assertion here.
	});
});
