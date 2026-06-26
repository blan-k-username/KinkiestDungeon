/**
 * E2E (KD-101) — applying a tie AFTER you've already acted this turn must still work.
 *
 * Live symptom: the submenu apply emitted the correct addNPCRestraint, but it was dropped with
 * "submit BLOCKED … alreadySubmitted:true" because the attacker had already submitted an action this
 * turn (lockstep one-action-per-turn). A manual action now REPLACES a still-pending one (the server
 * keeps only the latest pending action; the turn waits for the peer regardless). This drives:
 * B submits a wait, THEN B applies the tie — and the tie still lands on A.
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('a tie applied after already acting this turn still lands (manual re-submit overrides)', async ({ browser }) => {
	test.setTimeout(300_000);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	// capture the exact live symptom: "[coop B] submit BLOCKED … alreadySubmitted:true"
	const blocked: string[] = [];
	B.on('console', (m) => { const t = m.text(); if (/submit BLOCKED/.test(t)) blocked.push(t); });

	const peerOfB = () => B.evaluate(() => {
		// @ts-ignore
		const e = ((KDMapData as any).Entities || []).find((x: any) => x.Enemy && x.Enemy.name && x.Enemy.name.indexOf('RemotePlayer') === 0);
		return e ? { id: e.id, x: e.x, y: e.y } : null;
	});

	try {
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });
		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForTimeout(1500);
		const session = bridge.session;

		for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await peerOfB();
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
		}
		expect(session.isDefeated('A')).toBe(true);

		const before = session.snapshotFor('A').restraints.length;
		const peer = await peerOfB();

		// B acts FIRST (uses up the turn under the old gate), THEN applies the tie — must still work
		const acted = await B.evaluate(() => {
			(window as any).__coop.sendAction({ kind: 'wait' });
			return (window as any).__coop.submitted === true;
		});
		expect(acted, 'B should be in the submitted/waiting state before tying').toBe(true);

		await B.evaluate((p) => {
			// @ts-ignore — open the tie submenu (quick-bind pre-selected the rope) and apply
			KDSendInput('tryCastSpell', { tx: p.x, ty: p.y, spell: KDBondageSpell, spellname: 'Bondage', enemy: undefined, player: KDPlayer(), bullet: undefined });
			const draw = () => { /* @ts-ignore */ KDButtonsCache = {}; /* @ts-ignore */ KDDrawCollectionRestrainMain(p.id, 1300, 250); };
			draw();
			// @ts-ignore
			const itemName = KDSelectedGenericBindItem;
			for (let n = 0; n < 2; n++) {
				// @ts-ignore
				const btn = KDButtonsCache['gen_bind_list' + itemName];
				if (btn && btn.func) btn.func(btn);
				draw();
			}
		}, peer);

		// A acts → the turn resolves with B's REPLACED action (the tie), not the earlier wait
		const tB = await B.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });

		// the tie's addNPCRestraint must NOT have been dropped by the turn gate (the live symptom)
		const tieBlocked = blocked.filter((t) => /addNPCRestraint/.test(t));
		expect(tieBlocked, `tie submit was dropped (reproduced the live "submit BLOCKED"): ${JSON.stringify(tieBlocked)}`).toEqual([]);
		const after = session.snapshotFor('A').restraints;
		expect(after.length, `tie applied after acting should still land (was ${before})`).toBeGreaterThan(before);
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
