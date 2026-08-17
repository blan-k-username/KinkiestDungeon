/**
 * KDM-186 item 1 — WHERE does the ~1 s per-transaction cost go?
 *
 * The owner measured a median 1067 ms round-trip per presentation (`ui`) input in a real browser,
 * with samples 642-1920 ms at 400 ms spacing — i.e. it is the cost of ONE transaction, not backlog.
 * Two fixes were proposed (client-side prediction + server-side coalescing); both MASK a cost rather
 * than remove it, and this task has already killed four hypotheses that were argued rather than
 * measured. So: measure the transaction first.
 *
 * This profiles the exact stage sequence `SwapSession.apply()` runs for a `ui` input
 * (swap-session.js:294-317) plus the reply path, and reports per-stage medians. It is a DIAGNOSTIC:
 * it asserts only that the thing being profiled genuinely happened (test-validity lesson 1 — a
 * vacuous profile is worse than none), never a timing threshold, which would be pure flake on a
 * shared host.
 *
 * Deliberately node-layer, no browser: this measures SERVER CPU per transaction, which the harness
 * reproduces faithfully. (Rate-dependent effects do NOT reproduce here — test-validity lesson 4 —
 * but a per-transaction cost is exactly what a headless harness measures correctly.)
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SwapSession } = require('../../tools/mp-server/swap-session');

const BOOT_TIMEOUT = 300_000;

/** One frame of the client's draw loop — the input whose round-trip the owner measured. */
const CHATTER = { kdType: 'setMoveDirection', data: { dir: { x: 0, y: -1 } } };

const ITERATIONS = 15;

function median(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function ms(fn: () => any) {
	const t0 = process.hrtime.bigint();
	const v = fn();
	return { dt: Number(process.hrtime.bigint() - t0) / 1e6, v };
}

describe('KDM-186 — per-transaction cost of one `ui` input', () => {
	it('profiles each stage of the ui apply path', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'ui-latency-profile', seedInputKinds: true });
		s.join('A');
		s.join('B');
		const world = s.world;

		// ---- PRECONDITIONS (lesson 1: prove the thing under test actually happens) ----------------
		expect(s.started, 'session must be started for apply() to run').toBe(true);
		expect(
			s.inputKind.get('setMoveDirection'),
			'this profile only means anything if setMoveDirection takes the immediate `ui` branch',
		).toBe('ui');
		const watchCount = world._watchNames ? world._watchNames.length : 0;
		expect(watchCount, 'the divergence scan must have a real watch set').toBeGreaterThan(0);

		// ---- WARM UP (JIT + first-capture baseline) -----------------------------------------------
		for (let i = 0; i < 3; i++) s.apply('A', CHATTER);

		// ---- PROFILE -------------------------------------------------------------------------------
		const stage: Record<string, number[]> = {
			restorePlayer: [], applyInputObserved: [], capturePlayer: [],
			fingerprint: [], parkGlobalPlayer: [], snapshotFor: [],
			'  ├ capturePlayer:gameData': [], '  ├ capturePlayer:_captureGlobals': [],
		};
		let bundleBytes = 0, snapBytes = 0, globalsCount = 0;

		for (let i = 0; i < ITERATIONS; i++) {
			const bundle = s.bundles.get('A');
			stage.restorePlayer.push(ms(() => world.restorePlayer(bundle)).dt);
			stage.applyInputObserved.push(
				ms(() => world.applyInputObserved(CHATTER.kdType, { dir: { x: 0, y: i % 2 ? -1 : 1 } })).dt);

			// capturePlayer, split into its two halves so the answer names a line, not a function.
			const gd = ms(() => world.eval(
				'(typeof KDGameData !== "undefined") ? JSON.parse(JSON.stringify(KDGameData)) : undefined'));
			const gl = ms(() => world._captureGlobals());
			stage['  ├ capturePlayer:gameData'].push(gd.dt);
			stage['  ├ capturePlayer:_captureGlobals'].push(gl.dt);
			stage.capturePlayer.push(gd.dt + gl.dt);
			const newBundle = { v: 1, gameData: gd.v, globals: gl.v };
			s.bundles.set('A', newBundle);
			globalsCount = Object.keys(gl.v || {}).length;

			stage.fingerprint.push(ms(() => s._fingerprint(newBundle)).dt);
			stage.parkGlobalPlayer.push(ms(() => world.parkGlobalPlayer(1, 1)).dt);
			stage.snapshotFor.push(ms(() => {
				const snap = s.snapshotFor('A');
				snapBytes = JSON.stringify(snap).length;
			}).dt);
			bundleBytes = JSON.stringify(newBundle).length;
		}

		// ---- REPORT ---------------------------------------------------------------------------------
		const applyStages = ['restorePlayer', 'applyInputObserved', 'capturePlayer', 'fingerprint', 'parkGlobalPlayer'];
		const applyTotal = applyStages.reduce((a, k) => a + median(stage[k]), 0);
		const lines = [
			'',
			`KDM-186 ui-input transaction profile  (n=${ITERATIONS}, watchNames=${watchCount}, `
			+ `capturedGlobals=${globalsCount}, bundle=${(bundleBytes / 1024).toFixed(1)}KB, `
			+ `snapshot=${(snapBytes / 1024).toFixed(1)}KB)`,
			'-'.repeat(78),
		];
		const order = [
			'restorePlayer', 'applyInputObserved', 'capturePlayer',
			'  ├ capturePlayer:gameData', '  ├ capturePlayer:_captureGlobals',
			'fingerprint', 'parkGlobalPlayer',
		];
		for (const k of order) {
			const xs = stage[k];
			const med = median(xs);
			const share = k.startsWith(' ') ? '' : `${((med / applyTotal) * 100).toFixed(1).padStart(5)}%`;
			lines.push(`${k.padEnd(34)} med ${med.toFixed(2).padStart(8)} ms  `
				+ `min ${Math.min(...xs).toFixed(2).padStart(8)}  max ${Math.max(...xs).toFixed(2).padStart(8)}  ${share}`);
		}
		lines.push('-'.repeat(78));
		lines.push(`${'APPLY TOTAL (server CPU per ui input)'.padEnd(34)} med ${applyTotal.toFixed(2).padStart(8)} ms`);
		lines.push(`${'snapshotFor (reply, when changed)'.padEnd(34)} med ${median(stage.snapshotFor).toFixed(2).padStart(8)} ms`);
		lines.push('');
		// eslint-disable-next-line no-console
		console.log(lines.join('\n'));

		expect(applyTotal, 'a transaction must have taken measurable time').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	/**
	 * The first test says WHERE the time is (restorePlayer + _captureGlobals ≈ 97%). Both are the same
	 * shape: a full `_watchNames` pass doing `eval(n)` + serialise + hash per name. This isolates that
	 * scan so the answer names a LOOP, not a function — and measures what the scan actually YIELDS,
	 * which is the number that decides whether the cost is inherent or waste.
	 */
	it('isolates the divergence scan inside restore and capture', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'ui-latency-scan', seedInputKinds: true });
		s.join('A');
		s.join('B');
		const world = s.world;
		for (let i = 0; i < 3; i++) s.apply('A', CHATTER);

		const names: string[] = world._watchNames || [];
		expect(names.length, 'precondition: there is a watch set to scan').toBeGreaterThan(0);

		// The scan, with NO restore and NO capture attached: exactly the per-name work both halves do.
		world._context.__KD_BASE_H = world._baseline;
		const scanSrc = '(function(){\n'
			+ '  var names = ' + JSON.stringify(names) + ', base = globalThis.__KD_BASE_H, n = 0, dirty = 0;\n'
			+ '  function hash(s){ var x = 5381, i = s.length; while (i) { x = (x*33) ^ s.charCodeAt(--i); } return x>>>0; }\n'
			+ '  for (var i = 0; i < names.length; i++) {\n'
			+ '    var nm = names[i], v;\n'
			+ '    try { v = eval(nm); } catch (e) { continue; }\n'
			+ '    if (v === undefined || typeof v === "function") continue;\n'
			+ '    var str; try { str = JSON.stringify(v); } catch (e) { continue; }\n'
			+ '    if (str === undefined) continue;\n'
			+ '    n++;\n'
			+ '    if (hash(str) !== base[nm]) dirty++;\n'
			+ '  }\n'
			+ '  return { scanned: n, dirty: dirty };\n'
			+ '})()';
		const scan: number[] = [];
		let scanned = 0, dirty = 0;
		for (let i = 0; i < ITERATIONS; i++) {
			const r = ms(() => world.eval(scanSrc));
			scan.push(r.dt);
			scanned = r.v.scanned; dirty = r.v.dirty;
		}

		// A bare eval of the same shape with NO per-name work — the floor the bridge itself costs.
		const floor: number[] = [];
		for (let i = 0; i < ITERATIONS; i++) floor.push(ms(() => world.eval('1+1')).dt);

		const bundle = s.bundles.get('A');
		const globalsInBundle = Object.keys((bundle && bundle.globals) || {}).length;
		const medScan = median(scan);

		// eslint-disable-next-line no-console
		console.log([
			'',
			'KDM-186 divergence-scan isolation',
			'-'.repeat(78),
			'watchNames                         ' + String(names.length).padStart(8),
			'  of which serialisable+scanned    ' + String(scanned).padStart(8),
			'  of which DIVERGED (the yield)    ' + String(dirty).padStart(8),
			'globals carried in the bundle      ' + String(globalsInBundle).padStart(8),
			'one scan pass                  med ' + medScan.toFixed(2).padStart(8) + ' ms   '
				+ '(~' + (medScan * 1000 / Math.max(1, scanned)).toFixed(1) + ' us/name)',
			'bare eval bridge floor         med ' + median(floor).toFixed(3).padStart(8) + ' ms',
			'the ui transaction runs this scan TWICE (restore reset-pass + capture divergence-pass)',
			'',
		].join('\n'));

		expect(scanned, 'the scan must actually have serialised globals').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	/**
	 * KDM-186 gap-closing: my 16 ms is ~60x below the owner's measured 1067 ms. `boot()` DOES generate
	 * a real dungeon (`KinkyDungeonStartNewGame(false)` → `KinkyDungeonCreateMap`), so map generation
	 * is not the difference. The remaining difference is STATE ACCUMULATION — the owner's session has
	 * run for many turns with enemies engaged. Scan cost is O(names x serialised size), so if diverged
	 * state grows with play, the transaction gets more expensive the longer a session lasts.
	 *
	 * This measures that directly (fresh vs aged) and NAMES the globals that dominate the scan, so the
	 * next decision is about specific state rather than about "the scan" in the abstract.
	 */
	it('measures whether transaction cost grows as a session accumulates state', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'ui-latency-aging', seedInputKinds: true });
		s.join('A');
		s.join('B');
		const world = s.world;

		const worldSize = world.eval('({ entities: KDMapData.Entities.length, grid: KDMapData.Grid.length, '
			+ 'level: (typeof KDGameData !== "undefined" && KDGameData.Level) || 0 })');
		expect(worldSize.grid, 'precondition: this must be a REAL generated dungeon, not an empty map')
			.toBeGreaterThan(0);

		const cost = () => {
			const xs: number[] = [];
			for (let i = 0; i < ITERATIONS; i++) {
				const bundle = s.bundles.get('A');
				const t0 = process.hrtime.bigint();
				world.restorePlayer(bundle);
				world.applyInputObserved('setMoveDirection', { dir: { x: 0, y: i % 2 ? -1 : 1 } });
				const nb = world.capturePlayer();
				s._fingerprint(nb);
				world.parkGlobalPlayer(1, 1);
				xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
				s.bundles.set('A', nb);
			}
			return median(xs);
		};

		/** Top watched globals by serialised size — what the two scans are actually paying for. */
		const heaviest = () => {
			world._context.__KD_BASE_H = world._baseline;
			return world.eval('(function(){\n'
				+ '  var names = ' + JSON.stringify(world._watchNames || []) + ', out = [], total = 0;\n'
				+ '  for (var i = 0; i < names.length; i++) {\n'
				+ '    var n = names[i], v; try { v = eval(n); } catch (e) { continue; }\n'
				+ '    if (v === undefined || typeof v === "function") continue;\n'
				+ '    var s; try { s = JSON.stringify(v); } catch (e) { continue; }\n'
				+ '    if (s === undefined) continue;\n'
				+ '    total += s.length; out.push([n, s.length]);\n'
				+ '  }\n'
				+ '  out.sort(function(a,b){ return b[1]-a[1]; });\n'
				+ '  return { total: total, top: out.slice(0, 12) };\n'
				+ '})()');
		};

		for (let i = 0; i < 3; i++) s.apply('A', CHATTER);
		const fresh = cost();
		const freshH = heaviest();

		// AGE the session with REAL lockstep turns (both players must act) — the same path a played
		// session takes. Not a synthetic mutation: the point is whatever real play leaves behind.
		const TURNS = 40;
		for (let t = 0; t < TURNS; t++) {
			s.apply('A', { kdType: 'move', data: { dir: { x: 0, y: t % 2 ? 1 : -1 }, delta: 1, AllowInteract: true } });
			s.apply('B', { kind: 'wait' });
		}
		const agedTick = world.tick();
		const aged = cost();
		const agedH = heaviest();

		const fmt = (h: any) => h.top.map((r: any[]) =>
			'      ' + String(r[0]).padEnd(38) + (r[1] / 1024).toFixed(1).padStart(9) + ' KB').join('\n');

		// eslint-disable-next-line no-console
		console.log([
			'',
			'KDM-186 does the ui transaction get more expensive as a session ages?',
			'-'.repeat(78),
			'world at boot: entities=' + worldSize.entities + ' grid=' + worldSize.grid
				+ ' level=' + worldSize.level + '   (real generated dungeon)',
			'',
			'  FRESH session          transaction med ' + fresh.toFixed(2).padStart(8) + ' ms'
				+ '   watched-state total ' + (freshH.total / 1024).toFixed(1) + ' KB',
			fmt(freshH),
			'',
			'  AFTER ' + TURNS + ' real turns (tick=' + agedTick + ')  transaction med '
				+ aged.toFixed(2).padStart(8) + ' ms   watched-state total ' + (agedH.total / 1024).toFixed(1) + ' KB',
			fmt(agedH),
			'',
			'  growth: x' + (aged / fresh).toFixed(2) + ' time, x'
				+ (agedH.total / Math.max(1, freshH.total)).toFixed(2) + ' serialised bytes',
			'',
		].join('\n'));

		expect(agedTick, 'precondition: the aging loop must really have advanced turns').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);

	/**
	 * The remaining suspect for the 60x gap is not the STEADY cost but a periodic STALL. Every
	 * OVERSIZE_AUDIT_EVERY (200) captures, `_auditOversize` re-hashes the globals excluded from the
	 * watch set for exceeding BASELINE_MAX_LEN (20 KB) — i.e. the very biggest ones, and the audit is
	 * already known to be warning about a real `KinkyDungeonEnemies` divergence. At ~60 captures/s that
	 * fires every ~3 s, and a multi-hundred-ms stall would show up exactly as the owner's spread
	 * (median 1067 ms, samples 642-1920 ms) rather than as a raised floor.
	 */
	it('measures the periodic oversize audit stall', () => {
		const s: any = new SwapSession({ requiredPlayers: 2, seed: 'ui-latency-audit', seedInputKinds: true });
		s.join('A');
		s.join('B');
		const world = s.world;
		for (let i = 0; i < 3; i++) s.apply('A', CHATTER);

		const over = world._oversize || {};
		const overNames = Object.keys(over);
		expect(overNames.length, 'precondition: there must be an oversize set for the audit to scan')
			.toBeGreaterThan(0);

		const sizes = world.eval('(function(){\n'
			+ '  var names = ' + JSON.stringify(overNames) + ', out = [], total = 0;\n'
			+ '  for (var i = 0; i < names.length; i++) {\n'
			+ '    var n = names[i], v; try { v = eval(n); } catch (e) { continue; }\n'
			+ '    var s; try { s = JSON.stringify(v); } catch (e) { continue; }\n'
			+ '    if (s === undefined) continue;\n'
			+ '    total += s.length; out.push([n, s.length]);\n'
			+ '  }\n'
			+ '  out.sort(function(a,b){ return b[1]-a[1]; });\n'
			+ '  return { total: total, top: out.slice(0, 8) };\n'
			+ '})()');

		const audit: number[] = [];
		for (let i = 0; i < 8; i++) audit.push(ms(() => world._auditOversize(true)).dt);
		const medAudit = median(audit);

		// eslint-disable-next-line no-console
		console.log([
			'',
			'KDM-186 periodic oversize audit (fires every ' + 200 + ' captures)',
			'-'.repeat(78),
			'oversize globals excluded from the watch set  ' + String(overNames.length).padStart(6),
			'their combined serialised size               ' + (sizes.total / 1024 / 1024).toFixed(2).padStart(7) + ' MB',
			...sizes.top.map((r: any[]) => '      ' + String(r[0]).padEnd(38) + (r[1] / 1024).toFixed(1).padStart(9) + ' KB'),
			'',
			'one forced audit                         med ' + medAudit.toFixed(2).padStart(8) + ' ms'
				+ '   min ' + Math.min(...audit).toFixed(2) + '  max ' + Math.max(...audit).toFixed(2),
			'at ~60 captures/s that is one stall of that size every ~' + (200 / 60).toFixed(1) + ' s',
			'',
		].join('\n'));

		expect(sizes.total, 'the audit must really be re-serialising something').toBeGreaterThan(0);
	}, BOOT_TIMEOUT);
});
