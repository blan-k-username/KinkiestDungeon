/**
 * Loading the co-op browser client into a `vm` sandbox the way a real browser loads it.
 *
 * `render-client.js` reads helpers the server publishes as synthetic `/mp/*.js` scripts injected
 * before it (`KDPeerShared`, `KDCodec`, `KDAbsentReset`, …). Each spec used to rebuild that list by
 * hand — including its own copy of the codec body — so every new shared module had to be added in
 * every spec. This runs exactly what `demo-server.js` serves, in its `INJECT` order.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { INJECT, SYNTHETIC_ROUTES } = require('../../tools/mp-server/demo-server');

const RENDER_CLIENT = '/tools/mp-server/client/render-client.js';
export const RENDER_CLIENT_SRC: string = fs.readFileSync(
	path.join(__dirname, '../../tools/mp-server/client/render-client.js'), 'utf8');

/** The bodies of every synthetic script the browser runs before `render-client.js`, in order. */
export function renderClientPrecursors(): string[] {
	const end = INJECT.indexOf(RENDER_CLIENT);
	if (end < 0) throw new Error('render-client.js is no longer in demo-server INJECT');
	return INJECT.slice(0, end)
		.filter((route: string) => Object.prototype.hasOwnProperty.call(SYNTHETIC_ROUTES, route))
		.map((route: string) => SYNTHETIC_ROUTES[route]);
}

/** Run the precursors in a `vm` context. */
export function runRenderClientPrecursors(ctx: vm.Context): void {
	for (const body of renderClientPrecursors()) vm.runInContext(body, ctx);
}

/**
 * The same for a real Playwright page that loads the client by hand (an isolated page, not a
 * `demo-server` one): the precursors, then `render-client.js` — what the served index.html does.
 */
export async function addRenderClientScripts(page: { addScriptTag(o: { content?: string, path?: string }): Promise<unknown> }): Promise<void> {
	for (const body of renderClientPrecursors()) await page.addScriptTag({ content: body });
	await page.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });
}

/**
 * A browser-shaped context around `sandbox` (which supplies the bundle globals a spec needs), with the
 * precursors and then `render-client.js` loaded. `window === globalThis`, as in a real browser.
 */
export function loadRenderClient<T extends Record<string, any>>(sandbox: T): T {
	(sandbox as any).window = sandbox;
	const ctx = vm.createContext(sandbox);
	runRenderClientPrecursors(ctx);
	vm.runInContext(RENDER_CLIENT_SRC, ctx);
	return sandbox;
}
