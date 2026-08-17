/**
 * KDM-195 diagnostic — what is inside the oversize set, what does it cost, and what actually moves?
 *
 * `_auditOversize` re-hashes the globals excluded from the watch set by `BASELINE_MAX_LEN`. This
 * prints the per-global cost that sizes OVERSIZE_AUDIT_BUDGET_MS, and re-checks the classification
 * claim ("they are static definition tables") against real turns. It is a DIAGNOSTIC: it asserts only
 * that it genuinely observed something — a vacuous probe is worse than none — and fixes nothing.
 *
 * The one mutation this probe originally caught was OURS: `spawnAvatar` pushes a `RemotePlayer_<peer>`
 * def into `KinkyDungeonEnemies` (337 → 338), which is why that global is now blacklisted as world
 * data. The behaviour that follows from it is locked down in `mp-oversize-audit.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;
const TURNS = 6;

describe('KDM-195 — the oversize set: cost and stability', () => {
	it('prints the per-global audit cost and any global that moves over real turns', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'oversize-probe', seedInputKinds: true });
		s.join('A');
		s.join('B');
		const world = s.world;

		// Force the baseline the audit compares against, so "before" is exactly the audit's "before".
		world._captureBaseline();
		const overNames: string[] = Object.keys(world._oversize || {});
		expect(overNames.length, 'the probe is meaningless with an empty oversize set').toBeGreaterThan(0);
		expect(world._auditOversize(true), 'a fresh baseline must start clean').toEqual([]);

		// --- what does one audit pass cost, per global? -------------------------------------------
		const rows = overNames.map((n) => {
			const t0 = process.hrtime.bigint();
			const r = world.eval(`(function(){
				var v; try { v = eval(${JSON.stringify(n)}); } catch (e) { return null; }
				var s; try { s = JSON.stringify(v); } catch (e) { return null; }
				var x = 5381, i = s.length; while (i) { x = (x*33) ^ s.charCodeAt(--i); }
				return { len: s.length, h: x >>> 0 };
			})()`);
			return { n, kb: r ? r.len / 1024 : 0, dt: Number(process.hrtime.bigint() - t0) / 1e6 };
		}).sort((a, b) => b.dt - a.dt);
		const total = rows.reduce((a, r) => a + r.dt, 0);

		// --- does the "static definition table" classification hold over real turns? ---------------
		for (let t = 0; t < TURNS; t++) {
			const dir = { x: 0, y: t % 2 ? 1 : -1 };
			s.submit('A', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
			s.submit('B', { kdType: 'move', data: { dir, delta: 1, AllowInteract: true } });
		}
		const movedByTurns = world._auditOversize(true) || [];

		// --- and does spawning a peer avatar still touch a WATCHED global? -------------------------
		world.spawnAvatar(1, 1, 'Probe Peer');
		const defs: string[] = world.eval('KinkyDungeonEnemies.map(function(e){return e.name;})');
		const movedBySpawn = world._auditOversize(true) || [];

		// eslint-disable-next-line no-console
		console.log([
			'',
			`KDM-195 oversize set: ${rows.length} globals, one full pass ${total.toFixed(1)} ms`,
			'-'.repeat(78),
			...rows.map((r) => `${r.n.padEnd(34)} ${r.kb.toFixed(0).padStart(7)} KB  ${r.dt.toFixed(2).padStart(8)} ms`),
			'-'.repeat(78),
			`changed after ${TURNS} real turns : ${movedByTurns.length ? movedByTurns.join(', ') : '(none)'}`,
			`changed after spawnAvatar     : ${movedBySpawn.length ? movedBySpawn.join(', ') : '(none)'}`,
			`  (spawnAvatar appended ${defs.filter((d) => d.startsWith('RemotePlayer')).length} RemotePlayer def(s) `
			+ 'to the blacklisted KinkyDungeonEnemies)',
			'',
		].join('\n'));

		expect(total, 'the audit must really be re-serialising something').toBeGreaterThan(0);
		expect(defs, 'precondition: the avatar def push must really happen').toContain('RemotePlayer_ProbePeer');
	}, BOOT_TIMEOUT);
});
