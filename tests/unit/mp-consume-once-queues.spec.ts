/**
 * Node-layer (Vitest) — KDM-202: the two LATENT consume-once queues on the state wire.
 *
 * Third in the line that starts at KDM-186 (`KDDamageQueue`) and continues through KDM-196
 * (`KDEventData.shockwaves` / `.sounddesc`). Same criterion, stated once:
 *
 *     if only the RECEIVER'S consumer drains it, the server must not replicate it.
 *
 * The difference from its two predecessors is that neither of these was a live bug. Both are
 * harmless today BY ACCIDENT, and the accident is what this spec removes:
 *
 *  - `KinkyDungeonInputQueue` (KinkyDungeonInput.ts:3) is drained by the SIM: `KDSendInput` pushes,
 *    `KDProcessInputs` (:1690) splices. It stays empty on the server only because `KDSendInput`'s
 *    `process` parameter DEFAULTS to true, so the push and the drain happen inside one synchronous
 *    call. Any caller that passes `process = false` — 184 call sites exist — leaves it non-empty at
 *    capture time. A replicated non-empty queue is GHOST INPUTS on the client: it both gates the
 *    client's per-frame block (`KinkyDungeon.ts:3033` runs the update only when the queue is empty)
 *    and then feeds the peer's inputs into this player's `KDProcessInput`.
 *  - `KDSaveQueue` (KinkyDungeon.ts:7027) is drained by the browser's async save loop (:1520), which
 *    writes `localStorage.KinkyDungeonSave`. It is excluded today only because a real save exceeds
 *    BASELINE_MAX_LEN (20 KB) — and that exclusion is SILENT: unlike the baseline-time oversize set,
 *    a watched name that grows past the cap later is simply `continue`d in `_captureGlobals` and
 *    never reaches `_auditOversize`. Shrink a save below 20 KB, or raise the cap, and a client
 *    writes the SERVER's save over its own.
 *
 * ⚠️ The CONTROL test below is load-bearing. "Absent from the bundle" is trivially satisfiable by a
 * broken capture layer, so every assertion here is paired with `KinkyDungeonStruggleGroups` — a
 * global of the SAME SHAPE (an array, `[]` at baseline, explicitly NOT blacklisted), injected the
 * same way in the same session. If the control ever stops appearing, these tests are vacuous.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost, GLOBAL_BLACKLIST } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

describe('KDM-202 · the exclusion is a DECISION, not an accident', () => {
	it('both queues are named in GLOBAL_BLACKLIST', () => {
		expect(GLOBAL_BLACKLIST, 'sim-drained input queue').toContain('KinkyDungeonInputQueue');
		expect(GLOBAL_BLACKLIST, 'browser-drained save queue').toContain('KDSaveQueue');
	});

	it('the CONTROL global stays out of the blacklist (or every test below is vacuous)', () => {
		expect(GLOBAL_BLACKLIST).not.toContain('KinkyDungeonStruggleGroups');
	});
});

describe('KDM-202 · a non-empty queue does not reach the wire', () => {
	let h: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm202-queues' });
		h.boot();
		h.init({ seed: 'kdm202-queues' });
	}, BOOT_TIMEOUT);

	it('CONTROL: a same-shaped array global injected the same way DOES reach the wire', () => {
		// Proves the capture layer is live for `[] -> [x]` on this host, in this session. Without
		// this, "not in bundle.globals" could mean "nothing is in bundle.globals".
		h.eval(`(function(){ KinkyDungeonStruggleGroups.push({ group: 'KDM202Control' }); })()`);
		expect(h.eval('KinkyDungeonStruggleGroups.length')).toBeGreaterThan(0);
		expect(h.capturePlayer().globals,
			'a diverged non-blacklisted array must be captured').toHaveProperty('KinkyDungeonStruggleGroups');
	}, BOOT_TIMEOUT);

	it('KinkyDungeonInputQueue: queued through the REAL path, never replicated', () => {
		// `process = false` is the game's own "queue it, do not run it" call — the exact upstream
		// change the task names as what breaks today's accidental emptiness. Drive it, do not hand-push.
		h.eval(`(function(){ KDSendInput('Wait', {}, false, false, false); })()`);
		expect(h.eval('KinkyDungeonInputQueue.length'),
			'the repro must actually leave the queue non-empty').toBeGreaterThan(0);

		const globals = h.capturePlayer().globals;
		expect(globals, 'a queued input must not travel as replicated state')
			.not.toHaveProperty('KinkyDungeonInputQueue');
		expect(globals, 'control: the capture layer is still live').toHaveProperty('KinkyDungeonStruggleGroups');
	}, BOOT_TIMEOUT);

	it('KDSaveQueue: not replicated even when it is SMALL enough to pass the size cap', () => {
		// A real save is > BASELINE_MAX_LEN, which is the accidental protection. Inject a tiny entry
		// so the cap cannot be what makes this pass — only the blacklist can.
		h.eval(`(function(){ KDSaveQueue.push({ kdm202: 1 }); })()`);
		const len = h.eval('JSON.stringify(KDSaveQueue).length');
		expect(len, 'the repro is pointless unless it is under the cap').toBeLessThan(20000);

		const globals = h.capturePlayer().globals;
		expect(globals, "the server's save must never be written to a client's storage")
			.not.toHaveProperty('KDSaveQueue');
		expect(globals, 'control: the capture layer is still live').toHaveProperty('KinkyDungeonStruggleGroups');
	}, BOOT_TIMEOUT);

	it('restore leaves both queues alone — a blacklisted name is neither shipped nor reset', () => {
		// The other half of the contract, and it must DISCRIMINATE. `_restoreGlobals` resets every
		// WATCHED global the bundle does not carry back to its baseline default, so while these two
		// are watched a restore drags the receiver's queues back to whatever the SERVER captured.
		// Deliberately leave a length the captured bundle cannot produce (capture holds 1 entry each,
		// baseline holds 0): pre-fix this snaps back to 1, post-fix it stays 3.
		const bundle = h.capturePlayer();
		h.eval(`(function(){
			KinkyDungeonInputQueue = [1, 2, 3].map(function(i){ return { type: 'Wait', data: { i: i } }; });
			KDSaveQueue = [{ kdm202: 1 }, { kdm202: 2 }, { kdm202: 3 }];
		})()`);
		h.restorePlayer(bundle);
		expect(h.eval('({ input: KinkyDungeonInputQueue.length, save: KDSaveQueue.length })'),
			"a restore must not overwrite the receiver's own consume-once queues")
			.toEqual({ input: 3, save: 3 });
	}, BOOT_TIMEOUT);
});
