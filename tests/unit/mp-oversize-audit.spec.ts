/**
 * KDM-195 — the oversize audit: a deliberate classification, a bounded cost, an intact drift contract.
 *
 * `_auditOversize` re-hashes every global excluded from the watch set by `BASELINE_MAX_LEN`. Measured
 * 2026-08-17 that is 22 globals / 5.53 MB, one full pass costing 59-90 ms, and it fired
 * `OVERSIZE GLOBAL CHANGED: KinkyDungeonEnemies` on essentially every audit. Three separate defects:
 *
 *  1. The warning was REAL but ours (`mp-oversize-mutation-probe.spec.ts` attributes it):
 *     `HeadlessHost.spawnAvatar` pushes a `RemotePlayer_<peer>` enemy DEFINITION into
 *     `KinkyDungeonEnemies` (337 → 338 defs). An enemy definition table is shared world data by the
 *     same criterion as `KDEnemiesCache` — so it is blacklisted explicitly, and the warning must stop.
 *  2. The audit was a 90 ms synchronous stall on the request path of a single-threaded server.
 *  3. A ONE-TIME drift was re-reported forever, because the audit never re-baselined what it reported.
 *
 * The drift contract is not negotiable (AC3): an oversize global that starts mutating is still
 * reported LOUDLY. These tests fail if any of the three is "fixed" by silencing.
 */
import { describe, it, expect, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GLOBAL_BLACKLIST, OVERSIZE_AUDIT_EVERY } = require('../../tools/mp-server/headless-host');

const BOOT_TIMEOUT = 300_000;

function session(seed: string) {
	const s: any = new SwapSession({ requiredPlayers: 2, seed, seedInputKinds: true });
	s.join('A');
	s.join('B');
	return s;
}

describe('KDM-195 · AC1 — KinkyDungeonEnemies is classified as shared world data', () => {
	it('is blacklisted by name, so it is neither watched nor audited', () => {
		expect(GLOBAL_BLACKLIST).toContain('KinkyDungeonEnemies');

		const s = session('oversize-ac1-lists');
		const world = s.world;
		world._captureBaseline();
		expect(Object.keys(world._oversize), 'blacklisted ⇒ not in the audited set').not.toContain('KinkyDungeonEnemies');
		expect(world._watchNames, 'blacklisted ⇒ not in the watch set').not.toContain('KinkyDungeonEnemies');
	}, BOOT_TIMEOUT);

	it('stops the warning that our own avatar-def push was raising', () => {
		const s = session('oversize-ac1-warn');
		const world = s.world;
		world._captureBaseline();
		expect(world._auditOversize(true), 'a fresh baseline must start clean').toEqual([]);

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			world.spawnAvatar(1, 1, 'Probe Peer');
			const defs: string[] = world.eval('KinkyDungeonEnemies.map(function(e){return e.name;})');
			expect(defs, 'precondition: the push under test must really have happened')
				.toContain('RemotePlayer_ProbePeer');

			expect(world._auditOversize(true)).not.toContain('KinkyDungeonEnemies');
			expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/OVERSIZE GLOBAL CHANGED/);
		} finally {
			warn.mockRestore();
		}
	}, BOOT_TIMEOUT);

	/**
	 * "World data" is a claim about ownership, so prove it rather than assert it: the avatar def is
	 * NOT part of either player's bundle, and it survives a full swap of the other player — i.e.
	 * excluding it from per-player capture loses nothing.
	 */
	it('loses no per-player state: the def is world-owned and survives a swap', () => {
		const s = session('oversize-ac1-owner');
		const world = s.world;
		world.spawnAvatar(1, 1, 'Probe Peer');

		const bundleA = world.capturePlayer();
		expect(JSON.stringify(bundleA.globals || {}), 'the def must not be riding in a player bundle')
			.not.toMatch(/RemotePlayer_ProbePeer/);

		world.restorePlayer(s.bundles.get('B'));
		expect(
			world.eval("!!KinkyDungeonGetEnemyByName('RemotePlayer_ProbePeer')"),
			'swapping in the other player must not wipe a world-owned enemy def',
		).toBe(true);
	}, BOOT_TIMEOUT);
});

describe('KDM-195 · AC2 — the audit does not stall the request path', () => {
	it('audits a bounded slice per call and covers everything over a cycle', () => {
		const s = session('oversize-ac2');
		const world = s.world;
		world._captureBaseline();
		const all: string[] = Object.keys(world._oversize || {});
		expect(all.length, 'precondition: there must be an oversize set to slice').toBeGreaterThan(4);

		const seen = new Set<string>();
		const sliceMs: number[] = [];
		const sliceSizes: number[] = [];
		let slices = 0;
		// Drive the SCHEDULED path (not force), exactly as _captureGlobals does.
		for (let i = 0; i < OVERSIZE_AUDIT_EVERY * (all.length + 4); i++) {
			const t0 = process.hrtime.bigint();
			const ran = world._auditOversize();
			const dt = Number(process.hrtime.bigint() - t0) / 1e6;
			// null = the counter has not reached OVERSIZE_AUDIT_EVERY, so no slice ran. _lastAuditNames
			// still holds the PREVIOUS slice, so counting on it would count non-events.
			if (ran === null) continue;
			const names: string[] = world._lastAuditNames || [];
			slices++;
			sliceMs.push(dt);
			sliceSizes.push(names.length);
			expect(names.length, 'a slice must be a PROPER subset — that is the whole point')
				.toBeLessThan(all.length);
			names.forEach((n) => seen.add(n));
			if (seen.size === all.length) break;
		}

		// Diagnostic only, never asserted — a timing threshold on a shared host is pure flake.
		const sorted = [...sliceMs].sort((a, b) => a - b);
		const cycle = sliceMs.reduce((a, b) => a + b, 0);
		// eslint-disable-next-line no-console
		console.log(`KDM-195 audit slices: n=${slices}  med ${sorted[sorted.length >> 1].toFixed(2)} ms  `
			+ `max ${Math.max(...sliceMs).toFixed(2)} ms  sizes ${sliceSizes.join(',')}  ms ${sliceMs.map((x) => x.toFixed(1)).join(',')}  (full cycle ${cycle.toFixed(1)} ms, `
			+ 'previously ONE unbounded 59-90 ms pass on the request path)');


		expect(slices, 'the audit must have run more than once to cover the set').toBeGreaterThan(1);
		expect([...seen].sort(), 'every oversize global must still be covered over a full cycle')
			.toEqual([...all].sort());
	}, BOOT_TIMEOUT);
});

describe('KDM-195 · AC3 — drift is still reported LOUDLY', () => {
	it('names a mutating oversize global, and re-reports NEW drift but not the same one forever', () => {
		const s = session('oversize-ac3');
		const world = s.world;
		world._captureBaseline();
		expect(world._auditOversize(true)).toEqual([]);

		const victim = Object.keys(world._oversize)[0];
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			world.eval(`(function(){ ${victim}.__kdm195AuditProbe = 1; })()`);
			expect(world._auditOversize(true), 'a mutating oversize global must be NAMED').toContain(victim);
			expect(warn.mock.calls.map((c) => String(c[0])).join('\n'), 'and reported LOUDLY')
				.toMatch(/OVERSIZE GLOBAL CHANGED/);
			expect(world._oversizeChanged, 'the drift must stay on the record').toContain(victim);

			warn.mockClear();
			expect(world._auditOversize(true), 'the SAME one-time drift is not re-reported forever').toEqual([]);
			expect(warn).not.toHaveBeenCalled();

			world.eval(`(function(){ ${victim}.__kdm195AuditProbe = 2; })()`);
			expect(world._auditOversize(true), 'but FURTHER drift is reported again').toContain(victim);
			expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/OVERSIZE GLOBAL CHANGED/);
		} finally {
			warn.mockRestore();
		}
	}, BOOT_TIMEOUT);
});
