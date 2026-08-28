/**
 * Node-layer (Vitest) — KDM-266: the shop HIGHLIGHT follows its item when a partner buys.
 *
 * KDM-264 shipped the half that costs money (a purchase is tagged with the item the buyer's browser
 * was showing, and the server re-finds it by identity). This is the DISPLAY half: B points at row 2,
 * A buys row 0, the stock shrinks, and row 2 is now a different potion. B's next click still buys the
 * right thing — the tag saves them — but for one turn they are looking at a lie.
 *
 * ── WHY THIS SPEC EXISTS AT THE NODE LAYER AT ALL ─────────────────────────────────────────────────
 * Two earlier attempts at this failed, and both failed for reasons of ORDERING that an e2e reports
 * only as "the highlight is still wrong". The mechanism is four events in a row — cursor moved,
 * delta merged, map adopted, cursor re-pointed — and the whole design rests on WHICH of them the
 * identity is read between. That is exactly what a fast, deterministic spec can pin and a browser
 * cannot.
 *
 * ── THE FIXTURE IS A vm CONTEXT, AND THAT IS LOAD-BEARING ─────────────────────────────────────────
 * `KinkyDungeonShopIndex` is a bundle `let`-global: the client wrap READS it and WRITES it as a bare
 * identifier, and (CLAUDE.md) bundle globals are not on `globalThis` in the real runtime. Passing it
 * as a `new Function` parameter — the shape `tests/unit/mp-solo-teardown.spec.ts:95` uses for a
 * client source-text module with no writes — would make every assignment local to the wrapper and
 * every assertion below read the value the test itself set. A `vm` context makes a bare assignment
 * land on the context's global object, which is the only arrangement here that can FAIL.
 *
 * The delta merge is the REAL `kdMerge` from `kd-delta.js`, run inside the same context, and the fake
 * `KDRenderClient.apply` does the one thing the real one does that matters
 * (`render-client.js:544` — `KDMapData = s.map`). The invariant that broke both earlier attempts is
 * reproduced literally: `__base.map` IS the live `KDMapData`, so the merge mutates the map in place
 * and the new stock is already installed by the time `apply` is entered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
/* eslint-disable @typescript-eslint/no-var-requires */
const vm = require('vm');
const { KD_SHOP_BUY } = require('../../tools/mp-server/kd-shop-buy');
const { KD_DELTA, kdDiff } = require('../../tools/mp-server/kd-delta');

/** Four distinct goods. Names only — nothing here reaches KD's own consumable branch. */
const STOCK = ['A', 'B', 'C', 'D'].map((name) => ({ name, shoptype: 'consumable', quantity: 1 }));

interface Ctx {
	KDMapData: { ShopItems: any[] };
	KinkyDungeonShopIndex: number;
	KinkyDungeonMessageLog: any[];
	__keys: Record<string, string>;
	__sent: any[];
	__KDCoopShopStats?: { tagged: number; repointed: number; refused: number; followed: number; sold: number };
	[k: string]: any;
}

/**
 * A browser-shaped context with the client half installed (or not — `install:false` is the CONTROL).
 *
 * No `KDInputTypes`, so the file's SERVER half is skipped by its own guard: this spec is about the
 * cursor, and `tests/unit/mp-shop-identity.spec.ts` already owns the resolver.
 */
function makeClient(opts: { install?: boolean } = {}): Ctx {
	const sandbox: any = {
		KDMapData: { ShopItems: JSON.parse(JSON.stringify(STOCK)) },
		KinkyDungeonShopIndex: 0,
		// The message log is SERVER-REPLICATED — `apply` replaces it wholesale
		// (render-client.js:641). Modelled, because a notice this browser pushes on its own is
		// otherwise gone on the very next frame, and that is the failure this fixture must be able
		// to show.
		KinkyDungeonMessageLog: [],
		__keys: {},
		__sent: [],
		addTextKey: function (k: string, t: string) { sandbox.__keys[k] = t; },
		TextGet: function (k: string) { return sandbox.__keys[k] || '[NotFound] ' + k; },
		KinkyDungeonSendTextMessage: function (_p: number, text: string) {
			sandbox.KinkyDungeonMessageLog.push({ text: text });
		},
		console,
	};
	const ctx = vm.createContext(sandbox);

	// The real diff/merge pair, inside the context, exactly as the browser is served it.
	vm.runInContext(`${KD_DELTA}\n;globalThis.KDDelta = { kdDiff: kdDiff, kdMerge: kdMerge };`, ctx);

	// The thin client, reduced to the one line of `apply` this mechanism turns on.
	vm.runInContext(`
		globalThis.__base = { map: KDMapData };
		globalThis.KDRenderClient = {
			apply: function (s) {
				if (s && s.map) KDMapData = s.map;
				// render-client.js:641 — the log is adopted WHOLESALE, every frame.
				if (s && s.messages) KinkyDungeonMessageLog = s.messages.log || [];
				return { ok: true };
			},
			sendInput: function (a) { __sent.push(a); return a; }
		};
		/* A DELTA frame: merge onto the base — which mutates the live KDMapData — then adopt. */
		globalThis.__applyDelta = function (patch) {
			__base = KDDelta.kdMerge(__base, patch);
			KDRenderClient.apply(__base);
		};
		/* A FULL-SNAPSHOT frame: never merged (coop-bootstrap.js:1327), so KDMapData is still old. */
		globalThis.__applySnapshot = function (snap) {
			__base = snap;
			KDRenderClient.apply(__base);
		};
	`, ctx);

	if (opts.install !== false) vm.runInContext(KD_SHOP_BUY, ctx);
	return sandbox as Ctx;
}

/** The names on the shelf, in order. */
function shelf(ctx: Ctx): string[] { return ctx.KDMapData.ShopItems.map((i: any) => i.name); }
/** What the cursor currently DENOTES — the question this whole task is about. */
function showing(ctx: Ctx): string | null {
	const it = ctx.KDMapData.ShopItems[ctx.KinkyDungeonShopIndex];
	return (it && it.name) || null;
}
/** Move the cursor the way clicking a row does — `KinkyDungeonShrine.ts:549`, purely local. */
function click(ctx: Ctx, name: string): number {
	const i = ctx.KDMapData.ShopItems.findIndex((it: any) => it.name === name);
	vm.runInContext(`KinkyDungeonShopIndex = ${i};`, ctx);
	return i;
}
/**
 * Deliver the shelf `names` as a server DELTA, diffed against what this client currently holds.
 *
 * `serverLog` is the message log the server would ship on that frame — passing it reproduces the
 * wholesale replace that destroys a client-pushed line. Omitted, the log is left alone.
 */
function deltaTo(ctx: Ctx, names: string[], serverLog?: string[]): void {
	const mirror: any = { map: { ShopItems: ctx.KDMapData.ShopItems } };
	const next: any = { map: { ShopItems: names.map((n) => STOCK.find((s) => s.name === n)) } };
	if (serverLog) {
		mirror.messages = { log: [] };
		next.messages = { log: serverLog.map((t) => ({ text: t })) };
	}
	const patch = kdDiff(JSON.parse(JSON.stringify(mirror)), next);
	vm.runInContext(`__applyDelta(${JSON.stringify(patch || {})});`, ctx);
}
/** …and the same shelf as a FULL snapshot, which never passes through the merge. */
function snapshotTo(ctx: Ctx, names: string[]): void {
	const snap = { map: { ShopItems: names.map((n) => STOCK.find((s) => s.name === n)) } };
	vm.runInContext(`__applySnapshot(${JSON.stringify(snap)});`, ctx);
}
/** Every line this player's log holds, newest last. */
function logText(ctx: Ctx): string[] {
	return (ctx.KinkyDungeonMessageLog || []).map((m: any) => m && m.text);
}
/** How many times the sold notice appears — the property a player actually sees. */
function noticeCount(ctx: Ctx): number {
	return logText(ctx).filter((t) => t === ctx.__keys.KDCoopShopItemSold).length;
}

describe('KDM-266 — the shop cursor follows its item across a partner\'s purchase', () => {
	let ctx: Ctx;
	beforeEach(() => { ctx = makeClient(); });

	it('the client half is installed on both hooks, as PROPERTIES that cannot be outrun', () => {
		expect(vm.runInContext(`({
			apply: !!KDRenderClient.apply._kdcoop_shop_wrapped,
			merge: !!KDDelta.kdMerge._kdcoop_shop_wrapped,
			send:  !!KDRenderClient.sendInput._kdcoop_shop_wrapped
		})`, ctx)).toEqual({ apply: true, merge: true, send: true });
	});

	it('DELTA path: a partner buying ahead of the cursor leaves it on the SAME item', () => {
		expect(click(ctx, 'C')).toBe(2);
		deltaTo(ctx, ['B', 'C', 'D']);                       // the partner bought A
		expect(shelf(ctx), 'precondition: the shelf really did shift').toEqual(['B', 'C', 'D']);
		expect(ctx.KinkyDungeonShopIndex, 'the cursor moved with its item').toBe(1);
		expect(showing(ctx)).toBe('C');
		expect(ctx.__KDCoopShopStats!.followed).toBe(1);
	});

	it('CONTROL: without the wrap, that exact frame leaves the cursor denoting a DIFFERENT item', () => {
		const bare = makeClient({ install: false });
		expect(click(bare, 'C')).toBe(2);
		deltaTo(bare, ['B', 'C', 'D']);
		expect(bare.KinkyDungeonShopIndex, 'the index itself is untouched — that IS the bug').toBe(2);
		expect(showing(bare), 'row 2 is now the neighbour').toBe('D');
	});

	it('SNAPSHOT path: a full frame never reaches the merge, and is followed all the same', () => {
		expect(click(ctx, 'C')).toBe(2);
		snapshotTo(ctx, ['B', 'C', 'D']);
		expect(showing(ctx)).toBe('C');
		expect(ctx.KinkyDungeonShopIndex).toBe(1);
	});

	it('a cursor MOVE between frames is adopted, not mistaken for a shifted shelf', () => {
		click(ctx, 'C');
		deltaTo(ctx, ['B', 'C', 'D']);                       // → cursor at 1, holding C
		expect(click(ctx, 'D'), 'the player now picks the last row').toBe(2);
		deltaTo(ctx, ['C', 'D']);                            // the partner bought B
		expect(showing(ctx), 'the NEW pick is what follows, not the old one').toBe('D');
	});

	it('a frame that changes nothing about the shelf leaves the cursor exactly where it is', () => {
		click(ctx, 'C');
		deltaTo(ctx, ['A', 'B', 'C', 'D']);
		expect(ctx.KinkyDungeonShopIndex).toBe(2);
		expect(ctx.__KDCoopShopStats!.followed, 'nothing moved ⇒ nothing to follow').toBe(0);
	});

	it('R14/AC2: the item the PARTNER sold is reported, and the cursor stays on a real row', () => {
		click(ctx, 'C');
		deltaTo(ctx, ['A', 'B', 'D']);                       // the partner bought C itself
		expect(ctx.__keys.KDCoopShopItemSold, 'the key is registered — a missing one prints [NotFound]')
			.toBeTruthy();
		expect(noticeCount(ctx), 'the player is told, rather than silently given the neighbour').toBe(1);
		// Finding 4: KinkyDungeonShrine.ts:560/563/566/586/588 dereference ShopItems[idx].name
		// UNGUARDED every frame, and the only guard (:521) is `>` not `>=` with an empty body. An
		// out-of-range cursor is a crash on the draw path, not a blank selection.
		expect(ctx.KinkyDungeonShopIndex).toBeGreaterThanOrEqual(0);
		expect(ctx.KinkyDungeonShopIndex).toBeLessThan(ctx.KDMapData.ShopItems.length);
		expect(ctx.__KDCoopShopStats!.sold).toBe(1);
	});

	it('…and the notice SURVIVES the server replacing the whole log, exactly once', () => {
		click(ctx, 'C');
		deltaTo(ctx, ['A', 'B', 'D'], ['a server line']);
		expect(noticeCount(ctx), 'it is there to begin with').toBe(1);

		// Every one of these frames replaces `KinkyDungeonMessageLog` wholesale
		// (render-client.js:641) — the exact reason a client-pushed line used to vanish.
		deltaTo(ctx, ['A', 'D'], ['a server line', 'another']);
		deltaTo(ctx, ['D'], ['a server line', 'another', 'a third']);
		expect(noticeCount(ctx), 'still shown after the log was replaced twice').toBe(1);
		expect(logText(ctx), 'and the server\'s own lines are not lost to make room for it')
			.toContain('a third');
	});

	it('…and is spent the moment the player picks another row', () => {
		click(ctx, 'C');
		deltaTo(ctx, ['A', 'B', 'D'], ['x']);
		expect(noticeCount(ctx)).toBe(1);
		click(ctx, 'A');                                     // the player has read it and moved on
		deltaTo(ctx, ['A', 'D'], ['x', 'y']);
		expect(noticeCount(ctx), 'a spent notice is not re-asserted onto later frames').toBe(0);
	});

	it('…and stops re-asserting itself eventually, rather than owning the tail of the log forever', () => {
		click(ctx, 'C');
		deltaTo(ctx, ['A', 'B', 'D'], ['x']);
		for (let i = 0; i < 40; i++) deltaTo(ctx, ['A', 'B', 'D'], ['x', 'line ' + i]);
		expect(noticeCount(ctx), 'the bound has been reached and the log is the server\'s again').toBe(0);
	});

	it('the player\'s OWN purchase is not reported back to them as sold', () => {
		click(ctx, 'C');
		// The buy this client sends — the same call KD's shop button makes, through the wrap that
		// tags it (KinkyDungeonShrine.ts:528 → KDRenderClient.sendInput).
		vm.runInContext(`KDRenderClient.sendInput({ kdType: 'shrineBuy', data: { type: 'Commerce', shopIndex: KinkyDungeonShopIndex } });`, ctx);
		deltaTo(ctx, ['A', 'B', 'D']);
		expect(noticeCount(ctx), 'you know what you bought').toBe(0);
		expect(ctx.KinkyDungeonShopIndex, 'KD\'s own rule after a buy — KinkyDungeonShrine.ts:424').toBe(1);
		expect(ctx.__KDCoopShopStats!.sold).toBe(0);
	});

	it('an emptied shelf is survivable — no throw, and no out-of-range cursor', () => {
		click(ctx, 'C');
		expect(() => deltaTo(ctx, [])).not.toThrow();
		expect(ctx.KinkyDungeonShopIndex, 'nothing to point at ⇒ the stock KD default').toBe(0);
	});

	it('a client that is not in a shop at all is untouched', () => {
		vm.runInContext('delete KDMapData.ShopItems; KinkyDungeonShopIndex = 3;', ctx);
		vm.runInContext('__applySnapshot({ map: KDMapData });', ctx);
		expect(ctx.KinkyDungeonShopIndex).toBe(3);
	});
});
