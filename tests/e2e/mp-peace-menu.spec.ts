/**
 * E2E (KDM-225) — the peace handshake through KD's REAL context menu, in two browsers.
 *
 * The user-observable half of the feature, so `TESTING_POLICY.md` requires it. It drives the same
 * surface a player does — `KDGetContextActions.Game`, the builder a right-click runs — rather than a
 * synthetic action, which is the precedent set by `mp-pvp-menu-attack.spec.ts`.
 *
 * The design under test (KDM-225 D8): the offer and the answer both live on the player's OWN tile.
 * That is what makes this reachable at all — measured in `mp-peace-menu-gate-probe.spec.ts`, the
 * peer's menu is behind a hostility gate AND a vision gate, and the player's own menu is behind
 * neither (`KDContextMenu.ts:293`, the `entity == KDPlayer()` branch).
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Build KD's real context menu on the player's OWN tile and report what it offers.
 *
 * Goes through `KDGetContextActions.Game` — the REGISTRY entry a right-click runs — not through
 * `KDGetGameContextActionsVanilla`. The sibling spec `mp-pvp-menu-attack.spec.ts` calls the vanilla
 * builder deliberately, to isolate entity logic from pixel aiming; here that would be wrong, because
 * the peace entries are added by a cooperative wrap AROUND the registry entry and the vanilla builder
 * never sees them. (Measured: calling vanilla returned `["Wait","Inventory","Special"]` with the wrap
 * installed and working.)
 *
 * `.Game` re-aims from `KDContextX/KDContextY` as PIXELS via `KinkyDungeonSetTargetLocation`, so the
 * tile is converted by inverting that function's own formula (`KinkyDungeonDraw.ts:3001-3002`):
 *   TargetX = round((mx - grid/2 - canvasOffsetX)/grid) + CamX
 */
async function ownMenu(P: any) {
	return P.evaluate(() => {
		// @ts-ignore bare let-globals
		const me = KDPlayer();
		// @ts-ignore
		const grid = KinkyDungeonGridSizeDisplay;
		// @ts-ignore
		const mx = (me.x - KinkyDungeonCamX) * grid + grid / 2 + canvasOffsetX;
		// @ts-ignore
		const my = (me.y - KinkyDungeonCamY) * grid + grid / 2 + canvasOffsetY;
		// @ts-ignore
		KDContextX = mx; KDContextY = my;
		// @ts-ignore
		if (typeof KDGetContextActions === 'undefined' || !KDGetContextActions.Game) {
			return { ok: false, why: 'no-registry' };
		}
		// @ts-ignore
		const menu = KDGetContextActions.Game(false, mx, my, {});
		(window as any).__peerMenu = { optionActions: menu.optionActions };
		return {
			ok: true, options: menu.options, grey: menu.optionGrey, text: menu.optionText,
			at: { x: me.x, y: me.y },
			// @ts-ignore — proves the aiming landed on the player's own tile, so a missing entry is a
			// real absence and not a mis-aimed menu.
			aimed: { x: KinkyDungeonTargetX, y: KinkyDungeonTargetY },
			// @ts-ignore
			wrapped: !!(KDGetContextActions.Game as any)._kdcoop_peace_wrapped,
			coop: (window as any).KDRenderClient ? (window as any).KDRenderClient.lastCoop : null,
		};
	});
}

/** Invoke one option the menu offered, exactly as a click would. */
async function pickOption(P: any, key: string) {
	return P.evaluate((k: string) => {
		const w = window as any;
		const actions = w.__peerMenu && w.__peerMenu.optionActions;
		if (!actions || !actions[k]) return { ok: false, why: 'no-such-option:' + k };
		if (w.__coop) w.__coop.submitted = false;
		try { actions[k](0, 0); } catch (e) { return { ok: false, why: 'threw:' + (e && (e as any).message) }; }
		return { ok: true };
	}, key);
}

/** Does this client believe it is at war with the peer? Read from the standing snapshot state (A4). */
async function atWar(P: any) {
	return P.evaluate(() => {
		const w = window as any;
		const coop = w.KDRenderClient && w.KDRenderClient.lastCoop;
		return !!(coop && coop.war && coop.war.length > 0);
	});
}

test('offer peace from your own menu; the peer accepts from theirs', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	// CO-OP start (no KD_PVP) — war has to be STARTED by an attack, as in the UAT that prompted this.
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// ---- 1. no war yet → neither player is offered peace (R2) -------------------------------
		const peaceBeforeWar = await ownMenu(A);
		expect(peaceBeforeWar.ok, JSON.stringify(peaceBeforeWar)).toBe(true);
		expect(peaceBeforeWar.wrapped, 'precondition: the context-menu wrap is installed').toBe(true);
		expect(peaceBeforeWar.aimed, 'precondition: the menu is aimed at the player\'s own tile')
			.toEqual(peaceBeforeWar.at);
		expect(peaceBeforeWar.options,
			'R2: with nobody to make peace with, the entry must not be there').not.toContain('Peace');

		// ---- 2. A sneak-attacks B → war ---------------------------------------------------------
		const peer = await waitForPeerAvatar(A, { label: 'A starting the war' });
		await A.evaluate((id: number) => {
			const w = window as any;
			// @ts-ignore
			const p = ((KDMapData as any).Entities || []).find((x: any) => x.id === id);
			if (w.__coop) w.__coop.submitted = false;
			// @ts-ignore — KD's own aggro input, the one the Aggro menu option sends
			KDSendInput('doaggro', { tx: p.x, ty: p.y, id: p.id, unaware: true, aggroothers: false });
		}, peer.id);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!(c && c.war && c.war.length > 0);
		}, undefined, { timeout: 60_000 });
		expect(await atWar(A), 'precondition: the sneak started PvP').toBe(true);

		// ---- 3. A's own menu now offers Peace (R1) ----------------------------------------------
		const armed = await ownMenu(A);
		expect(armed.options,
			'R1/D8: at war, the offer lives on your OWN tile — no adjacency, no line of sight')
			.toContain('Peace');

		// ---- 4. A offers; nothing about the war changes yet (R4) --------------------------------
		expect((await pickOption(A, 'Peace')).ok).toBe(true);
		await B.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!(c && c.peaceOffer);
		}, undefined, { timeout: 60_000 });
		expect(await atWar(A), 'R4: an offer is not a truce').toBe(true);

		// ---- 5. A cannot ask twice while it is unanswered (R3) ----------------------------------
		const asked = await ownMenu(A);
		expect(asked.options, 'R3: you already asked').not.toContain('Peace');

		// ---- 6. B's own menu carries the answer (D8/A6) ------------------------------------------
		const asked_B = await ownMenu(B);
		expect(asked_B.options, 'B answers from the same surface — no second UI').toContain('PeaceAccept');
		expect(asked_B.options).toContain('PeaceDecline');

		// ---- 7. B accepts → both sides are at peace (R6/AC3) -------------------------------------
		expect((await pickOption(B, 'PeaceAccept')).ok).toBe(true);
		await A.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!c && (!c.war || c.war.length === 0);
		}, undefined, { timeout: 60_000 });
		expect(await atWar(A), 'A sees peace').toBe(false);
		expect(await atWar(B), 'and so does B — no split verdict').toBe(false);

		// ---- 8. and the entry is gone again (R2) -------------------------------------------------
		const atPeace = await ownMenu(A);
		expect(atPeace.options, 'nothing left to offer').not.toContain('Peace');
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
