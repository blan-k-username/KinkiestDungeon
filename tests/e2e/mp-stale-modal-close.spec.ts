/**
 * E2E — closing a tile-object modal (the Heart Tablet) in real co-op must not leave its close
 * button, and its mouse-blocking area, behind on the browser that used it.
 *
 * ── THE BUG (owner's UAT) ─────────────────────────────────────────────────────────────────────────
 * The owner used a Heart Tablet to raise Stamina. After the purchase resolved — the stat really did
 * go up — the orange "X" close button stayed on screen, and hovering the centre of the play area
 * drew no move path (only a strip above the old modal did). See `tests/unit/mp-stale-modal-close.spec.ts`
 * for the file:line root cause: `KDModalArea` is drawn from (`KinkyDungeonDraw.ts:1094`) and set true
 * (`KinkyDungeonHUD.ts:402-405`) by CLIENT draw code, but is cleared only by the "heart" purchase's
 * INPUT-HANDLER code (`KinkyDungeonInput.ts:1053-1094`), which in co-op runs on the authoritative
 * SERVER — whose own `KDModalArea` never diverges from its baseline (it has no draw loop), so the
 * generic per-player capture never ships a closing value for it.
 *
 * ── WHY THIS SPEC, ON TOP OF THE UNIT ONE ────────────────────────────────────────────────────────
 * The unit spec proves the MECHANISM inside `adoptBundle()` with a hand-built bundle. It cannot prove
 * that a REAL BROWSER's own draw loop is what latches `KDModalArea = true` in the first place (the
 * unit fixture fakes that single line). This spec drives a real Heart Tablet through two real
 * `demo-server` pages: the modal is opened by a REAL "move onto the tile" turn, the purchase is
 * completed through KD's OWN button callback (the same one a real click fires — see
 * `clickCardThenAccept` in `mp-perk-agreement.spec.ts` for the established "capture `DrawButtonKDEx`,
 * invoke the real callback" technique, used here because the alternative is pixel-perfect PIXI
 * coordinates for no more fidelity), and the close is observed on the real page's own globals.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, coopPos, waitForPeerAvatar, MP_TEST_TIMEOUT, reportedPageErrors } from './helpers/coop';
import type { Page } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Plant a real Heart Tablet on the WORLD, one tile away from A — the exact shape map generation
 * uses (`KDMapGen.ts:2431`: `Type: "Tablet", Name: goddess`, `goddess === 'Heart'` for this one).
 * `'M'` is the map character that offer tiles use there, and is in `KDInteractableTiles`
 * (`KinkyDungeonGame.ts:115`) so a move onto it is a real interact, not a blocked bump.
 *
 * Server-side (`bridge.session.world.eval`), same as `mp-perk-agreement.spec.ts`'s perk room: this is
 * SETUP, not the mechanism under test, and `KDMapData` is world state the server owns outright.
 */
function plantHeartTablet(bridge: any, x: number, y: number) {
	bridge.session.world.eval(`(function(){
		KinkyDungeonMapSet(${x}, ${y}, 'M');
		KinkyDungeonTilesSet('${x},${y}', { Type: 'Tablet', Name: 'Heart', Light: 3, lightColor: 0x8888ff });
	})()`);
}

/**
 * Walk A onto a known-adjacent tile with a raw, DIRECTED `sendMove` — not `coopMoveAnyDirection`'s
 * try-every-direction walk, because this spec needs A to land on ONE SPECIFIC planted tile, not
 * merely "some open tile". `[-1, 0]` is the same "away from B" default direction every other helper
 * in this file tries first, so it is not a new assumption. Lockstep still needs B's turn.
 */
async function moveOnto(A: Page, B: Page, dx: number, dy: number, timeout = 20_000) {
	const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
	await A.evaluate((d) => (window as any).__coop.sendMove(d.dx, d.dy), { dx, dy });
	await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
	await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout });
}

/**
 * Buy Stamina (SP) through KD's own Accept-shaped two-step UI, firing the REAL callbacks
 * `KinkyDungeonDrawTablet`/`KDDrawHeartTablet` hand to `DrawButtonKDEx` — the same technique
 * `clickCardThenAccept` in `mp-perk-agreement.spec.ts` uses, and for the same reason: the modal's
 * geometry is PIXI, and a captured callback IS what a pixel click would fire.
 */
async function buyStaminaThroughRealClick(P: Page): Promise<{ sawStatButton: boolean; sawConfirm: boolean }> {
	return P.evaluate(() => {
		// @ts-ignore bundle let-global
		const realDraw = DrawButtonKDEx;
		const pick: Record<string, any> = {};
		try {
			// @ts-ignore
			DrawButtonKDEx = (name: string, cb: any) => { pick[name] = cb; };
			// @ts-ignore
			KinkyDungeonDrawTablet();
		// @ts-ignore
		} finally { DrawButtonKDEx = realDraw; }
		const sawStatButton = typeof pick.heartbuySP === 'function';
		if (sawStatButton) pick.heartbuySP();   // the click that sets KDStatChoice = "SP"

		const confirm: Record<string, any> = {};
		try {
			// @ts-ignore
			DrawButtonKDEx = (name: string, cb: any) => { confirm[name] = cb; };
			// @ts-ignore
			KinkyDungeonDrawTablet();
		// @ts-ignore
		} finally { DrawButtonKDEx = realDraw; }
		const sawConfirm = typeof confirm.heartbuyconfirm === 'function';
		// This IS KD's own confirm callback — the one that calls KDSendInput("heart", …).
		if (sawConfirm) confirm.heartbuyconfirm();
		return { sawStatButton, sawConfirm };
	});
}

/** The modal state a frame of `KinkyDungeonHUD`/`KinkyDungeonDraw` would show a real viewer. */
async function modalState(P: Page) {
	return P.evaluate(() => ({
		// @ts-ignore bundle let-globals
		hasTile: !!KinkyDungeonTargetTile,
		// @ts-ignore
		modalArea: !!KDModalArea,
		// @ts-ignore
		xPainted: !!(KDButtonsCache && KDButtonsCache.modalX),
	}));
}

test('the Heart Tablet\'s close button does not survive the purchase that closes it', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errs: string[] = [];
	A.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
	B.on('pageerror', (e) => errs.push(String((e && e.message) || e)));

	try {
		await bootCoopPair(A, B, port);
		await waitForPeerAvatar(B, { timeout: 15_000 }).catch(() => { /* advisory, see coopMoveAnyDirection */ });

		const posA = await coopPos(A);
		const tabletX = posA.x - 1;
		const tabletY = posA.y;
		plantHeartTablet(bridge, tabletX, tabletY);

		// Walk A onto it — a REAL turn, resolved by the authoritative server.
		await moveOnto(A, B, -1, 0);

		// Precondition: the move really did open the modal (the tile reached A's own per-player
		// bundle). Without this, everything below would be asserting on a modal that never opened.
		await A.waitForFunction(() => {
			// @ts-ignore bundle let-global
			return !!KinkyDungeonTargetTile && KinkyDungeonTargetTile.Name === 'Heart';
		}, undefined, { timeout: 20_000 });

		// CONTROL — while the modal is genuinely open: KDModalArea is true on A's OWN page (proof that
		// a real browser's draw loop, not a test fixture, latched it) and the close "X" is painted.
		await A.waitForFunction(() => {
			// @ts-ignore bundle let-globals
			return KDModalArea === true && !!(KDButtonsCache && KDButtonsCache.modalX);
		}, undefined, { timeout: 20_000 });
		const openState = await modalState(A);
		expect(openState, 'CONTROL: the modal is really open before anything is bought').toMatchObject({
			hasTile: true, modalArea: true, xPainted: true,
		});

		// The exact screen point the open modal covers — captured while it is still open, since
		// KDModalArea_x/y/w/h are shared mutable UI state other screens may repoint later.
		const centre = await A.evaluate(() => ({
			// @ts-ignore bundle let-globals
			x: KDModalArea_x + KDModalArea_width / 2,
			// @ts-ignore
			y: KDModalArea_y + KDModalArea_height / 2,
		}));
		const inModalWhileOpen = await A.evaluate((p) => {
			// @ts-ignore bundle let-globals — this is the same probe KD's own mouse-in-modal check uses
			return KDPointInModalArea(p.x, p.y);
		}, centre);
		expect(inModalWhileOpen, 'CONTROL: the probe can see the modal while it is open — or the '
			+ 'assertion below would be vacuous').toBe(true);

		// Buy Stamina through KD's own two real button callbacks.
		const bought = await buyStaminaThroughRealClick(A);
		expect(bought.sawStatButton, 'the Stamina row was really offered').toBe(true);
		expect(bought.sawConfirm, 'the confirm button was really offered after picking it').toBe(true);

		// "heart" advances a turn, so it needs the party's lockstep like any other turn-consuming input.
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((t) => (window as any).__coop.lastTick !== t, t0, { timeout: 20_000 });

		// The purchase really happened, server-side: this is the control that the earlier steps did
		// something real, not merely that buttons existed.
		await expect.poll(async () => {
			const sp: number = await A.evaluate(() => {
				// @ts-ignore bundle let-global
				return KinkyDungeonStatStaminaMax;
			});
			return sp;
		}, { message: 'the Stamina stat must actually have gone up', timeout: 20_000 })
			.toBeGreaterThan(0);

		// ── THE ASSERTION ─────────────────────────────────────────────────────────────────────────
		await expect.poll(async () => modalState(A), {
			message: 'the tile cleared (already a generic mechanism) but KDModalArea must clear WITH it',
			timeout: 20_000,
		}).toMatchObject({ hasTile: false, modalArea: false, xPainted: false });

		const closedInModal = await A.evaluate((p) => {
			// @ts-ignore
			return KDPointInModalArea(p.x, p.y);
		}, centre);
		expect(closedInModal, 'the exact spot that used to be inside the modal must no longer block '
			+ 'a move-path hover').toBe(false);

		const { real } = reportedPageErrors(errs);
		expect(real, 'no page errors while closing the Heart Tablet').toEqual([]);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await new Promise((r) => server.close(r));
	}
});
