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
export async function openLobby(page: any, port: number, host = '127.0.0.1') {
	await page.goto(`http://${host}:${port}/`);
	await waitForBundleReady(page);
	await page.evaluate(() => { KinkyDungeonState = 'Menu'; });
	await settle(page);
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
export async function guestAsks(page: any, port: number, name: string, address?: string) {
	await openLobby(page, port);
	await press(page, 'KDMPJoin');
	await page.locator('#KDMPAddress').fill(address ?? `127.0.0.1:${port}`);
	await page.locator('#KDMPName').fill(name);
	await press(page, 'KDMPConnect');
}
