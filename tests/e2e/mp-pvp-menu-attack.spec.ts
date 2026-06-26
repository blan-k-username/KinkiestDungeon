/**
 * E2E (Playwright/Chromium) — KD-098: PvP attack via KD's REAL context menu.
 *
 * Reproduces the hands-on UAT sequence faithfully: a CO-OP session (no KD_PVP), then A
 * starts PvP with a sneak and keeps attacking — each action issued through KD's actual
 * context-menu builder `KDGetContextActions.Game` and its option callbacks (the exact code
 * a right-click runs), NOT a synthetic sendAction. This exercises what the UI offers and
 * sends each turn: the talk/Aggro(doaggro) vs Attack(doattack) branch, grey-out gates,
 * range/stamina re-checks. Asserts the peer stays attackable and the victim's Will keeps
 * dropping turn over turn.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const TURNS = 4;

/** Drive KD's real context menu against the peer avatar; invoke the attack option it offers. */
async function menuAttackPeer(P: any) {
	return P.evaluate(() => {
		const w = window as any;
		// @ts-ignore bare let-globals
		const peer = ((KDMapData as any).Entities || []).find((x: any) => x.Enemy && typeof x.Enemy.name === 'string' && x.Enemy.name.indexOf('RemotePlayer') === 0);
		if (!peer) return { ok: false, why: 'no-peer-entity' };
		// Target the peer's TILE directly. The .Game wrapper re-aims from KDContextX/Y as
		// pixel coords (KinkyDungeonSetTargetLocation), which we can't easily compute headless;
		// the vanilla builder below reads KinkyDungeonTargetX/Y (tile coords) straight, so set
		// those — this isolates the menu's entity logic for the peer tile.
		// @ts-ignore
		KinkyDungeonTargetX = peer.x; KinkyDungeonTargetY = peer.y;
		// @ts-ignore
		const vis = (typeof KinkyDungeonVisionGet === 'function') ? KinkyDungeonVisionGet(peer.x, peer.y) : -1;
		// @ts-ignore
		const see = (typeof KDCanSeeEnemy === 'function') ? !!KDCanSeeEnemy(peer) : true;
		// DIAGNOSTIC: what KD's own lookup returns at the peer tile (the menu uses this)
		// @ts-ignore
		const at = (typeof KinkyDungeonEntityAt === 'function') ? KinkyDungeonEntityAt(peer.x, peer.y) : null;
		// @ts-ignore
		const pe = (typeof KinkyDungeonPlayerEntity !== 'undefined') ? KinkyDungeonPlayerEntity : null;
		const dbg = {
			peerPlayerField: peer.player,
			playerPos: pe ? { x: pe.x, y: pe.y } : null,
			entityAt: at ? { id: at.id, player: at.player, isPlayerEntity: at === pe, name: at.Enemy && at.Enemy.name } : null,
			// @ts-ignore
			cacheFlag: (typeof KDUpdateEnemyCache !== 'undefined') ? KDUpdateEnemyCache : 'undef',
		};
		// build the REAL menu options via KD's own vanilla builder, against the peer tile
		const options: string[] = [];
		const optionImages: any = {}, optionActions: any = {}, optionGrey: any = {}, optionText: any = {}, optionColor: any = {}, optionFilter: any[] = [];
		// @ts-ignore bare global fn
		if (typeof KDGetGameContextActionsVanilla !== 'function') return { ok: false, why: 'no-vanilla-builder', vis, see, dbg };
		// @ts-ignore
		KDGetGameContextActionsVanilla(false, options, optionImages, optionActions, optionGrey, optionText, optionColor, optionFilter);
		const menu = { options, optionActions, optionGrey };
		const grey = optionGrey;
		// pick the attack-ish option the UI would use
		const key = ['Attack', 'Aggro', 'Tease', 'Capture'].find((k) => options.includes(k));
		if (!key) return { ok: false, why: 'no-attack-option', options, vis, see, dbg };
		if (grey[key]) return { ok: false, why: 'option-greyed', key, options, grey, vis, see };
		// reset the per-turn submit gate so the routed KDSendInput actually forwards
		if (w.__coop) w.__coop.submitted = false;
		// invoke the REAL option callback (runs KDSendInput → routed → submit → WS)
		try { menu.optionActions[key](0, 0); } catch (e) { return { ok: false, why: 'action-threw:' + (e && (e as any).message), key, options }; }
		return { ok: true, key, options, vis, see, sent: !!(w.__coop && w.__coop.submitted) };
	});
}

test('PvP via the real context menu: sneak then repeated attacks keep landing', async ({ browser }) => {
	test.setTimeout(300_000);
	// CO-OP (no KD_PVP) — exactly the UAT path: PvP begins from the sneak.
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const willOfB = () => B.evaluate(() => /* @ts-ignore */ KinkyDungeonStatWill as number);
	const advance = async (t0: number) => {
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
	};

	try {
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });
		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForTimeout(1500);

		let prevWill = await willOfB();
		const trace: any[] = [];
		let attackTurns = 0;

		for (let t = 1; t <= TURNS; t++) {
			const r = await menuAttackPeer(A);
			const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
			if (!r.ok) {
				// the UI offered/sent nothing → A must still act so we can observe (wait)
				await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			}
			await advance(t0);
			const will = await willOfB();
			trace.push({ t, ...r, willBefore: prevWill, willAfter: will });

			expect(r.ok, `turn ${t}: context menu did not offer/send an attack — ${JSON.stringify(r)}. trace=${JSON.stringify(trace)}`).toBe(true);
			// Real KD mechanic: the sneak/Aggro option (doaggro, unaware) does NOT deal damage —
			// it makes the peer hostile + stun(1) + vulnerable(1) (KDAggroViaDialogue). The damage
			// lands on the FOLLOW-UP Attack (doattack), boosted by `vulnerable`. So Will only drops
			// on Attack/Tease/Capture turns, not the sneak-transition turn. (The synthetic KD-098/099
			// path dealt sneak damage directly; KD-100 moved PvP to the real pipeline — KD-102.)
			if (r.key !== 'Aggro') {
				attackTurns++;
				expect(will, `turn ${t}: B Will did not drop (was ${prevWill}, now ${will}) after menu sent '${r.key}'. trace=${JSON.stringify(trace)}`).toBeLessThan(prevWill);
			}
			prevWill = will;
		}
		// the whole point ("repeated attacks keep landing"): the menu must transition past the sneak
		// to real attacks that each land — otherwise the peer is stuck un-attackable.
		expect(attackTurns, `menu never transitioned from sneak to landing attacks. trace=${JSON.stringify(trace)}`).toBeGreaterThan(0);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
	}
});
