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
import { expect } from '@playwright/test';
import { waitForBundleReady } from './bundle';

/**
 * KDM-281 — inject the lobby the way the demo server does: the shared string table FIRST.
 *
 * A spec that reaches the lobby through `openLobby()` gets the real `INJECT` order for free. Three
 * specs do not — they `addScriptTag` the lobby onto a plain static page to prove the menu entry is
 * installed from outside the game tree — and each of those had its own `LOBBY_SCRIPT` constant.
 * `coop-lobby.js` now holds a HARD reference to `window.KDMPText`, so injecting it alone is a
 * TypeError that takes the whole file with it: the button never appears and every assertion in the
 * spec fails at once, which is how this helper was found.
 *
 * One helper rather than a fourth copy of the path list, for the reason at the top of this file: the
 * ORDER is the non-obvious part, and a stale copy of it fails looking like a product bug.
 */
export const LOBBY_SCRIPTS = [
	'tools/mp-server/client/coop-text.js',
	'tools/mp-server/client/coop-lobby.js',
];

export async function injectLobby(page: any) {
	for (const path of LOBBY_SCRIPTS) await page.addScriptTag({ path });
}

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

export async function openLobby(page: any, port: number, host = '127.0.0.1', opts: { preload?: boolean; briefing?: boolean } = {}) {
	await bootToMenu(page, port, host, opts);
	// KDM-293 — the co-op entries moved from a Multiplayer menu of ours onto KD's own class screen.
	// The BUTTON IDS did not change (`KDMPHost`, `KDMPContinue`, `KDMPJoin`), so every caller that
	// already knows which one it wants needs only this different way of arriving — which is why this
	// one edit migrates the whole suite instead of seventeen.
	await onDiff(page);
}

/**
 * KDM-294 — the other road in: a SOLO run already in progress, with KD's in-game menu open.
 *
 * Same boot as `openLobby` (one copy of "skip the intro, settle on the menu, mark the briefing"),
 * then a real single-player game — KD's own `KinkyDungeonStartNewGame`, a few real turns — and the
 * in-game menu (`KinkyDungeonDrawState = 'Restart'`), polled until our entry is registered for the
 * same reason `onDiff` polls: the wrap draws AFTER `_prev`, so the first frame has KD's buttons only.
 *
 * Preload is always waited for here: a game cannot be started before its assets are.
 */
export async function openGameMenu(page: any, port: number, opts: { briefing?: boolean } = {}) {
	await bootToMenu(page, port, '127.0.0.1', { preload: true, briefing: opts.briefing });
	await page.evaluate(() => {
		// Bare names through `eval`: bundle-scope `let`s are not properties of `window`.
		// eslint-disable-next-line no-eval
		(0, eval)('KDReloadMainData(true); KinkyDungeonStartNewGame(false);');
		// eslint-disable-next-line no-eval
		(0, eval)('for (var i = 0; i < 3; i++) KinkyDungeonAdvanceTime(1);');
	});
	await onGameMenu(page);
}

/** Re-park on KD's in-game menu and wait for our entry — also used after a Cancel or a stock click. */
export async function onGameMenu(page: any, timeout = 30_000) {
	await page.waitForFunction(() => {
		// @ts-ignore — bundle `let` globals, readable by bare name.
		if (KinkyDungeonState !== 'Game') { KinkyDungeonState = 'Game'; return false; }
		// @ts-ignore
		if (KinkyDungeonDrawState !== 'Restart') { KinkyDungeonDrawState = 'Restart'; return false; }
		// @ts-ignore
		return !!(KDButtonsCache && KDButtonsCache.KDMPHostRun);
	}, undefined, { timeout, polling: 'raf' });
}

/**
 * The part of `openLobby` every road shares: boot, skip the intro, settle on KD's main menu, and
 * mark the co-op briefing seen unless the caller is the one spec that is about it.
 */
export async function bootToMenu(page: any, port: number, host: string, opts: { preload?: boolean; briefing?: boolean }) {
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
	await onMenu(page);
	// KDM-272 — a player who has never seen the co-op briefing is shown it on their FIRST entry, and
	// the entry's action is held until they have read it. Every spec but `mp-lobby-about` is about
	// something else, so the briefing is marked seen HERE rather than by a copy in each of them.
	// `{briefing: true}` opts out, and the one spec that opts out is the one asserting the real
	// first-entry behaviour — so this convenience cannot be what makes that spec pass.
	//
	// Marked BEFORE the entry is pressed, not dismissed after: the action now rides through the
	// briefing as a callback, so dismissing afterwards would change WHEN the connect happens.
	if (!opts.briefing) {
		await page.evaluate(() => {
			try { (window as any).__coopMarkBriefingSeen(); } catch (e) { /* storage disabled */ }
		});
	}
}

/**
 * Settle the page on KD's main menu. Every road into co-op (`onDiff`, `openGameMenu`) starts here.
 */
async function onMenu(page: any, timeout = 30_000) {
	/*
	 * ⚠️ LET THE PAGE SETTLE ON THE MENU FIRST, and this is not belt-and-braces.
	 *
	 * When preload finishes, KD schedules a 100 ms timer that drops the page on `Intro` and then the
	 * menu — silently undoing any state forced beforehand. The old `gotoMenu` was immune by accident:
	 * the menu IS where that timer lands, so polling for it could not be raced. Parking straight on
	 * `'Diff'` (or starting a game — KDM-294) is not, and the timer fires just after the poll succeeds.
	 *
	 * It cost six specs — every one of them a `{ preload: true }` caller (`mp-save-export`,
	 * `mp-save-import`, `mp-mod-sync-guest`, `mp-coop-render-alive`) — failing with
	 * `no such button: KDMPHost (have: GameContinue,GameStart,…)`, i.e. sitting on the main menu.
	 * That the failures were exactly the preload set is what identified the timer.
	 */
	await page.waitForFunction(() => {
		// @ts-ignore — bundle `let` globals, readable by bare name.
		if (KinkyDungeonState !== 'Menu') { KinkyDungeonState = 'Menu'; return false; }
		// @ts-ignore — a stock menu button: `MultiplayerButton` is gone (KDM-293).
		return !!(KDButtonsCache && KDButtonsCache.GameStart);
	}, undefined, { timeout, polling: 'raf' });
}

/**
 * Park the page on KD's class/start screen with our entries registered.
 *
 * ⚠️ POLLS FOR THE ENTRY, not for a frame count. `'Diff'` is reachable in one assignment, but our
 * buttons are registered by the wrap that runs AFTER `_prev`'s draw, so the first frame on the screen
 * has KD's buttons and not ours. Polling is what makes this insensitive to how many frames the page
 * happens to need — the same reason `gotoMenu` polled rather than settling.
 */
async function onDiff(page: any, timeout = 30_000) {
	await page.waitForFunction(() => {
		// @ts-ignore
		if (KinkyDungeonState !== 'Diff') { KinkyDungeonState = 'Diff'; return false; }
		// @ts-ignore
		return !!(KDButtonsCache && KDButtonsCache.KDMPJoin && KDButtonsCache.KDMPHost);
	}, undefined, { timeout, polling: 'raf' });
}


/**
 * KDM-293 — the same road as `openLobby`, but WITHOUT marking the briefing seen.
 *
 * The only difference between the two is that convenience, so this delegates rather than repeating
 * the navigation: a second copy of "boot, skip the intro, wait for the entries" is exactly the drift
 * this file exists to prevent. `mp-entry-diff.spec.ts` uses this because one of its tests is about the
 * first-entry briefing itself, and the rest dismiss it explicitly so the dismissal is visible in the
 * test rather than hidden in a helper.
 */
export async function openEntry(page: any, port: number, host = '127.0.0.1') {
	await openLobby(page, port, host, { briefing: true });
}

/** The lobby's own view of itself — the fields the specs assert on. */
export const lobbyState = (page: any) => page.evaluate(() => ({
	// KDM-293 — 'connect' | 'waiting' | 'about'. Replaces the old `view`, whose 'menu' value named a
	// screen that no longer exists.
	phase: window.KDMPLobby.phase,
	pending: window.KDMPLobby.pending,
	error: window.KDMPLobby.error,
	status: window.KDMPLobby.status,
	// KDM-259 — the seed the host typed, cached across view changes like `name`.
	seed: window.KDMPLobby.seed,
}));

/** Open the lobby, fill the join form and press Join. `address` defaults to the server's own. */
export async function guestAsks(page: any, port: number, name: string, address?: string, opts: { preload?: boolean; briefing?: boolean } = {}) {
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

/** A stock control KD hit-tests by hand (`MouseIn`), so it is NOT in `KDButtonsCache`. */
export type Rect = { name: string; x: number; y: number; w: number; h: number };

/**
 * Pitfall #30, as a helper: every overlap between one of OUR buttons and anything else on screen.
 *
 * `KinkyDungeonHandleClick` runs `KDProcessButtons()` before its `MouseIn` chain and returns on a hit
 * (`KinkyDungeon.ts:6421`), so a button of ours that overlaps a stock control STEALS its clicks with
 * both still painted. Checked against every other `KDButtonsCache` entry, computed live, plus the
 * caller's list of hand-rolled `MouseIn` regions — which no cache read can see. One copy, because
 * KDM-293 (class screen) and KDM-294 (in-game menu) need exactly the same rule.
 *
 * Answers `['<ours>:MISSING']` for an entry that is not registered, so an absent button cannot pass.
 */
export async function clashes(page: any, ours: string[], mouseIn: Rect[] = []): Promise<string[]> {
	return page.evaluate((a: { ours: string[]; mouseIn: Rect[] }) => {
		const box = (l: number, t: number, w: number, h: number) => ({ l, t, r: l + w, b: t + h });
		const hit = (A: any, B: any) => A.l < B.r && B.l < A.r && A.t < B.b && B.t < A.b;
		const hits: string[] = [];
		for (const mine of a.ours) {
			// @ts-ignore — bundle `let` global, readable by bare name.
			const m = KDButtonsCache[mine];
			if (!m) { hits.push(mine + ':MISSING'); continue; }
			const A = box(m.Left, m.Top, m.Width, m.Height);
			// @ts-ignore
			for (const name of Object.keys(KDButtonsCache)) {
				if (a.ours.indexOf(name) >= 0) continue;
				// @ts-ignore
				const s = KDButtonsCache[name];
				if (hit(A, box(s.Left, s.Top, s.Width, s.Height))) hits.push(mine + ' over ' + name);
			}
			for (const r of a.mouseIn) {
				if (hit(A, box(r.x, r.y, r.w, r.h))) hits.push(mine + ' over ' + r.name);
			}
		}
		return hits;
	}, { ours, mouseIn });
}

/**
 * A REAL click at canvas coordinates: KD's own dispatch, cache buttons first and then the `MouseIn`
 * chain — the only way to prove a hand-rolled stock control still wins its own pixels.
 * (`press()` cannot: it calls a cache entry's handler by name, and `MouseIn` controls have no entry.)
 */
export async function clickAt(page: any, x: number, y: number) {
	await page.evaluate((p: { x: number; y: number }) => {
		// @ts-ignore — bundle `let` globals; bare assignment is what KD's own mouse handler does.
		MouseX = p.x; MouseY = p.y;
		// @ts-ignore
		KinkyDungeonHandleClick({});
	}, { x, y });
	await settle(page);
}

/**
 * Bring a guest in and have the host accept, returning once the session really has two players.
 *
 * Was copied verbatim in `mp-save-import` and `mp-save-export`, and KDM-294 would have been the third
 * copy. 120s rather than 60s for the prompt: the two-browser join handshake is the first thing to slow
 * down on a loaded host. The assertion is unchanged; only the patience is.
 */
export async function guestJoinsAndIsAccepted(host: any, guest: any, port: number, bridge: any, name = 'Ada') {
	await guestAsks(guest, port, name);
	await expect.poll(async () => (await lobbyState(host)).pending?.name,
		{ timeout: 120_000, message: 'the host should be prompted' }).toBe(name);
	await press(host, 'KDMPAccept');
	await expect.poll(() => bridge.session.players.length,
		{ timeout: 180_000, message: 'accepted guest is seated' }).toBe(2);
}

/** This page's own gold, as the player would see it — the save specs' marker, read side. */
export const goldOf = (page: any): Promise<number> => page.evaluate(() => {
	// eslint-disable-next-line no-eval
	try { return Number((0, eval)('KinkyDungeonGold')); } catch (e) { return NaN; }
});

/**
 * Replace the transport with a recorder: every `__coopConnect` the lobby makes is kept, none dials.
 * For single-page tests about what an entry DECLARES — not about the server. Shared by KDM-294's and
 * KDM-295's specs, which assert the same thing (the declaration) from two different entries.
 */
export const recordConnects = (page: any) => page.evaluate(() => {
	const w = window as any;
	w.__kdmpConnects = [];
	w.__coopConnect = function (opts: any) { w.__kdmpConnects.push(opts); return null; };
});
export const connects = (page: any): Promise<any[]> => page.evaluate(() => (window as any).__kdmpConnects as any[]);

/**
 * KDM-295 — a save CODE for a solo run started as `klass` by a character called `name`, produced by
 * KD's own serialiser (`KinkyDungeonSaveGame(true)` + `LZString.compressToBase64`, the recipe of KD's
 * "Get save code"). Answers the code; the page is left in that run.
 *
 * `klass` is picked by index into KD's own class table (`KDClassStart`), and the chosen key is
 * returned too, so a spec never hard-codes a class name the game may rename.
 */
export async function saveCodeFor(page: any, classIndex: number, name: string): Promise<{ code: string; klass: string }> {
	return page.evaluate((a: { i: number; name: string }) => {
		// eslint-disable-next-line no-eval
		const ev = (s: string) => (0, eval)(s);
		const klass = String(ev('Object.keys(KDClassStart)[' + (a.i | 0) + ']'));
		ev('KDReloadMainData(true); KinkyDungeonClassMode = ' + JSON.stringify(klass) + '; KinkyDungeonStartNewGame(false);');
		ev('for (var i = 0; i < 2; i++) KinkyDungeonAdvanceTime(1);');
		ev('KDGameData.PlayerName = ' + JSON.stringify(a.name) + ';');
		const code = String(ev('LZString.compressToBase64(JSON.stringify(KinkyDungeonSaveGame(true)))'));
		return { code, klass };
	}, { i: classIndex, name });
}

/**
 * KDM-295 — KD's save-slot screen with a save SELECTED, by KD's own road: main menu `LoadGame` →
 * paste the code → `LoadFromCodeButton`, which sets `LoadMenuCurrentSave` exactly as a slot press does.
 * Polls until our entry is registered AND enabled — enabled is the whole gate (R2).
 */
export async function openSlotsWith(page: any, code: string, timeout = 30_000) {
	await onMenu(page);
	await press(page, 'LoadGame');
	await page.locator('#saveInputField').fill(code);
	await press(page, 'LoadFromCodeButton');
	await page.waitForFunction(() => {
		// @ts-ignore — bundle `let` globals, readable by bare name.
		const b = KDButtonsCache && KDButtonsCache.KDMPJoinSave;
		// @ts-ignore
		return KinkyDungeonState === 'LoadSlots' && !!b && !!b.enabled;
	}, undefined, { timeout, polling: 'raf' });
}
