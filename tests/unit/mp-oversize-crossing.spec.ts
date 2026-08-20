/**
 * KDM-221 — a WATCHED global that crosses BASELINE_MAX_LEN after baseline must not vanish silently.
 *
 * `BASELINE_MAX_LEN` classifies a global as "static data table, not per-player state". That
 * classification is a judgement call, so the epic's contract is that it must never be applied
 * SILENTLY — `_auditOversize` exists precisely to re-hash the excluded set and warn if one of them
 * turns out to mutate (KDM-161/KDM-195).
 *
 * The threshold has three doors and only the first was guarded:
 *
 *   1. `_captureBaseline` — over the cap ⇒ recorded in `_oversize` and audited from then on. GUARDED.
 *   2. `_captureGlobals`  — a WATCHED name whose value has since grown past the cap was `continue`d.
 *      Never added to `_oversize`, so it never reached `_auditOversize`: it simply stopped being
 *      replicated, forever, with no warning.
 *   3. `_restoreGlobals` (the reset half) — the SAME skip. This one is worse than "not replicated":
 *      the global also stops being reset to its post-init default, so the next player inherits
 *      whatever the previous player left there. That is LEAKAGE, the contamination class this epic
 *      exists to remove, and it is exactly the failure the `BASELINE_MAX_LEN` comment block warns
 *      about for the baseline-time set.
 *
 * `KDSaveQueue` was the worked example: `[]` at post-init baseline (hence watched), over 20 KB the
 * moment a real save lands (hence dropped). KDM-202 removed that one instance by blacklisting the
 * name, which does nothing about the hole — hence this spec.
 *
 * The probe is a mod-declared global on purpose: `loadMod` re-baselines, which is what puts a new
 * name into the watch set with a genuine post-init default, and "a mod we never heard of" is the
 * epic's own success criterion.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost, BASELINE_MAX_LEN } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 300_000;
const PROBE = 'KDM221Probe';
const SMALL = 'default-value';

/**
 * Run `fn` with `console.warn` spied, and return the warnings that NAME THE PROBE.
 *
 * ⚠️ The read happens BEFORE `mockRestore()` on purpose. `mockRestore` resets the mock's recorded
 * calls as well as un-patching, so a spy inspected after it has been restored always reports zero
 * calls — which reads as "nothing was warned" no matter what happened. That trap made the
 * "does not re-report" case below pass vacuously in the first draft of this spec: it asserted an
 * empty list against a list that could not have been anything else.
 *
 * Filtering to the probe's own name matters too: `_captureGlobals` also runs `_auditOversize`, which
 * legitimately warns about unrelated oversize globals.
 */
function probeWarningsDuring(fn: () => void): string[] {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		fn();
		return warn.mock.calls.map((c: any[]) => String(c[0])).filter((m: string) => m.includes(PROBE));
	} finally {
		warn.mockRestore();
	}
}

/** Grow the probe past the cap. `size` varies so successive calls are DISTINCT drifts. */
function grow(h: any, size: number) {
	h.eval(`(function(){ globalThis.${PROBE} = 'x'.repeat(${size}); })()`);
}

describe('KDM-221 · a watched global that crosses BASELINE_MAX_LEN', () => {
	let h: any;
	let cleanBundle: any;

	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm221-crossing' });
		h.boot();
		h.init({ seed: 'kdm221-crossing' });
		// Small at post-init ⇒ watched, with `SMALL` as its per-player DEFAULT. loadMod re-baselines.
		h.loadMod(`globalThis.${PROBE} = ${JSON.stringify(SMALL)};`);
		// Captured while everything is still at its default — this is the bundle of a player who never
		// touched the probe, and the one the reset half has to serve correctly in the leak test.
		cleanBundle = h.capturePlayer();
	}, BOOT_TIMEOUT);

	it('precondition — the probe really is watched and really is small', () => {
		expect(h._watchNames, 'the probe must be in the watch set, or every assertion below is vacuous')
			.toContain(PROBE);
		expect(Object.keys(h._oversize), 'the probe must NOT start out classified as oversize')
			.not.toContain(PROBE);
		expect(String(h.eval(`globalThis.${PROBE}`)).length).toBeLessThan(BASELINE_MAX_LEN);
	}, BOOT_TIMEOUT);

	it('AC1 — the crossing is REPORTED, not silently skipped', () => {
		grow(h, BASELINE_MAX_LEN + 1000);
		let captured: any;
		const said = probeWarningsDuring(() => { captured = h._captureGlobals(); });

		// The loss itself is real and is NOT what this task changes — the name is genuinely dropped
		// from per-player state. What must change is that it is announced.
		expect(captured, 'over the cap ⇒ still not replicated; this spec is about the SILENCE')
			.not.toHaveProperty(PROBE);
		// Control for the assertion above: a same-shape name that did NOT cross must be present, so
		// "absent" cannot pass merely because the capture is empty.
		h.eval('(function(){ KinkyDungeonSubmissiveMult = 3.25; })()');
		expect(h._captureGlobals(), 'control: an ordinary diverged global must still be captured')
			.toHaveProperty('KinkyDungeonSubmissiveMult');

		expect(said.join('\n'), `the probe grew past ${BASELINE_MAX_LEN} bytes and was dropped from ` +
			'per-player state without a word. A silent exclusion is the bug class this epic exists to ' +
			'remove.').not.toEqual('');
		expect(h._oversizeChanged, 'a reported crossing must be recorded like any other drift')
			.toContain(PROBE);
	}, BOOT_TIMEOUT);

	it('AC2 — an unchanged value does not re-report on every capture', () => {
		const said = probeWarningsDuring(() => { h._captureGlobals(); h._captureGlobals(); });
		expect(said, 'the alarm was already raised; repeating it for the same value is noise, not ' +
			'signal — this is the KDM-195 re-baseline-on-report contract').toEqual([]);
	}, BOOT_TIMEOUT);

	it('AC2 — but a DISTINCT drift while still over the cap reports again', () => {
		grow(h, BASELINE_MAX_LEN + 5000);
		const said = probeWarningsDuring(() => { h._captureGlobals(); });
		expect(said.join('\n'), 'a global that keeps mutating while over the cap is the case the drift ' +
			'contract exists for — it must keep warning').not.toEqual('');
	}, BOOT_TIMEOUT);

	/**
	 * The leak. Behavioural on purpose: it asserts the world's value after a swap, never an internal,
	 * so a future rewrite of the mechanism is held to the same contract.
	 */
	it('door 3 — a player who never touched the probe does not inherit the oversized value', () => {
		// The probe is currently large, left there by the "player" above.
		expect(String(h.eval(`globalThis.${PROBE}`)).length,
			'precondition: the world must be carrying the oversized value').toBeGreaterThan(BASELINE_MAX_LEN);

		// Swap in a bundle that does NOT carry the probe. "Absent ⇒ default" is the whole
		// contamination-closing rule; the size of the current value must not exempt it.
		h.restorePlayer(cleanBundle);

		expect(h.eval(`globalThis.${PROBE}`), 'the reset half skipped the probe because its CURRENT ' +
			'value is over the cap, so this player inherited the previous player\'s data. A watched ' +
			'global over the cap is dirty BY DEFINITION — it was under the cap at baseline — so it ' +
			'must be reset to its default, not skipped.').toBe(SMALL);
	}, BOOT_TIMEOUT);
});
