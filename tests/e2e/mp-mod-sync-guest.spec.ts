/**
 * E2E (KDM-249 Phase B) — THE ACCEPTANCE TEST: a mod the HOST has and the GUEST does not ends up
 * running in the guest's page, through the real lobby flow.
 *
 * This is the feature the task exists for. Everything else in KDM-249 is machinery underneath it:
 * the declaration on the handshake (R1), the host as source of truth (R2), the diff (R3), the
 * payload relay (R6), and the stock install path (R7) all have to be right for this one assertion to
 * hold.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THE GUEST'S "BEFORE" IS MEASURED. The marker must be absent on the guest while the host
 *     already has it — so a green cannot come from both pages happening to load the same mod.
 *  2. THE MOD IS A REAL ZIP, built with the game's own zip library, so unzip → `mod.json` → priority
 *     → `eval` is genuinely exercised end to end across two browsers.
 *  3. THE MARKER IS COUNTED. A mod executed twice reads differently from one executed once.
 *  4. THE HOST INSTALLS ITS MOD *AFTER* PAGE LOAD, which is what a real player does (Mods menu, then
 *     host). That is exactly the case a declaration computed once at load would miss.
 *  5. BOTH PAGES WAIT FOR ASSET PRELOAD (`{preload: true}`). `enterGame()` gates on
 *     `KDLoadingFinished`, which KD sets ONLY while the Consent screen is drawn
 *     (`KinkyDungeon.ts:2042`, `:2098-2104`) — and `openLobby` normally skips straight to the menu.
 *     Without this the session seats both players and then never starts, which looks exactly like a
 *     mod-sync failure and is not one.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState, guestAsks } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);
const MARKER = '__kdm249HostModRan';

/** Build a REAL mod zip in the page and hand it to the stock installer. */
async function installModZip(page: any, modname: string, markerName: string) {
	await page.evaluate(async (a: any) => {
		// @ts-ignore — `zip` comes from Scripts/lib/zip-full.min.js, loaded before out/main.js.
		const w = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
		// @ts-ignore
		await w.add('mod.json', new zip.TextReader(JSON.stringify({
			modname: a.modname, moddesc: '', author: 'kdm249', modbuild: 'test',
			gamemajor: -1, gameminor: -1, gamepatch_min: -1, gamepatch_max: -1, priority: 0,
		})));
		// @ts-ignore
		await w.add('init.js', new zip.TextReader(
			`globalThis.${a.markerName} = (globalThis.${a.markerName} || 0) + 1;`));
		const blob = await w.close();
		const file = new File([blob], a.modname + '.zip', { type: 'application/zip' });
		// @ts-ignore — the stock install path (KDMods.ts:238).
		await KDLoadMod([file]);
	}, { modname, markerName });
}

const marker = (page: any) => page.evaluate((n: string) => (globalThis as any)[n], MARKER);
const modsState = (page: any) => page.evaluate(() => (window as any).__coopMods.state());

test.describe('KDM-249 — the guest plays with the host\'s mods', () => {
	test('a host-only mod is declared, shipped and executed on the guest', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port, '127.0.0.1', { preload: true });

			// AFTER the page has loaded — the real order of events, and the case a once-at-load
			// declaration would miss (see header note 4).
			await installModZip(host, 'Kdm249HostMod', MARKER);

			await press(host, 'KDMPHost');
			expect((await lobbyState(host)).view).toBe('host');

			// The host's declaration reaches the session. This is R2 — the session mod set IS the
			// host's — and it must survive the publish/re-declare round trip.
			await expect.poll(() => bridge.gate.hostMods().map((m: any) => m.modname),
				{ timeout: 30_000, message: 'the host declares its mod to the session' })
				.toEqual(['Kdm249HostMod']);

			await guestAsks(guest, port, 'Ada', undefined, { preload: true });
			await expect.poll(async () => (await lobbyState(host)).pending?.name,
				{ timeout: 30_000, message: 'the host should be prompted' }).toBe('Ada');

			// BEFORE: the guest does not have it. Measured on the guest's own page, so a green
			// cannot come from both windows loading the same mod.
			expect(await marker(guest), 'BEFORE: the guest has never seen this mod').toBeUndefined();
			expect((await modsState(guest)).declaration, 'and declares nothing of its own').toEqual([]);

			await press(host, 'KDMPAccept');

			await expect.poll(() => bridge.session.players.length,
				{ timeout: 120_000, message: 'accepted guest is seated' }).toBe(2);

			// AFTER: the host's mod ran in the GUEST's page.
			await expect.poll(() => marker(guest),
				{ timeout: 120_000, message: 'the host\'s mod should reach and run on the guest' }).toBe(1);

			const st = await modsState(guest);
			expect(st.fetched, 'the guest names what it pulled in').toContain('Kdm249HostMod');
			expect(st.missing, 'and nothing was left behind').toEqual([]);
			expect(st.status, st.error || 'status').toBe('executed');

			// R8 — a session mod must not enter the guest's own library. `batchSaveMods`
			// (KDModsUtils.ts:13) records what it saved in this key, and nothing on our path may
			// reach it.
			expect(await guest.evaluate(() => localStorage.getItem('KinkyDungeonModList')),
				'the host\'s mod is NOT persisted into the guest\'s library').toBeNull();
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
