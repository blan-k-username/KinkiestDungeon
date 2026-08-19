/**
 * KDM-194 — the reset half of the swap resets the DIRTY names, not all 2284.
 *
 * `_restoreGlobals` was 50.3% of a 13.58 ms `ui` transaction, and almost all of that was proving
 * that names had NOT changed: 2284 `kdSer` + `hash` calls to find the ~23 that had. It now resets
 * the set `_captureGlobals` already proved dirty (a full exact scan that runs every transaction).
 *
 * The optimisation is only safe while that set can never be UNDER-inclusive — an over-inclusive one
 * costs a little time and is never wrong, but a missing name means a global is not reset, and the
 * next player inherits the previous player's value. That is the contamination bug class the whole
 * epic exists to remove, so these tests attack the set from the directions that could shrink it:
 *
 *   1. a global nobody enumerated, dirtied at RUNTIME after the baseline (KDM-194 AC2);
 *   2. a global dirtied with NO capture in between, so the cached set never saw it;
 *   3. repeated swaps, where an under-inclusive set would accumulate rather than show up once.
 *
 * These are behavioural: they assert the world's values after a swap, never the internals of the
 * cache — so a future rewrite of the mechanism is still held to the same contract.
 */
import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HeadlessHost, RESET_FULL_EVERY } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 300_000;

describe('KDM-194 · the dirty-set reset cannot lose per-player state', () => {
	let h: any;
	beforeAll(() => {
		h = new HeadlessHost({ id: 'kdm194-dirty' });
		h.boot();
		h.init({ seed: 'kdm194-dirty' });
	}, BOOT_TIMEOUT);

	it('AC2 — a NEW global that diverges at runtime is still captured AND still reset', () => {
		// KinkyDungeonSubmissiveMult is a real watched global nobody named in any allowlist. Player A
		// moves it off its default; the bundle must carry it...
		h.eval('(function(){ KinkyDungeonSubmissiveMult = 3.25; })()');
		const a = h.capturePlayer();
		expect(a.globals.KinkyDungeonSubmissiveMult,
			'the capture must carry a global that diverged at runtime').toBe(3.25);

		// ...and a player who does NOT carry it must get the post-init DEFAULT, not A's value. This is
		// the reset half: if the dirty set missed this name, B silently inherits 3.25.
		const bWithout = { ...a, globals: { ...a.globals } };
		delete bWithout.globals.KinkyDungeonSubmissiveMult;
		h.restorePlayer(bWithout);
		expect(h.eval('KinkyDungeonSubmissiveMult'),
			'a player who does not carry this global inherited the previous player\'s value — the ' +
			'reset half missed a dirty name').not.toBe(3.25);
	}, BOOT_TIMEOUT);

	it('resets a global dirtied with NO capture in between (the cache never saw it)', () => {
		const clean = h.capturePlayer();                 // cache is exact here
		delete clean.globals.KinkyDungeonSubmissiveMult;
		h.restorePlayer(clean);
		const def = h.eval('KinkyDungeonSubmissiveMult');

		// Dirty it directly, WITHOUT capturing — so the cached dirty set has no idea. The next restore
		// must still put it back. This is the gap the fallback exists for.
		h.eval('(function(){ KinkyDungeonSubmissiveMult = 99.5; })()');
		h.restorePlayer(clean);
		expect(h.eval('KinkyDungeonSubmissiveMult'),
			'a global dirtied without an intervening capture was not reset — the cached dirty set is ' +
			'under-inclusive and nothing corrects it').toBe(def);
	}, BOOT_TIMEOUT);

	it('does not accumulate contamination over many swaps', () => {
		const base = h.capturePlayer();
		const carrier = { ...base, globals: { ...base.globals, KinkyDungeonSubmissiveMult: 7.5 } };
		const bare = { ...base, globals: { ...base.globals } };
		delete bare.globals.KinkyDungeonSubmissiveMult;

		// More swaps than the periodic full pass, so this cannot pass merely by hitting RESET_FULL_EVERY
		// once, and an under-inclusive set has many chances to show.
		for (let i = 0; i < RESET_FULL_EVERY + 5; i++) {
			h.restorePlayer(carrier);
			expect(h.eval('KinkyDungeonSubmissiveMult'), `carrier lost its value on swap ${i}`).toBe(7.5);
			h.restorePlayer(bare);
			expect(h.eval('KinkyDungeonSubmissiveMult'),
				`the bare player inherited the carrier's value on swap ${i} — contamination`).not.toBe(7.5);
		}
	}, BOOT_TIMEOUT);

	it('a bundle-carried Map still round-trips (the codec path is unchanged)', () => {
		h.eval('(function(){ KinkyDungeonInventory = new Map([["x", new Map([["a",1]])]]); })()');
		const b = h.capturePlayer();
		h.eval('(function(){ KinkyDungeonInventory = new Map(); })()');
		h.restorePlayer(b);
		expect(h.eval('(function(){ var m = KinkyDungeonInventory; ' +
			'return m instanceof Map && m.get("x") instanceof Map ? m.get("x").get("a") : null; })()'),
		'a Map global lost its shape through the dirty-set restore').toBe(1);
	}, BOOT_TIMEOUT);
});
