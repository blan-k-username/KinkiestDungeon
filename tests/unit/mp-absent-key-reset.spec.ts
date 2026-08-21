/**
 * KDM — "absent from the bundle ⇒ back to its default", on the CLIENT.
 *
 * The generic capture records a watched global only while it DIFFERS from the post-init baseline
 * (headless-host.js:1862), so a global that returns to its default DROPS OUT of the bundle. The
 * server already reads that correctly — `_restoreGlobals` resets any currently-dirty global the
 * bundle does not carry (headless-host.js:2039-2048). The browser did not: `adoptBundle` assigned
 * only the keys that were present, so a vanished key kept its old value forever.
 *
 * Observed in UAT as a hard crash: after struggling free, `KinkyDungeonStruggleGroups` went back to
 * `[]` on the server and so left the bundle, the client kept `["ItemHands"]`, and
 * `KDDrawStruggleGroups` dereferenced the now-null restraint item on hover
 * (KinkyDungeonHUD.ts:3511) — "Cannot read properties of null (reading 'struggleProgress')".
 *
 * This is the RULE, shared as source text by both runtimes for the same reason kd-codec / kd-delta
 * are: a diff and a merge that drift apart corrupt state silently.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { kdAbsentResets } = require('../../tools/mp-server/kd-absent-reset');

describe('kdAbsentResets — which globals a vanished bundle key must restore', () => {
	it('resets a dirty global the bundle no longer carries', () => {
		const defaults = { KinkyDungeonStruggleGroups: [], KinkyDungeonSlowLevel: 0 };
		const dirty = ['KinkyDungeonStruggleGroups'];
		const globals = { KinkyDungeonSlowLevel: 3 };   // struggle groups back to default ⇒ absent

		expect(kdAbsentResets(defaults, dirty, globals))
			.toEqual([{ name: 'KinkyDungeonStruggleGroups', value: [] }]);
	});

	it('leaves a global the bundle still carries alone', () => {
		const defaults = { KinkyDungeonStruggleGroups: [] };
		const dirty = ['KinkyDungeonStruggleGroups'];
		const globals = { KinkyDungeonStruggleGroups: [{ group: 'ItemHands' }] };

		expect(kdAbsentResets(defaults, dirty, globals)).toEqual([]);
	});

	it('treats a missing globals object as "everything dirty is absent"', () => {
		const defaults = { A: 1 };
		expect(kdAbsentResets(defaults, ['A'], null)).toEqual([{ name: 'A', value: 1 }]);
	});

	it('never resets a name it has no recorded default for', () => {
		// A name we have never adopted has no pristine value to go back to — guessing one would be
		// worse than leaving it, and the server has the same guard (`hasOwnProperty(defs, n)`).
		expect(kdAbsentResets({}, ['Unknown'], {})).toEqual([]);
	});

	it('ignores a dirty name listed twice (idempotent, no duplicate resets)', () => {
		const defaults = { A: 0 };
		expect(kdAbsentResets(defaults, ['A', 'A'], {})).toEqual([{ name: 'A', value: 0 }]);
	});

	it('is exported as browser source text so both runtimes share one rule', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('../../tools/mp-server/kd-absent-reset');
		expect(typeof mod.KD_ABSENT_RESET).toBe('string');
		expect(mod.KD_ABSENT_RESET).toContain('function kdAbsentResets');
	});
});
