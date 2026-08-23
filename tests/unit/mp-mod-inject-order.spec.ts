/**
 * KDM-249 Phase A — where the mod pre-seed script sits in the injected list, and why it matters.
 *
 * `client/coop-mods.js` sets `KDGetMods = true` (`KDMods.ts:9`) — KD's own "the auto-loader has been
 * handled" latch — so that KD's per-frame auto-load-and-execute stands down and `KDExecuted` stays
 * `false` for us to drive. Two ordering facts have to hold for that to work, and neither is visible
 * at the point where the bug would appear:
 *
 *   1. IT MUST BE INJECTED AT ALL. A latch that never runs is not a subtle failure — the guest gets
 *      whatever KD would have done, which on default settings (`AutoLoadMods: false`,
 *      `KinkyDungeonVibe.ts:145`) is *no mods*.
 *   2. IT MUST BE EVALUATED AFTER `out/main.js`. `KDGetMods` is a bundle `let`-global, not a property
 *      of `globalThis` (repo CLAUDE.md), so the assignment is a BARE one into the bundle's lexical
 *      scope. Run it before the bundle and the same line becomes a TDZ throw instead of a latch.
 *
 * Fact 2 holds because `index.html` loads `out/main.js` inside `<body>` and the injected tags are
 * appended just before `</body>` — so it is really a property of `index.html`, which is upstream's
 * file and can change under us. That is exactly why it is asserted here rather than assumed.
 *
 * What is deliberately NOT asserted: that `coop-mods.js` is FIRST in the list. Classic scripts run
 * to completion in order with no frame between them, so no frame can occur between the first and
 * last injected tag — pinning it to index 0 would be a test of an arbitrary choice rather than of a
 * requirement.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { INJECT } = require('../../tools/mp-server/demo-server');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MODS_SCRIPT = '/tools/mp-server/client/coop-mods.js';
const BOOTSTRAP = '/tools/mp-server/client/coop-bootstrap.js';

describe('KDM-249 Phase A — the pre-seed script is injected (R7, risk 4)', () => {
	it('coop-mods.js is in the injected list', () => {
		expect(INJECT).toContain(MODS_SCRIPT);
	});

	it('the file it names actually exists — an injected 404 is a silent no-latch', () => {
		expect(fs.existsSync(path.join(REPO_ROOT, MODS_SCRIPT.replace(/^\//, '')))).toBe(true);
	});

	it('runs before coop-bootstrap.js, which is what sends the join', () => {
		// The declaration this builds rides on the `join` message. Bootstrap first would mean the
		// handshake goes out before there is anything to declare.
		expect(INJECT.indexOf(MODS_SCRIPT)).toBeLessThan(INJECT.indexOf(BOOTSTRAP));
	});

	it('is injected exactly once — a second copy would run the latch twice', () => {
		expect(INJECT.filter((s: string) => s === MODS_SCRIPT).length).toBe(1);
	});

	it('index.html still loads out/main.js before </body>, so every injected tag runs AFTER the bundle', () => {
		// The TDZ constraint, asserted against upstream's own file. If a future index.html moved the
		// bundle to <head defer> or after the injection point, `KDGetMods = true` would throw instead
		// of latching — and the symptom would be "mods stopped loading", nowhere near this cause.
		const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
		const bundle = html.indexOf('out/main.js');
		const close = html.indexOf('</body>');
		expect(bundle).toBeGreaterThan(-1);
		expect(close).toBeGreaterThan(-1);
		expect(bundle).toBeLessThan(close);
	});
});
