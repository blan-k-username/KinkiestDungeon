/**
 * E2E — KDM-207: WHERE does the co-op client's extra frame time go?
 *
 * [[KDM-205]] established, with a fair control (both arms rendering a dungeon), that the proxy costs
 * ~1.86x the un-proxied game's frame rate — not the 6-10x the old menu-vs-dungeon comparison implied.
 * ~1.86x is real, it is a 46% frame-rate loss, and it is UNATTRIBUTED. This spec attributes it.
 *
 * METHOD. Two pages in one browser, both rendering a real dungeon, profiled with the Chrome DevTools
 * Protocol sampling profiler, with self-time grouped BY SCRIPT URL:
 *
 *   A) plain page + KinkyDungeonStartNewGame(false)   — the game, no proxy anywhere
 *   C) #coop=SOLO                                     — the co-op client, UNPAIRED (no partner, no
 *                                                       session traffic, no snapshots received)
 *
 * Grouping by URL is the point: it separates "our code costs frames" (coop-bootstrap.js /
 * render-client.js / kd-delta.js) from "the game's own draw got slower" (out/main.js). Those two
 * findings lead to completely different fixes, and no amount of reasoning distinguishes them.
 *
 * ⚠️ VALIDITY FIRST — THE LESSON FROM KDM-205. That task's whole premise collapsed because the two
 * arms of its "control" were drawing different things (a menu vs a dungeon). So before comparing any
 * timings, this spec checks that both pages are rendering a COMPARABLE dungeon: same grid size, similar
 * entity count. If the co-op map were bigger, "1.86x" would be map complexity, not proxy overhead —
 * exactly the same class of error, one level down.
 *
 * DIAGNOSTIC: asserts validity and reports the attribution. No timing threshold — `mp-fps-control`
 * already owns the ratio assertion, and a second unattributable red helps nobody.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const SAMPLE_MS = 6000;

async function waitLoaded(P: Page, timeout = 240_000) {
	await P.waitForFunction(() => typeof (window as any).KDLoadingFinished !== 'undefined'
		&& (window as any).KDLoadingFinished === true, undefined, { timeout }).catch(() => {});
}

async function fps(P: Page, ms: number) {
	return P.evaluate((d) => new Promise<number>((res) => {
		let n = 0; const t0 = performance.now();
		(function f() {
			n++;
			if (performance.now() - t0 < d) requestAnimationFrame(f);
			else res(Math.round(10 * n / ((performance.now() - t0) / 1000)) / 10);
		})();
	}), ms);
}

/** What is actually on screen, so a timing comparison can be shown to be like-for-like. */
async function sceneShape(P: Page) {
	return P.evaluate(() => {
		const w = window as any;
		// @ts-ignore bare let-globals
		const md = typeof KDMapData !== 'undefined' ? KDMapData : null;
		return {
			// @ts-ignore
			state: KinkyDungeonState,
			gridLen: md && md.Grid ? md.Grid.length : -1,
			width: md ? md.GridWidth : -1,
			height: md ? md.GridHeight : -1,
			entities: md && md.Entities ? md.Entities.length : -1,
			/*
			 * KDM-254: "is the proxy client running on this page?" — and NOT `!!w.__coop`.
			 *
			 * `coop-bootstrap.js` assigns `window.__coop` at module top level on EVERY page the demo
			 * server serves, and has done since KDM-233 removed the `if (!id) return` guard so the
			 * lobby could reach `window.__coopConnect` from a page with no `#coop=` yet. That change is
			 * deliberate and the module header says so — what broke is this oracle, which read
			 * "the API object exists" as a synonym for "the client is active". It stopped being one,
			 * silently, and the control arm below has been reporting `true` for both pages ever since.
			 *
			 * Ask the two questions the arms actually differ by:
			 *   coopId         `getCoopId()` — null without `#coop=`, so: was this page TOLD to be a
			 *                  co-op client? Set synchronously at module eval, so never racy.
			 *   coopConnected  is there a live socket, i.e. is the proxy actually doing the work whose
			 *                  frame cost this spec exists to measure?
			 */
			coopId: (w.__coop && w.__coop.id) || null,
			coopConnected: !!(w.__coop && w.__coop.connected),
		};
	});
}

/** CDP sampling profile → self-time (ms) grouped by script URL, largest first. */
async function profileByScript(P: Page, ms: number) {
	const cdp = await P.context().newCDPSession(P);
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 200 });   // µs
	await cdp.send('Profiler.start');
	await P.waitForTimeout(ms);
	const { profile }: any = await cdp.send('Profiler.stop');
	await cdp.detach().catch(() => {});

	const total = (profile.endTime - profile.startTime) / 1000;          // µs → ms
	const byUrl = new Map<string, number>();
	const hitsTotal = profile.nodes.reduce((s: number, n: any) => s + (n.hitCount || 0), 0) || 1;
	for (const n of profile.nodes) {
		if (!n.hitCount) continue;
		// KDM-207: group by URL, but fall back to the FUNCTION NAME when there is no url. V8's
		// pseudo-frames — (idle), (program), (garbage collector) — all have an empty url, and lumping
		// them into one "(no url)" bucket hides the only distinction that matters here:
		//   (idle)    the page is WAITING, so frame rate is limited outside JS (raster/present/vsync)
		//   (program) native engine work (compile, native calls)
		//   (garbage collector) allocation pressure
		// The first version of this probe collapsed all three and reported a useless 99%.
		const raw = n.callFrame.url || '';
		// Strip the origin — the port changes every run, which would make labels unstable.
		let label = raw.replace(/^https?:\/\/[^/]+/, '');
		if (!label) label = n.callFrame.functionName || '(anonymous native)';
		byUrl.set(label, (byUrl.get(label) || 0) + n.hitCount);
	}
	const rows = [...byUrl.entries()]
		.map(([url, hits]) => ({ url, ms: +((hits / hitsTotal) * total).toFixed(0), pct: +((100 * hits) / hitsTotal).toFixed(1) }))
		.sort((a, b) => b.ms - a.ms);
	return { totalMs: Math.round(total), rows };
}

/**
 * Native-side cost, which a JS sampling profile cannot see.
 *
 * KDM-207: the first profile attributed ~99% of samples to V8 pseudo-frames and only 35ms of 6143ms
 * to `out/main.js`, i.e. the frame rate is NOT bound by script execution. These counters cover the
 * part that a CPU profile misses — layout, style recalc, paint/raster and total task time — so the
 * remaining cost has somewhere to show up.
 */
async function nativeMetrics(P: Page, ms: number) {
	const cdp = await P.context().newCDPSession(P);
	await cdp.send('Performance.enable');
	const read = async () => {
		const { metrics }: any = await cdp.send('Performance.getMetrics');
		const m: any = {};
		for (const x of metrics) m[x.name] = x.value;
		return m;
	};
	const a = await read();
	await P.waitForTimeout(ms);
	const b = await read();
	await cdp.detach().catch(() => {});
	const d = (k: string) => +(((b[k] || 0) - (a[k] || 0)) * 1000).toFixed(0);   // seconds → ms
	return {
		windowMs: ms,
		taskMs: d('TaskDuration'),
		scriptMs: d('ScriptDuration'),
		layoutMs: d('LayoutDuration'),
		styleMs: d('RecalcStyleDuration'),
		layoutCount: (b.LayoutCount || 0) - (a.LayoutCount || 0),
		styleCount: (b.RecalcStyleCount || 0) - (a.RecalcStyleCount || 0),
		nodes: b.Nodes,
		jsHeapMb: +(((b.JSHeapUsedSize || 0) / 1048576)).toFixed(1),
	};
}

test('KDM-207: attribute the co-op client extra frame cost by script', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, port } = await start(0);
	const ctx = await browser.newContext();
	const out: any = {};

	try {
		// ── A) plain page, real dungeon, no proxy ────────────────────────────────────────────────
		const plain = await ctx.newPage();
		await plain.goto(`http://127.0.0.1:${port}/`);
		await waitLoaded(plain);
		await plain.bringToFront();
		out.startedGame = await plain.evaluate(() => {
			try {
				// @ts-ignore
				KinkyDungeonStartNewGame(false);
				// @ts-ignore
				KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
				// @ts-ignore
				if (typeof KinkyDungeonUpdateLightGrid !== 'undefined') KinkyDungeonUpdateLightGrid = true;
				return true;
			} catch (e) { return String((e as any) && (e as any).message || e); }
		});
		await plain.waitForTimeout(2000);
		out.plainScene = await sceneShape(plain);
		out.plainFps = await fps(plain, 4000);
		out.plainProfile = await profileByScript(plain, SAMPLE_MS);
		out.plainNative = await nativeMetrics(plain, 3000);

		// ── C) co-op client, unpaired ────────────────────────────────────────────────────────────
		const coop = await ctx.newPage();
		await coop.goto(`http://127.0.0.1:${port}/#coop=SOLO`);
		await waitLoaded(coop);
		await coop.bringToFront();
		// KDM-254: WAIT for the proxy to be live, don't sample and hope. The validity gate below
		// asserts `coopConnected`, and a fixed sleep would make that a race on a contended host —
		// turning "the socket was 200 ms late" into a failure that reads like a broken control arm.
		await coop.waitForFunction(() => {
			const c = (window as any).__coop;
			return !!(c && c.id && c.connected);
		}, undefined, { timeout: 60_000 });
		await coop.waitForTimeout(2000);
		out.coopScene = await sceneShape(coop);
		out.coopFps = await fps(coop, 4000);
		out.coopProfile = await profileByScript(coop, SAMPLE_MS);
		out.coopNative = await nativeMetrics(coop, 3000);

		out.ratio = out.coopFps ? +(out.plainFps / out.coopFps).toFixed(2) : null;

		/*
		 * ── THE CONFOUND CHECK (KDM-207) ────────────────────────────────────────────────────────
		 * `plainFps` above was measured with ONE page alive; `coopFps` with TWO. The main thread is
		 * (program)-saturated and headless Chromium software-renders with no GPU, so a second live
		 * WebGL page plausibly costs ~40% of frame throughput on its own — which would masquerade as
		 * proxy overhead. `mp-fps-control` has the same shape, so if this is real it invalidates the
		 * 1.86x there too.
		 *
		 * Two symmetric re-measurements settle it:
		 *   plainFpsWithCoopOpen — the SAME plain page, now that a second page exists
		 *   coopFpsAlone         — the co-op page after the plain one is closed
		 *
		 * If plainFpsWithCoopOpen collapses to ~coopFps, the gap is page contention, not the proxy.
		 * If plain holds near its solo number, the gap is genuinely the proxy.
		 */
		out.plainFpsWithCoopOpen = await fps(plain, 4000);
		await plain.close();
		await coop.waitForTimeout(1500);
		out.coopFpsAlone = await fps(coop, 4000);
		out.ratioBothOpen = out.coopFps ? +(out.plainFpsWithCoopOpen / out.coopFps).toFixed(2) : null;
		out.ratioEachAlone = out.coopFpsAlone ? +(out.plainFps / out.coopFpsAlone).toFixed(2) : null;

		const fmt = (p: any) => p.rows.filter((r: any) => r.pct >= 0.5)
			.map((r: any) => `      ${String(r.ms).padStart(5)}ms ${String(r.pct).padStart(5)}%  ${r.url}`).join('\n');
		// eslint-disable-next-line no-console
		console.log('KDM-207 FRAME COST ATTRIBUTION\n' +
			`  plain: fps ${out.plainFps} · ${JSON.stringify(out.plainScene)}\n` +
			`  coop : fps ${out.coopFps} · ${JSON.stringify(out.coopScene)}\n` +
			`  ratio plain/coop = ${out.ratio}   (plain measured ALONE, coop with both open)\n` +
			`  CONFOUND CHECK: plain-with-coop-open ${out.plainFpsWithCoopOpen} · coop-alone ${out.coopFpsAlone}\n` +
			`      ratio both-open ${out.ratioBothOpen} · ratio each-alone ${out.ratioEachAlone}\n` +
			`  ── plain, self-time by script (total ${out.plainProfile.totalMs}ms) ──\n${fmt(out.plainProfile)}\n` +
			`  ── coop,  self-time by script (total ${out.coopProfile.totalMs}ms) ──\n${fmt(out.coopProfile)}\n` +
			`  ── native (CDP Performance, 3s window) ──\n` +
			`      plain ${JSON.stringify(out.plainNative)}\n` +
			`      coop  ${JSON.stringify(out.coopNative)}`);

		// ── VALIDITY: like-for-like, or the attribution means nothing (the KDM-205 lesson) ───────
		const msg = ' scenes=' + JSON.stringify({ plain: out.plainScene, coop: out.coopScene });
		expect(out.startedGame, 'the plain control must actually start a game' + msg).toBe(true);
		expect(out.plainScene.state, 'plain must be in Game' + msg).toBe('Game');
		expect(out.coopScene.state, 'coop must be in Game' + msg).toBe('Game');
		// KDM-254: the coop arm was TOLD to be a co-op client and its proxy is actually connected…
		expect(out.coopScene.coopId, 'the coop page must actually be a co-op client' + msg).toBe('SOLO');
		expect(out.coopScene.coopConnected,
			'the coop page must actually have the proxy client active' + msg).toBe(true);
		// …and the plain arm is neither. Both halves are asserted: a page with no `#coop=` never runs
		// `boot()`, so `connected` is deterministically false there — it is not a second racy read.
		expect(out.plainScene.coopId,
			'the plain page must NOT be a co-op client' + msg).toBeNull();
		expect(out.plainScene.coopConnected,
			'the plain page must NOT have the proxy client active' + msg).toBe(false);
		expect(out.plainScene.gridLen, 'plain must have a real map' + msg).toBeGreaterThan(0);
		expect(out.coopScene.gridLen, 'coop must have a real map' + msg).toBeGreaterThan(0);
		// Same-sized dungeon on both sides, or "1.86x" is map complexity rather than proxy overhead.
		expect(out.coopScene.gridLen, 'the two dungeons differ in size, so the timings are NOT ' +
			'comparable — this is the menu-vs-dungeon error one level down.' + msg).toBe(out.plainScene.gridLen);
		expect(out.plainProfile.totalMs, 'the plain profile must have run').toBeGreaterThan(1000);
		expect(out.coopProfile.totalMs, 'the coop profile must have run').toBeGreaterThan(1000);
	} finally {
		await ctx.close().catch(() => {});
		await new Promise<void>((r) => server.close(() => r()));
	}
});
