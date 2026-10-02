/**
 * Node-layer (Vitest) — a tile-object modal (shrine/tablet/orb/…) must not leave its close
 * button on screen once the interaction that closes it has resolved.
 *
 * UAT (co-op): the owner used the Heart Tablet to raise Stamina. After the purchase resolved —
 * the stat really did go up — the orange "X" close button stayed on screen, and hovering the
 * centre of the play area (where the modal used to sit) drew no move path, only the strip above
 * it did. The modal's BODY was gone; its close affordance and its mouse-blocking area were not.
 *
 * ── ROOT CAUSE ─────────────────────────────────────────────────────────────────────────────────
 * The close "X" is drawn from `KDModalArea` ALONE (`KinkyDungeonDraw.ts:1094`), independently of
 * `KinkyDungeonTargetTile`. Every stock call site that OPENS a modal sets `KDModalArea = true` only
 * from per-frame DRAW code gated on `KinkyDungeonTargetTile` being truthy (`KDObjectDraw[...]`,
 * `KinkyDungeonHUD.ts:402-405`) — i.e. only a real browser, which runs a draw loop, ever sets it true.
 * Every stock call site that CLOSES a modal sets `KDModalArea = false` in lock-step with
 * `KinkyDungeonTargetTile = null`, but that happens inside INPUT-HANDLER code (e.g. the "heart"
 * purchase, `KinkyDungeonInput.ts:1053-1094`) — which in co-op is TURN-consuming and therefore runs
 * on the authoritative SERVER, not in the clicking browser.
 *
 * The server's own `KDModalArea` never runs a draw loop, so it never diverges from its post-init
 * baseline (`false`) — the generic per-player capture only ships a name once its value differs from
 * baseline (`headless-host.js` `_captureGlobals`), so `KDModalArea` is NEVER carried on the wire in
 * either direction. `KinkyDungeonTargetTile`, by contrast, genuinely does diverge (tile object, then
 * back to null) and IS carried — directly on the way in, and via the generic "absent ⇒ back to
 * default" rule (`kd-absent-reset.js`) on the way out. So the tile clears correctly; the flag a
 * stock close relies on existing in lock-step with it does not, and the browser's own
 * locally-latched `KDModalArea = true` (set by last frame's draw call) survives forever.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────────────────
 * `KinkyDungeonTargetTile` / `KDModalArea` are bundle `let`-globals: the client reads/writes them as
 * bare identifiers sharing the bundle's lexical scope (CLAUDE.md — not reachable via `globalThis`).
 * A `vm` context is the only fixture where a bare assignment inside `render-client.js`'s own
 * `"use strict"` IIFE lands on a binding this test can also read back, the same reason
 * `mp-shop-follow.spec.ts` uses one. `render-client.js` itself is exercised (not a reduced stand-in):
 * this bug is specifically in what `KDRenderClient.apply()`/`adoptBundle()` does and does not carry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { KD_CODEC } = require('../../tools/mp-server/kd-codec');
const { KD_ABSENT_RESET_BROWSER } = require('../../tools/mp-server/kd-absent-reset');

const RENDER_CLIENT_SRC = fs.readFileSync(
	path.join(__dirname, '../../tools/mp-server/client/render-client.js'), 'utf8');

const CODEC_BODY = `${KD_CODEC}\n;(typeof window !== 'undefined' ? window : globalThis).KDCodec = ` +
	'{ kdEnc: kdEnc, kdDec: kdDec, kdSer: kdSer };\n';

interface Ctx {
	KinkyDungeonTargetTile: any;
	KDModalArea: boolean;
	KDMapData: { Entities: any[] };
	KinkyDungeonMessageLog: any[];
	KDRenderClient: any;
	[k: string]: any;
}

/** A browser-shaped context: the codec, the absent-reset rule, then render-client.js, in the real load order. */
function makeClient(): Ctx {
	const sandbox: any = {
		// Pristine post-init values — a real browser has run the same bundle init and starts here.
		KinkyDungeonTargetTile: null,
		KDModalArea: false,
		KDMapData: { Entities: [] },
		KinkyDungeonMessageLog: [],
		console,
	};
	// Real render-client.js code reaches its browser-published helpers (KDCodec, KDAbsentReset) via
	// `window`, falling back to `globalThis` only when `window` is itself undefined. A vm context has
	// no `window` of its own, so without this self-reference every such lookup silently sees
	// "undefined" and the rule those helpers implement never runs — self-reference, same as a real
	// browser's `window === globalThis`.
	sandbox.window = sandbox;
	const ctx = vm.createContext(sandbox);
	vm.runInContext(CODEC_BODY, ctx);
	vm.runInContext(KD_ABSENT_RESET_BROWSER, ctx);
	vm.runInContext(RENDER_CLIENT_SRC, ctx);
	return sandbox as Ctx;
}

/** Minimal state frame `KDRenderClient.apply()` accepts — just enough of the shape to not throw. */
function frame(globals: Record<string, any>): any {
	return { bundle: { v: 1, globals }, messages: {} };
}

describe('a tile-object modal closes fully once the server resolves the interaction', () => {
	let ctx: Ctx;
	beforeEach(() => { ctx = makeClient(); });

	it('CONTROL: the tile itself clears via the generic bundle/absent-reset path', () => {
		// Opening: the server's "move onto the tile" handler diverged KinkyDungeonTargetTile from
		// null, so the bundle carries it.
		ctx.KDRenderClient.apply(frame({ KinkyDungeonTargetTile: { Type: 'Tablet', Name: 'Heart' } }));
		expect(ctx.KinkyDungeonTargetTile).toEqual({ Type: 'Tablet', Name: 'Heart' });

		// Closing: the server's "heart" purchase set it back to null — identical to the untouched
		// baseline, so the bundle stops carrying the name at all.
		ctx.KDRenderClient.apply(frame({}));
		expect(ctx.KinkyDungeonTargetTile, 'absent ⇒ back to default is already generic').toBeNull();
	});

	it('the close "X" flag (KDModalArea) does not survive the same round trip', () => {
		// Opening, as above.
		ctx.KDRenderClient.apply(frame({ KinkyDungeonTargetTile: { Type: 'Tablet', Name: 'Heart' } }));
		// The stock per-frame draw call this client's own browser would have made
		// (`KinkyDungeonDrawTablet`, `KinkyDungeonHUD.ts:402-405`) — KDModalArea is set true ONLY by
		// draw code, so this line stands in for "a frame was rendered while the modal was open".
		ctx.KDModalArea = true;

		// Closing: the server resolved the purchase. Real play: the tile goes back to null (proven
		// by the control above) but KDModalArea was NEVER part of any bundle, because the SERVER's
		// own copy never diverged from its baseline (it has no draw loop to set it true).
		ctx.KDRenderClient.apply(frame({}));

		expect(ctx.KinkyDungeonTargetTile, 'precondition: the tile really did clear').toBeNull();
		expect(ctx.KDModalArea, 'the close button must not outlive the modal it belonged to').toBe(false);
	});

	it('a still-open modal is left alone — this is not a blanket "always clear" rule', () => {
		ctx.KDRenderClient.apply(frame({ KinkyDungeonTargetTile: { Type: 'Tablet', Name: 'Heart' } }));
		ctx.KDModalArea = true;

		// Some other per-player field changed, but the tile is still open (still diverged).
		ctx.KDRenderClient.apply(frame({ KinkyDungeonTargetTile: { Type: 'Tablet', Name: 'Heart' } }));

		expect(ctx.KinkyDungeonTargetTile).toEqual({ Type: 'Tablet', Name: 'Heart' });
		expect(ctx.KDModalArea, 'the modal is still open — its close button must still show').toBe(true);
	});
});
