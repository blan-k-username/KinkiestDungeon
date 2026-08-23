/**
 * tests/helpers/mp-lobby.ts  (KDM-236)
 *
 * The one copy of "drive the co-op lobby the way a player drives it".
 *
 * These five helpers were written for `mp-lobby-join-flow.spec.ts` (KDM-233) and were about to be
 * copied a third time for `mp-lobby-address-and-exit.spec.ts`. They live here instead — the repo's
 * DRY rule, and also the practical reason: `press()` encodes a non-obvious fact about how KD's
 * buttons work, and a stale copy of that would fail in a way that looks like a product bug.
 *
 * ── WHY `press()` IS AN `evaluate`, NOT A `page.click()` ──────────────────────────────────────────
 * KD paints its buttons to a canvas and dispatches clicks by iterating `KDButtonsCache`
 * (`KinkyDungeon.ts:4297`), which `DrawButtonKDEx` fills each frame (`:3720`). There is no DOM node
 * to click. Invoking the registered `func` is exactly what KD's own dispatch does with a hit.
 *
 * The lobby only exists on the **demo server** — the client scripts are injected at serve time
 * (`tools/mp-server/demo-server.js`, `INJECT`), so on the plain static `baseURL` there is no
 * `MultiplayerButton` to press. Every caller starts its own server with `start(0)`.
 */
import { waitForBundleReady } from './bundle';

/** Two settled frames — KD's own loop is live on the page, so we wait for it rather than calling in. */
export const settle = (page: any) => page.evaluate(
	() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
);

/** Drive the lobby exactly as KD's click dispatch does: invoke the registered handler. */
export async function press(page: any, button: string) {
	await page.evaluate((name: string) => {
		// @ts-ignore — bundle `let` global, readable by bare name.
		const b = KDButtonsCache[name];
		if (!b) throw new Error('no such button on screen: ' + name + ' (have: ' + Object.keys(KDButtonsCache).join() + ')');
		b.func({});
	}, button);
	await settle(page);
}

/**
 * Open the Multiplayer lobby on a page served by the demo server.
 *
 * `host` defaults to `127.0.0.1`; pass `localhost` when a test needs the page's own origin to be a
 * DIFFERENT STRING from the address it will type into the join field (KDM-236's address-memory
 * tests turn on exactly that distinction).
 */
/**
 * Put the page on KD's main menu and WAIT for it to actually paint.
 *
 * Not a fixed settle, because where the page is coming from varies. Boot runs
 * `Logo → Consent → Intro` and then parks on `Intro` once preload finishes (verified: `Intro` has no
 * buttons and advances on a click). A spec that skips preload arrives here from `Consent` instead.
 * Two frames happens to be enough from one of those and not the other, and the failure mode is an
 * empty `KDButtonsCache` that reads as "the Multiplayer entry is missing" — a wrong and expensive
 * conclusion.
 *
 * So: assert the state every frame until the menu is really on screen. Idempotent and cheap.
 */
async function gotoMenu(page: any, timeout = 30_000) {
	await page.waitForFunction(() => {
		// @ts-ignore — bundle `let` globals, readable by bare name.
		if (KinkyDungeonState !== 'Menu') { KinkyDungeonState = 'Menu'; return false; }
		// @ts-ignore
		return !!(KDButtonsCache && KDButtonsCache.MultiplayerButton);
	}, undefined, { timeout, polling: 'raf' });
}

export async function openLobby(page: any, port: number, host = '127.0.0.1', opts: { preload?: boolean } = {}) {
	// KD's OWN setting for "don't play the intro" (`KDFirstRunMainmenu`, KinkyDungeon.ts:8439-8449),
	// read out of localStorage at init (`:1003`). Without it, preload finishing schedules a 100 ms
	// timer that drops the page on the Intro screen — which has no buttons and only advances on a
	// click — and any state we forced beforehand is silently undone by that timer. Merged rather than
	// overwritten so a spec can seed its own toggles too.
	await page.addInitScript(() => {
		try {
			const cur = JSON.parse(localStorage.getItem('KDToggles') || '{}');
			cur.SkipIntro = true;
			localStorage.setItem('KDToggles', JSON.stringify(cur));
		} catch (e) { /* storage-disabled browser: the gotoMenu fallback still applies */ }
	});
	await page.goto(`http://${host}:${port}/`);
	await waitForBundleReady(page);
	// Before leaving the Consent screen — that is the only place preload can complete. See
	// `waitAssetsPreloaded`.
	if (opts.preload) await waitAssetsPreloaded(page);
	await gotoMenu(page);
	await press(page, 'MultiplayerButton');
}

/** The lobby's own view of itself — the fields the specs assert on. */
export const lobbyState = (page: any) => page.evaluate(() => ({
	view: window.KDMPLobby.view,
	pending: window.KDMPLobby.pending,
	error: window.KDMPLobby.error,
	status: window.KDMPLobby.status,
}));

/** Open the lobby, fill the join form and press Join. `address` defaults to the server's own. */
export async function guestAsks(page: any, port: number, name: string, address?: string, opts: { preload?: boolean } = {}) {
	await openLobby(page, port, '127.0.0.1', opts);
	await press(page, 'KDMPJoin');
	await page.locator('#KDMPAddress').fill(address ?? `127.0.0.1:${port}`);
	await page.locator('#KDMPName').fill(name);
	await press(page, 'KDMPConnect');
}

/**
 * Wait for KD's ASSET PRELOAD to finish.
 *
 * ⚠️ Preload only completes while the CONSENT screen is being drawn: `KDLoadingFinished` is set
 * exclusively inside the `KinkyDungeonState == "Consent"` branch of the draw loop
 * (`KinkyDungeon.ts:2042`, `:2098-2104`). A real player passes through that screen on the way to the
 * menu, so it always finishes for them.
 *
 * `openLobby` jumps straight to `Menu`, which SKIPS it — fine for specs that only assert on lobby
 * state, and invisible to them, but fatal for any spec that needs the session to actually start:
 * `coop-bootstrap.js`'s `enterGame()` gates on exactly this flag and would requeue forever.
 *
 * Opt-in (`openLobby(page, port, host, {preload: true})`) rather than always-on, so the many specs
 * that never enter the game do not each pay for a full asset preload.
 */
export async function waitAssetsPreloaded(page: any, timeout = 120_000) {
	await page.waitForFunction(
		// @ts-ignore — bundle `let` global, readable by bare name.
		() => typeof KDLoadingFinished !== 'undefined' && KDLoadingFinished === true,
		undefined, { timeout },
	);
}

/**
 * Build a REAL mod zip in the page and hand it to KD's stock installer (`KDMods.ts:238`).
 *
 * Here rather than in a spec because two specs now need it (KDM-249's acceptance test and KDM-257's
 * notice test), and a second copy would drift from the first — the same reason `press()` lives here.
 * It is deliberately a real zip built with the game's own zip library, so unzip -> `mod.json` ->
 * priority -> `eval` is genuinely exercised; a stub payload would make every caller's green weaker.
 *
 * Call it AFTER the page has loaded, which is what a real player does (Mods menu, then host) and is
 * the case a declaration computed once at load would miss.
 */
export async function installModZip(page: any, modname: string, markerName: string) {
	await page.evaluate(async (a: any) => {
		// @ts-ignore — `zip` comes from Scripts/lib/zip-full.min.js, loaded before out/main.js.
		const w = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
		// @ts-ignore
		await w.add('mod.json', new zip.TextReader(JSON.stringify({
			modname: a.modname, moddesc: '', author: 'kdtest', modbuild: 'test',
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

/**
 * Record every string KD paints for one settled frame.
 *
 * The lobby draws to a CANVAS, so there is no DOM node to assert on and `lobbyState` only exposes
 * view/pending/error/status. Asserting on a getter that says what *would* be painted is a weaker
 * claim than asserting on the paint call itself — the same lesson as the text-key oracle. So wrap
 * `DrawTextKD`, run a frame, put it back, and answer with what actually reached the screen.
 */
export async function paintedText(page: any): Promise<string[]> {
	return page.evaluate(() => new Promise<string[]>((resolve) => {
		const seen: string[] = [];
		// @ts-ignore — bundle `let` global; bare assignment is how a mod replaces a KD function.
		const prev = DrawTextKD;
		// @ts-ignore
		DrawTextKD = function (...args: any[]) { seen.push(String(args[0])); return prev.apply(this, args); };
		requestAnimationFrame(() => requestAnimationFrame(() => {
			// @ts-ignore — restored before resolving, so a failed assertion cannot leave the page wrapped.
			DrawTextKD = prev;
			resolve(seen);
		}));
	}));
}

/**
 * Record every string a single draw call paints, without waiting for a frame.
 *
 * The frame-driven sibling (`paintedText`) is the right oracle wherever KD's loop is alive. It is
 * NOT alive in-game: KD's Game draw throws in the headless harness (`Cannot set properties of null
 * (setting 'fillStyle')`) and that kills the PIXI ticker — measured on both pages of a real started
 * co-op session, `KinkyDungeonRun` runs and then stops dead from the frame `KinkyDungeonState`
 * becomes `'Game'`. So an in-game paint has to be invoked directly, and this records it.
 *
 * `fn` names a function on `window.KDMPLobby`. Restores `DrawTextKD` in a `finally`, so a throwing
 * renderer cannot leave the page wrapped for the next assertion.
 */
export async function paintedBy(page: any, fn: string): Promise<string[]> {
	return page.evaluate((name: string) => {
		const seen: string[] = [];
		// @ts-ignore — bundle `let` global; bare assignment is how a mod replaces a KD function.
		const prev = DrawTextKD;
		// @ts-ignore
		DrawTextKD = function (...args: any[]) { seen.push(String(args[0])); return prev.apply(this, args); };
		try {
			(window as any).KDMPLobby[name]();
		} finally {
			// @ts-ignore
			DrawTextKD = prev;
		}
		return seen;
	}, fn);
}
