/**
 * Node-layer (Vitest) tests for the serve-time bundle patch that works around an
 * UPSTREAM crash reachable from PvP binding.
 *
 * Upstream bug: `NPCRestrain.ts:310` and `:402` do
 *     slot || KDGetNPCBindingSlotForItem(restraint, npcID).sgroup
 * but that helper returns `null` when no binding row/subgroup accepts the item on
 * that NPC (`KDGenRestraintUniform.ts:38`, `:48`). Clicking such an item in the
 * bind menu throws "Cannot read properties of null (reading 'sgroup')". The two
 * sibling call sites in the same file are already guarded (`:877` uses `?.sgroup`,
 * `:445` null-checks), so `?.` is the shape upstream intends.
 *
 * We fix it at SERVE time (demo-server rewrites the bundle on the way out), not on
 * disk: `Game/src/**` stays byte-identical to upstream, matching the branch's
 * zero-game-source-edits principle. `slot_temp` then goes null and the very next
 * line (`if (slot_temp)`) already handles it — the click is a no-op, which is the
 * gated behaviour that should have happened.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { patchServedBundle, SGROUP_PATCH_SITES } = require('../../tools/mp-server/demo-server');

const UNGUARDED = 'KDGetNPCBindingSlotForItem(restraint, npcID).sgroup';
const GUARDED = 'KDGetNPCBindingSlotForItem(restraint, npcID)?.sgroup';
// Second family, same defect shape: an unguarded Array.find() result.
// KDInventoryActions.ts:424/429 — `KinkyDungeonStruggleGroups.find(...)` returns undefined when no
// struggle group matches the worn item's Group, then `.noCut` / `.blocked` throws while the Inventory
// screen is being DRAWN (so the game dies every frame, not just on click).
const SG_CASES = [
	{ bad: '!sg.noCut', good: '!sg?.noCut' },
	{ bad: '!sg.blocked', good: '!sg?.blocked' },
];

describe('serve-time bundle patch: NPCRestrain null-slot crash', () => {
	it('guards the unguarded call sites', () => {
		const src = `let a = slot || ${UNGUARDED}; let b = other || ${UNGUARDED};`;
		const out = patchServedBundle(src);
		expect(out).not.toContain(UNGUARDED);
		expect(out.split(GUARDED).length - 1).toBe(2);
	});

	it('leaves already-guarded call sites untouched', () => {
		const src = `let c = ${GUARDED};`;
		expect(patchServedBundle(src)).toBe(src);
	});

	it('is idempotent (re-patching a patched bundle is a no-op)', () => {
		const once = patchServedBundle(`let a = slot || ${UNGUARDED};`);
		expect(patchServedBundle(once)).toBe(once);
	});

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

	it('finds exactly the expected number of sites in the real bundle', () => {
		const bundle = path.resolve(__dirname, '../../out/main.js');
		if (!fs.existsSync(bundle)) return;  // bundle not built in this environment
		const js = fs.readFileSync(bundle, 'utf8');
		const found = js.split(UNGUARDED).length - 1;
		// 0 ⇒ upstream fixed it (or the emitted text drifted) — the patch is then dead
		// code and this whole workaround should be removed; anything else ⇒ our count
		// is stale and the workaround may be missing a site.
		expect([0, SGROUP_PATCH_SITES]).toContain(found);
		expect(patchServedBundle(js)).not.toContain(UNGUARDED);
	});
});
