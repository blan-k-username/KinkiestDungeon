/**
 * Node-layer (Vitest) — an AOE warning tile's grow-in animation (and the burst that rides the same
 * tiles) must not restart on a reply that carries no new turn.
 *
 * UAT: "the rope trap animation and affected cells are replayed again and again on my mouse
 * movements." Expected: the burst plays once when the trap fires; its tile overlay lasts only as
 * long as the game's own effect; moving the mouse changes neither.
 *
 * ── ROOT CAUSE ─────────────────────────────────────────────────────────────────────────────────
 * `KDGameData.BulletWarnings` is rebuilt by the SIM once per real turn (`KinkyDungeonFight.ts`
 * `KinkyDungeonUpdateBullets`, an aoe spell such as a rope trap pushes one entry per affected tile
 * with `scale: 0`), and genuinely must keep being replicated — the client cannot recompute which
 * tiles are warned. But each entry's `scale` is also a DRAW-OWNED field: the browser's own per-frame
 * loop (`KinkyDungeonDrawFight`) eases it from 0 toward 1 to grow the tile's overlay in. The headless
 * host never runs that loop, so every capture ships `scale` frozen at its creation-time value.
 * `adoptBundle` (`render-client.js`) installs `KDGameData` key-by-key, wholesale, on every reply —
 * including a UI-only one a mouse hover triggers mid-turn, with no new turn behind it — so each
 * reply clobbered the client's own eased-up `scale` back to 0 and the grow-in (and the burst drawn
 * over the same tiles) replayed.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────────────────
 * Same vm-context approach as `mp-stale-modal-close.spec.ts`: `render-client.js` is exercised
 * directly (not a reduced stand-in), because the bug is specifically in what `KDRenderClient.apply()`
 * does and does not carry across a reply.
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
	KDGameData: { BulletWarnings: any[] };
	KDMapData: { Entities: any[] };
	KinkyDungeonMessageLog: any[];
	KDRenderClient: any;
	[k: string]: any;
}

/** A browser-shaped context: the codec, the absent-reset rule, then render-client.js, in the real load order. */
function makeClient(): Ctx {
	const sandbox: any = {
		// Pristine post-init values — a real browser has run the same bundle init and starts here.
		KDGameData: { BulletWarnings: [] },
		KDMapData: { Entities: [] },
		KinkyDungeonMessageLog: [],
		console,
	};
	sandbox.window = sandbox;
	const ctx = vm.createContext(sandbox);
	vm.runInContext(CODEC_BODY, ctx);
	vm.runInContext(KD_ABSENT_RESET_BROWSER, ctx);
	vm.runInContext(RENDER_CLIENT_SRC, ctx);
	return sandbox as Ctx;
}

/** A state frame carrying this turn's `KDGameData` bundle, same shape as `capturePlayer()`. */
function frame(gameData: Record<string, any>): any {
	return { bundle: { v: 1, gameData, globals: {} }, messages: {} };
}

/** One area-warning entry exactly as `KinkyDungeonUpdateBullets` pushes it (KinkyDungeonFight.ts). */
function warningTile(x: number, y: number, scale: number) {
	return { x, y, x_orig: x, y_orig: y, scale, color: '#ff0000' };
}

/** A state frame that also carries a `KDMapData` replacement, for the Bullets probes below. */
function frameWithMap(gameData: Record<string, any>, map: Record<string, any>): any {
	return { bundle: { v: 1, gameData, globals: {} }, map, messages: {} };
}

/** One bullet entry shaped like the aoe "Hit" burst `KinkyDungeonFight.ts:2463` pushes into `KDMapData.Bullets`. */
function burstBullet(spriteID: string, x: number, y: number) {
	return { spriteID, x, y, xx: x, yy: y, visual_x: x, visual_y: y, time: 1, vx: 0, vy: 0 };
}

describe('a bulletin warning tile\'s grow-in does not restart without a new turn', () => {
	let ctx: Ctx;
	beforeEach(() => { ctx = makeClient(); });

	it('CONTROL: the server-rebuilt array itself still reaches the client every reply', () => {
		// Anti-vacuity: if BulletWarnings stopped being replicated at all, the fix below would be
		// trivially (and wrongly) satisfied by presenting nothing.
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		expect(ctx.KDGameData.BulletWarnings).toHaveLength(1);
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		expect(ctx.KDGameData.BulletWarnings).toHaveLength(1);
	});

	it('a UI-only reply (no new turn) must not reset an already-eased scale back to 0', () => {
		// Turn fires: the server ships the freshly-built tile at scale 0.
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		expect(ctx.KDGameData.BulletWarnings[0].scale).toBe(0);

		// The browser's own draw loop eases it in over the next few frames
		// (`KinkyDungeonDrawFight`, `t.scale += delta * 0.005`) — simulated here directly.
		ctx.KDGameData.BulletWarnings[0].scale = 1;

		// A mouse hover round-trips mid-turn: same tile, same creation-time scale (the headless host
		// never advances it), no turn passed.
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));

		expect(ctx.KDGameData.BulletWarnings[0].scale,
			'the grow-in must not restart from a reply that carries no new turn').toBe(1);
	});

	it('repeated UI-only replies do not replay the grow-in more than once', () => {
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		ctx.KDGameData.BulletWarnings[0].scale = 1;

		for (let i = 0; i < 5; i++) {
			ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		}

		expect(ctx.KDGameData.BulletWarnings[0].scale).toBe(1);
	});

	it('a genuinely NEW tile (never seen before) still grows in from 0 — not a blanket "always keep" rule', () => {
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		ctx.KDGameData.BulletWarnings[0].scale = 1;

		// A different tile lights up alongside the first one — a real new telegraph, not a replay.
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0), warningTile(9, 9, 0)] }));

		const byPos: Record<string, number> = {};
		for (const t of ctx.KDGameData.BulletWarnings) byPos[`${t.x},${t.y}`] = t.scale;
		expect(byPos['5,5'], 'the already-eased tile keeps its progress').toBe(1);
		expect(byPos['9,9'], 'a brand new tile starts its own grow-in at 0').toBe(0);
	});

	it('once a tile is gone from the server\'s array it is gone from the client\'s too', () => {
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [warningTile(5, 5, 0)] }));
		ctx.KDGameData.BulletWarnings[0].scale = 1;

		// The trap's effect ended — the next real turn's rebuild no longer includes this tile.
		ctx.KDRenderClient.apply(frame({ BulletWarnings: [] }));

		expect(ctx.KDGameData.BulletWarnings, 'an expired tile must not be kept alive by the merge').toHaveLength(0);
	});
});

/**
 * FOLLOW-UP 1 — does the same clobber hit the rope burst's own ANIMATION, not just the tile overlay?
 *
 * The owner's report names both: "the rope trap animation AND affected cells are replayed". The
 * burst is the aoe "Hit" sub-bullet (`KinkyDungeonFight.ts:2455-2502`), pushed into `KDMapData.Bullets`.
 * Its actual on-screen scale/alpha easing lives in `KinkyDungeonBulletsVisual` — a SEPARATE module-scope
 * Map (`KinkyDungeonFight.ts:53`), keyed by `spriteID`, mutated only by `KinkyDungeonUpdateSingleBulletVisual`
 * and the per-frame draw loop (`KinkyDungeonDrawFight`, :3563-3600) — never by anything in `KDMapData`
 * itself. `tools/mp-server/**` has ZERO references to `KinkyDungeonBulletsVisual` (grepped), so if
 * `apply()` cannot reach it, it cannot clobber it — proven below rather than assumed.
 */
describe('does the same clobber hit the rope burst\'s ANIMATION itself (KDMapData.Bullets)?', () => {
	let ctx: Ctx;
	beforeEach(() => { ctx = makeClient(); });

	it('GENERAL RISK: KDMapData is adopted wholesale, so a field placed directly on a bullet object IS reset by an unchanged-content reply', () => {
		// This is the mechanism, demonstrated generically — NOT proof that KD actually puts a
		// draw-owned field here (the next test shows it does not).
		ctx.KDRenderClient.apply(frameWithMap({}, { Entities: [], Bullets: [burstBullet('b1', 5, 5)] }));
		ctx.KDMapData.Bullets[0].visual_x = 9;   // a hypothetical local draw mutation landing on the bullet itself

		// UI-only reply: identical bullet content, no new turn.
		ctx.KDRenderClient.apply(frameWithMap({}, { Entities: [], Bullets: [burstBullet('b1', 5, 5)] }));

		expect(ctx.KDMapData.Bullets[0].visual_x,
			'KDMapData is replaced wholesale on every apply() — any field living ON a bullet object is at risk').toBe(5);
	});

	it('the REAL per-bullet animation state (KinkyDungeonBulletsVisual) is a separate global apply() never touches', () => {
		// Seed it exactly as the draw loop would have eased a burst in: scale/alpha at 1, mid-animation.
		ctx.KinkyDungeonBulletsVisual = new Map([['b1', { scale: 1, alpha: 1, spriteID: 'b1' }]]);

		// Several UI-only replies, same bullet, no new turn — what a mouse hover produces.
		for (let i = 0; i < 3; i++) {
			ctx.KDRenderClient.apply(frameWithMap({}, { Entities: [], Bullets: [burstBullet('b1', 5, 5)] }));
		}

		const entry = ctx.KinkyDungeonBulletsVisual.get('b1');
		expect(entry, 'apply() must not delete or replace the animation Map').toBeDefined();
		expect(entry.scale, 'apply() must not reach into KinkyDungeonBulletsVisual at all').toBe(1);
	});
});

/**
 * FOLLOW-UP 2 — generality/DRY, REVISED DECISION: the skip-cache is a pure no-op OPTIMISATION, not a
 * protection mechanism for arbitrary draw-owned state. The original version of this block asserted that
 * an UNDECLARED key's client-side mutation survives an unchanged resend — i.e. that the generic
 * unchanged-value skip itself was the protection. That premise was found to directly contradict the
 * render-completeness invariant (the client's `KDGameData` must match the server's bundle for every
 * key the server carries, per player): the SAME mechanism that "protected" an undeclared draw-owned
 * mutation also permanently hid a REAL divergence the one time the game's own engine (not this file)
 * locally re-derived a key between replies — the client got stuck on a stale, wrong value for the rest
 * of the session because the server's own value never changed again to force a re-adopt.
 *
 * Decision: I4 (client state matches the server bundle) wins for every key, by default. Protection
 * from an unchanged resend is granted only to state that is EXPLICITLY DECLARED client/draw-owned —
 * the existing `CLIENT_OWNED_GAMEDATA_KEYS` / `CLIENT_OWNED_ENTITY_FIELDS` pattern, plus the
 * `BulletWarnings` per-entry `scale` merge above, which is its own explicit, by-name mechanism, not an
 * instance of the generic skip. The generic skip-cache now ALSO requires the live value to still match
 * what was last adopted before it may skip — so it only ever short-circuits a true no-op (nothing to
 * do either side), never a case where local state has drifted. An undeclared key is therefore corrected
 * on the very next resend, exactly as I4 requires — the opposite of this block's original assertion.
 */
describe('the generic unchanged-value skip is a no-op optimisation, not protection, for an undeclared key', () => {
	let ctx: Ctx;
	beforeEach(() => { ctx = makeClient(); });

	it('a client-side mutation of an UNDECLARED key is corrected by the next resend, even one carrying no new turn', () => {
		ctx.KDGameData.SomeFutureDrawEasedValue = 0;
		ctx.KDRenderClient.apply(frame({ SomeFutureDrawEasedValue: 0 }));

		ctx.KDGameData.SomeFutureDrawEasedValue = 42;   // local drift — nothing declares this key client-owned

		// The server's value for this key has not changed since it was last adopted — this is the exact
		// "no new turn" shape a UI-only reply has, and I4 still wins: nothing protects an undeclared key.
		ctx.KDRenderClient.apply(frame({ SomeFutureDrawEasedValue: 0 }));

		expect(ctx.KDGameData.SomeFutureDrawEasedValue,
			'an undeclared key is never protected — the server bundle is reasserted even unchanged').toBe(0);
	});

	it('CONTROL: a genuine change to that same key is still adopted — this is not a blanket "never reassign" rule', () => {
		ctx.KDGameData.SomeFutureDrawEasedValue = 0;
		ctx.KDRenderClient.apply(frame({ SomeFutureDrawEasedValue: 0 }));

		ctx.KDGameData.SomeFutureDrawEasedValue = 42;

		ctx.KDRenderClient.apply(frame({ SomeFutureDrawEasedValue: 7 }));   // a real server-side change

		expect(ctx.KDGameData.SomeFutureDrawEasedValue).toBe(7);
	});

	it('true no-op: when live already equals the unchanged server value, the cache still skips (cheap path exercised)', () => {
		ctx.KDGameData.SomeFutureDrawEasedValue = 0;
		ctx.KDRenderClient.apply(frame({ SomeFutureDrawEasedValue: 0 }));

		// Nothing touched the live value since — this is the actual common case (a UI reply with no
		// local drift to correct), and it must remain a cheap skip, not a forced re-decode every time.
		ctx.KDRenderClient.apply(frame({ SomeFutureDrawEasedValue: 0 }));

		expect(ctx.KDGameData.SomeFutureDrawEasedValue).toBe(0);
	});
});
