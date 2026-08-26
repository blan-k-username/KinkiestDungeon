/**
 * Node-layer (Vitest) — KDM-277 slice 1: three render dirty flags that belong to an ALREADY decided
 * category and were not in it.
 *
 * `GLOBAL_BLACKLIST` has a section headed "render / dirty flags: the server has no screen", holding
 * `KDDrawUpdate`, `KDVisionUpdate`, `KDUpdateChokes` and `KDAlertCD`. These three are the same
 * category and were absent from it — an inconsistency inside a decided category, not a new judgement
 * call. Found by KDM-273's transition-write audit, which flagged them because a map generation
 * writes all three.
 *
 * ── THE EVIDENCE, NOT THE INTUITION ───────────────────────────────────────────────────────────────
 * Every read of each one is on the draw path, and each is CLEARED only by draw-path code:
 *
 *   KinkyDungeonUpdateLightGrid  written in 8 files ("something changed, re-render"), read at
 *                                KinkyDungeonDraw.ts:1236 and :4906, cleared at :4887 by
 *                                `KDUpdateVision` — a function in the DRAW file.
 *   KDRedrawFog                  a countdown; set to 2 by map gen (KDMapGen.ts:755), the save load
 *                                (KinkyDungeon.ts:7901) and `KDUpdateVision` (Draw.ts:4888); read and
 *                                decremented ONLY by the fog/minimap render
 *                                (KinkyDungeonVision.ts:618, :917).
 *   KDTileModes                  `Record<string, boolean>`, reset by map gen (KDMapGen.ts:43) and
 *                                read by exactly one thing: a draw-time alpha oscillator
 *                                (KinkyDungeonTiles.ts:392-393). Presentation, not state.
 *
 * ── WHY IT MATTERS THAT THE SERVER HAS NO DRAW LOOP ───────────────────────────────────────────────
 * Same argument as `KDDamageQueue` (KDM-186) and the consume-once queues (KDM-202): the clearing code
 * never runs here, so these never return to their baseline and are captured as diverged per-player
 * state on every bundle. A dirty flag is not authoritative state and has no per-player meaning —
 * replicating one just lets the acting player's stale "please redraw" land on the world.
 *
 * ── WHAT KEEPS THIS FROM BEING A VACUOUS GREEN ────────────────────────────────────────────────────
 * Every assertion here is "absent from the bundle", which a broken capture layer satisfies just as
 * happily as a correct blacklist. So each flag is paired with a CONTROL GLOBAL OF THE SAME SHAPE —
 * boolean, number, plain object — diverged from its baseline in the same session and required to be
 * present. Shape matters: a single array control (as KDM-202 used, correctly, for two arrays) would
 * not prove the capture layer handles a bare boolean.
 *
 * Imports the harness under tools/mp-server/** only — never Game/src/** or Scripts/**.
 */
import { describe, it, expect, beforeAll } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const { HeadlessHost, GLOBAL_BLACKLIST } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 240_000;

/** flag → the same-shaped, deliberately NOT blacklisted global that proves capture is live. */
const CONTROL_FOR: Record<string, string> = {
	KinkyDungeonUpdateLightGrid: 'KinkyDungeonInspect',        // boolean
	KDRedrawFog: 'KinkyDungeonTotalSleepTurns',                // number
	KDTileModes: 'KinkyDungeonRescued',                        // Record<string, …>
};

describe('KDM-277 · the render dirty flags are named in the blacklist', () => {
	it('all three are declared world/render state', () => {
		for (const flag of Object.keys(CONTROL_FOR)) {
			expect(GLOBAL_BLACKLIST, `${flag} is a draw-path dirty flag`).toContain(flag);
		}
	});

	it('every control stays OUT of the blacklist, or the tests below are vacuous', () => {
		for (const [flag, control] of Object.entries(CONTROL_FOR)) {
			expect(GLOBAL_BLACKLIST, `${control} is the control for ${flag}`).not.toContain(control);
		}
	});

	it('the flags sit with the render category that already exists', () => {
		// Guards against someone "fixing" this by adding them somewhere unrelated. The four names
		// below are the pre-existing members of that decided category.
		for (const sibling of ['KDDrawUpdate', 'KDVisionUpdate', 'KDUpdateChokes', 'KDAlertCD']) {
			expect(GLOBAL_BLACKLIST, `${sibling} defines the category these three join`).toContain(sibling);
		}
	});
});

describe('KDM-277 · a dirty render flag does not reach the wire', () => {
	let h: any;
	const FLAGS = Object.keys(CONTROL_FOR);

	/**
	 * The POST-INIT value of each flag, measured once before anything here touches them.
	 *
	 * Measured, never hard-coded, and that is not fussiness. The first draft of this spec took
	 * `KDRedrawFog`'s baseline to be `0` from its declaration (`KinkyDungeonVision.ts:7`) when the
	 * post-init value is `2`, because boot runs `KDUpdateVision` (`KinkyDungeonDraw.ts:4888`). The
	 * "is it really diverged?" guard then compared against the wrong number and passed while the flag
	 * sat exactly at its baseline — absent from the bundle for a reason having nothing to do with the
	 * blacklist. That is the vacuous green this file exists to avoid, so the baseline is read from the
	 * booted host.
	 *
	 * It also has to be read ONCE, in `beforeAll`. These tests share a host, so a per-call "value
	 * before I dirtied it" would pick up the PREVIOUS test's dirty value and the divergence check
	 * would compare 277 against 277.
	 */
	let BASELINE: Record<string, string>;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm277-render-flags' });
		h.boot();
		h.init({ seed: 'kdm277-render-flags' });
		BASELINE = h.eval(`(function(){
			var b = {};
			${FLAGS.map((f) => `b[${JSON.stringify(f)}] = JSON.stringify(${f});`).join('\n\t\t\t')}
			return b;
		})()`);
	}, BOOT_TIMEOUT);

	/** Move every flag AND every control to a value the game itself never produces. */
	function dirtyEverything() {
		h.eval(`(function(){
			KinkyDungeonUpdateLightGrid = false;
			KDRedrawFog = 277;
			KDTileModes = { kdm277: true };
			// same-shaped controls
			KinkyDungeonInspect = true;
			KinkyDungeonTotalSleepTurns = 277;
			KinkyDungeonRescued = { kdm277: true };
		})()`);
	}

	it('CONTROL: all three same-shaped controls DO reach the wire', () => {
		// Proves the capture layer is live for boolean, number and object divergence in this session.
		// Without this, "not in bundle.globals" could mean "nothing is in bundle.globals".
		dirtyEverything();
		const globals = h.capturePlayer().globals;
		for (const control of Object.values(CONTROL_FOR)) {
			expect(globals, `a diverged non-blacklisted global must be captured: ${control}`)
				.toHaveProperty(control);
		}
	}, BOOT_TIMEOUT);

	it.each(Object.entries(CONTROL_FOR))(
		'%s is not replicated, while its control %s is',
		(flag, control) => {
			dirtyEverything();
			// The divergence must be REAL. Capture only carries what differs from the baseline, so a
			// flag still sitting at its default would be absent from the bundle for a reason that has
			// nothing to do with the blacklist — and the test below would pass on a broken build.
			expect(h.eval(`JSON.stringify(${flag})`),
				`the repro must move ${flag} off its measured post-init baseline`)
				.not.toBe(BASELINE[flag]);

			const globals = h.capturePlayer().globals;
			expect(globals, `${flag} is a draw-path dirty flag and must not travel as state`)
				.not.toHaveProperty(flag);
			expect(globals, `control: the capture layer is still live (${control})`)
				.toHaveProperty(control);
		}, BOOT_TIMEOUT);

	it('restore leaves the flags alone — a blacklisted name is neither shipped nor reset', () => {
		// The other half of the contract, and it must DISCRIMINATE. `_restoreGlobals` resets every
		// WATCHED global the bundle does not carry back to its baseline default, so while these are
		// watched a restore drags the receiver's flags back to whatever the SERVER had. Values below
		// are ones the captured bundle cannot produce, so a snap-back is visible.
		dirtyEverything();
		const bundle = h.capturePlayer();

		h.eval(`(function(){
			KinkyDungeonUpdateLightGrid = true;
			KDRedrawFog = 9;
			KDTileModes = { receiverOwnValue: true };
		})()`);
		h.restorePlayer(bundle);

		expect(h.eval(`({
			light: KinkyDungeonUpdateLightGrid,
			fog: KDRedrawFog,
			tiles: Object.keys(KDTileModes).join(',')
		})`), "a restore must not overwrite the receiver's own draw-path flags")
			.toEqual({ light: true, fog: 9, tiles: 'receiverOwnValue' });

		// CONTROL, same call: a non-blacklisted global on that same bundle IS installed, so the
		// assertion above cannot be passing merely because restorePlayer did nothing.
		expect(h.eval('KinkyDungeonTotalSleepTurns'),
			'control: the restore really ran and installed per-player state').toBe(277);
	}, BOOT_TIMEOUT);
});
