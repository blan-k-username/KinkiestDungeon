/**
 * E2E (Playwright/Chromium) — KD-098: repeatable PvP targeting in the browser.
 *
 * Hands-on UAT bug: the FIRST PvP attack lands, but follow-up attacks "do nothing".
 * The server is proven correct across many turns (node repro). So the browser stops
 * SENDING the attack. KD's context menu nulls the target entity when its tile fails the
 * visibility gate (KDContextMenu.ts:163 KinkyDungeonVisionGet, :169 KDCanSeeEnemy) — the
 * thin client recomputes vision locally and the peer avatar appears to fall out of view
 * after turn 1, so the right-click offers no Attack/Aggro option and nothing is sent.
 *
 * This test reproduces it deterministically: two browsers in a PvP session, A attacks
 * the peer each turn — but ONLY when the context-menu visibility gate would allow it
 * (exactly what the UI requires). It asserts the peer stays targetable AND the victim's
 * Will keeps dropping every turn. With the bug, turn 2+ fails the gate → no damage.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const TURNS = 4;

test('PvP: A can attack the peer every turn (context-menu visibility holds)', async ({ browser }) => {
	test.setTimeout(300_000);
	process.env.KD_PVP = '1'; // peers are Enemy faction from the start → doattack path
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	// What A's context menu sees for the peer avatar: the same gate KDContextMenu applies
	// before it will offer (and send) an Attack/Aggro on the entity.
	const peerGateA = () => A.evaluate(() => {
		// @ts-ignore bare let-globals
		const e = ((KDMapData as any).Entities || []).find((x: any) => x.Enemy && typeof x.Enemy.name === 'string' && x.Enemy.name.indexOf('RemotePlayer') === 0);
		if (!e) return null;
		// @ts-ignore
		const vis = (typeof KinkyDungeonVisionGet === 'function') ? KinkyDungeonVisionGet(e.x, e.y) : -1;
		// @ts-ignore
		const see = (typeof KDCanSeeEnemy === 'function') ? !!KDCanSeeEnemy(e) : true;
		return { id: e.id, x: e.x, y: e.y, vis, see, targetable: vis > 0 && see };
	});
	const willOfB = () => B.evaluate(() => /* @ts-ignore */ KinkyDungeonStatWill as number);

	try {
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });
		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForTimeout(1500); // let render + vision settle

		let prevWill = await willOfB();
		const trace: any[] = [];

		for (let t = 1; t <= TURNS; t++) {
			const peer = await peerGateA();
			expect(peer, `turn ${t}: A has no peer avatar entity at all`).not.toBeNull();

			// Mimic the UI exactly: only send the attack if the context-menu gate allows it;
			// otherwise the click is a no-op and the player would "wait".
			if (peer!.targetable) {
				await A.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			} else {
				await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			}
			const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
			await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await A.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });

			const will = await willOfB();
			trace.push({ t, ...peer, willBefore: prevWill, willAfter: will });

			// PRIMARY: the peer must stay targetable for PvP to be repeatable.
			expect(peer!.targetable, `turn ${t}: peer not targetable — vis=${peer!.vis} see=${peer!.see} (context menu would offer no attack). trace=${JSON.stringify(trace)}`).toBe(true);
			// OUTCOME: a landed attack must reduce the victim's Will.
			expect(will, `turn ${t}: B Will did not drop (was ${prevWill}, now ${will}). trace=${JSON.stringify(trace)}`).toBeLessThan(prevWill);
			prevWill = will;
		}
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
