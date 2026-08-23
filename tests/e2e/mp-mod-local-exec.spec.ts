/**
 * E2E (KDM-249 Phase A) — a co-op player's OWN mods actually execute.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────────────────────────────
 * KD executes mods from exactly one place, `KDExecuteModsAndStart()` on the main-menu buttons
 * (`KinkyDungeon.ts:1891`), plus a per-frame auto-load gated on `KDToggles.AutoLoadMods` — which
 * DEFAULTS TO FALSE (`KinkyDungeonVibe.ts:145`). The co-op client reaches neither: it calls
 * `KinkyDungeonStartNewGame(false)` directly (`coop-bootstrap.js:588-591`). So a co-op player's own
 * mods never run, and nothing says so.
 *
 * ── WHY THIS IS NOT A VACUOUS GREEN ───────────────────────────────────────────────────────────────
 *  1. BEFORE/AFTER ON ONE PAGE. The mod is installed into `KDMods` and then REAL FRAMES ARE RUN, and
 *     the marker must still be ABSENT — that absence is the bug, reproduced. Only then is the fix
 *     invoked. A test that only checked the "after" half would pass against a bundle that had been
 *     executing mods all along.
 *  2. A REAL ZIP, not a bare `eval`. The mod is built with the game's own zip library — the same
 *     `zip` global `KDMods` reads through `model.getEntries` (`KDMods.ts:748`) — so the whole
 *     unzip → `mod.json` → priority → `eval` path is exercised. `tests/helpers/mod-injector.ts`
 *     deliberately skips that path and could not catch a fault in it.
 *  3. THE MARKER IS COUNTED, NOT FLAGGED. It increments, so a mod executed TWICE is a different
 *     value from a mod executed once — double-eval is what the `WRAP_CONVENTION` sentinels exist to
 *     survive and is a real risk of getting this wrong.
 *  4. BOTH `AutoLoadMods` REGIMES ARE PINNED. The default is `false`; a suite that only ran the
 *     default would never touch the latch path at all (KDM-249 Assessment, risk 3).
 *
 * ── WHY A SINGLE PAGE AND NOT A CO-OP PAIR ────────────────────────────────────────────────────────
 * Nothing here needs two players: the latch and the execution are per-client. A two-browser boot
 * costs up to 240 s and accumulates the RAM that kills webkit pages, so it is not spent on a
 * question that one page can answer.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Run real frames — KD's loop is live on the page, so we wait for it rather than calling in. */
const frames = (page: any, n = 3) => page.evaluate((count: number) => new Promise<void>((res) => {
	let i = 0;
	const tick = () => (++i >= count ? res() : requestAnimationFrame(tick));
	requestAnimationFrame(tick);
}), n);

const bundleReady = (page: any) => page.waitForFunction(
	// @ts-ignore — KD globals are not typed; they exist in the browser.
	() => typeof KinkyDungeonStartNewGame === 'function' && typeof KDLoadMod === 'function',
	undefined, { timeout: 60_000 },
);

/**
 * Build a REAL mod zip in the page and hand it to the stock installer.
 *
 * `gamemajor`/`gameminor` are -1 so the version comparison in `KDDrawMods` stays quiet; they affect
 * the colour of a line on the mods screen and nothing about execution.
 */
async function installModZip(page: any, modname: string, marker: string, priority = 0) {
	return page.evaluate(async (a: any) => {
		// @ts-ignore — `zip` comes from Scripts/lib/zip-full.min.js, loaded before out/main.js.
		const w = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
		// @ts-ignore
		await w.add('mod.json', new zip.TextReader(JSON.stringify({
			modname: a.modname, moddesc: '', author: 'kdm249', modbuild: 'test',
			gamemajor: -1, gameminor: -1, gamepatch_min: -1, gamepatch_max: -1, priority: a.priority,
		})));
		// Counted, not flagged — see header note 3.
		// @ts-ignore
		await w.add('init.js', new zip.TextReader(
			`globalThis.${a.marker} = (globalThis.${a.marker} || 0) + 1;`));
		const blob = await w.close();
		const file = new File([blob], a.modname + '.zip', { type: 'application/zip' });
		// @ts-ignore — the stock install path (KDMods.ts:238).
		await KDLoadMod([file]);
		// @ts-ignore
		return Object.keys(KDMods);
	}, { modname, marker, priority });
}

const marker = (page: any, name: string) => page.evaluate((n: string) => (globalThis as any)[n], name);
const modsState = (page: any) => page.evaluate(() => (window as any).__coopMods.state());

test.describe('KDM-249 Phase A — mods execute on the co-op path', () => {

	for (const autoLoad of [false, true]) {
		test(`a player's own mod executes, with AutoLoadMods ${autoLoad ? 'ON' : 'OFF (the default)'}`, async ({ browser }) => {
			test.setTimeout(MP_TEST_TIMEOUT);
			const { server, bridge, port } = await start(0);
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			try {
				// Seeded before ANY page script, so the first frame sees the regime under test.
				// `KinkyDungeon.ts:1003` reads this key back into KDToggles at init.
				await page.addInitScript((on: boolean) => {
					localStorage.setItem('KDToggles', JSON.stringify({ AutoLoadMods: on }));
				}, autoLoad);

				await page.goto(`http://127.0.0.1:${port}/`);
				await bundleReady(page);

				// The latch is set before the first frame, so KD's auto-executor stands down and the
				// timing of execution is ours.
				expect(await page.evaluate(() => (KDGetMods as any)), 'the latch is set').toBe(true);
				expect(await page.evaluate(() => (window as any).__coopMods.status()),
					'nothing has been executed yet').toBe('pending');

				await installModZip(page, 'Kdm249Probe', '__kdm249ProbeRan');

				// ── BEFORE: this is the bug. Real frames go by and the mod does NOT run. ──
				await frames(page, 5);
				expect(await marker(page, '__kdm249ProbeRan'),
					'BEFORE: the co-op path never executes the mod on its own — this absence IS the bug')
					.toBeUndefined();
				expect(await page.evaluate(() => (KDExecuted as any)),
					'BEFORE: the game has not executed mods').toBe(false);

				// ── AFTER: the co-op session-start hook does what the Play button would have done. ──
				await page.evaluate(() => (window as any).__coopMods.ensureExecuted());
				await expect.poll(() => page.evaluate(() => (window as any).__coopMods.done()),
					{ timeout: 30_000, message: 'the attempt must always reach a terminal state' }).toBe(true);

				expect(await marker(page, '__kdm249ProbeRan'),
					'AFTER: the mod ran, exactly once').toBe(1);
				const st = await modsState(page);
				expect(st.status, st.error || 'status').toBe('executed');
				expect(st.count, 'one zip was installed').toBe(1);

				// R8 — a session mod must not be written to the player's own mod library. The stock
				// path that persists is `batchSaveMods` (KDMods.ts:230), which belongs to the FILE
				// PICKER alone; nothing we do may reach it. It records what it saved in the
				// `KinkyDungeonModList` localStorage key, so that key is the observable.
				//
				// `batchSaveMods` is a `const` (KDModsUtils.ts:13) and so cannot be spied on by
				// reassignment — hence an observation of its EFFECT. An absence assertion needs a
				// same-shape control or it proves nothing, so the control below persists a mod for
				// real and requires the very same oracle to see it.
				expect(await page.evaluate(() => localStorage.getItem('KinkyDungeonModList')),
					'our path persists nothing').toBeNull();

				const afterControl = await page.evaluate(async () => {
					// @ts-ignore — a `const` in bundle scope: not reassignable, but callable.
					await batchSaveMods([new File([new Blob(['x'])], 'Kdm249Control.zip')]);
					return localStorage.getItem('KinkyDungeonModList');
				});
				expect(afterControl, 'CONTROL: the same oracle DOES see a real persist')
					.toContain('Kdm249Control');
			} finally {
				await ctx.close().catch(() => {});
				try { bridge.close(); } catch (e) { /* ignore */ }
				await new Promise((r) => server.close(r));
			}
		});
	}

	test('a failing execution still settles — never a silent no-mod state (R9, risk 1)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await page.goto(`http://127.0.0.1:${port}/`);
			await bundleReady(page);

			// The failure mode that matters: the latch is set (KD stood down) and then the execution
			// throws. Without a terminal state the session would wait on `done()` forever — the guest
			// would hang on a mod load rather than play with wrong sprites.
			await page.evaluate(() => {
				// @ts-ignore — bare reassignment, the mod-style wrap this codebase uses throughout.
				KDExecuteMods = function () { throw new Error('boom'); };
			});

			await page.evaluate(() => (window as any).__coopMods.ensureExecuted());
			await expect.poll(() => page.evaluate(() => (window as any).__coopMods.done()),
				{ timeout: 30_000, message: 'a thrown execution must still settle' }).toBe(true);

			const st = await modsState(page);
			expect(st.status, 'degraded, not pending').toBe('degraded');
			expect(st.error, 'and it says what went wrong, in words').toContain('boom');
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
