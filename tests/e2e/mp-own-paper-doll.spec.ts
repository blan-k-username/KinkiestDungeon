/**
 * E2E — in co-op, your OWN character shows your own restraints and lost clothes, exactly as in single
 * player (KDM-322).
 *
 * KD draws the player from the paper doll `KinkyDungeonPlayer` (a Character), re-dressed by
 * `KinkyDungeonDressPlayer` whenever the worn set changes: a restraint gets its model, and clothing the
 * restraint displaces is `Lost` (an `ItemBoots` restraint loses the `Shoes`, `KinkyDungeonDress.ts`).
 * The co-op client runs that same re-dress (render-client.js, restraint-sync block). But the per-player
 * bundle also carried `KinkyDungeonPlayer` itself, and adopting it REPLACED the client's paper doll with
 * the headless server's — which never draws restraints and still wears the join-time look. So a bound
 * co-op player saw themselves unbound and fully dressed.
 *
 * #1 is the single-player ground truth, so #2 asserts "the same as single player", not a guess.
 * #3 (KDM-344) closes the chain: the PARTNER sees exactly what the player sees of themselves (owner,
 * 2026-10-04) — each client sends its own drawn look when it changes (coop-bootstrap.js `sendOwnLook`),
 * the server puts it on the avatar, the partner's client applies it. Checked bound AND freed, so a
 * restraint cannot outlive the partner getting free.
 * The restraint is put on server-side (the world owns the worn set) — the same mutation an enemy's
 * bind makes — and two ordinary turns follow, so a later bundle is adopted after the re-dress.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { Page } from '@playwright/test';
import { bootKD } from '../helpers/bundle';
import { bootCoopPair, MP_TEST_TIMEOUT, coopWaitTurn, declareDyedCharacter, waitForPeerAvatar } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const RESTRAINT = 'DuctTapeBoots';      // ItemBoots, not armour → displaces Shoes (KinkyDungeonDress.ts)
const RESTRAINT_MODEL = 'TapeHeavyBoots';

/** The drawn paper doll: model names, and which of them are shoes (KD's own `Shoes` category). */
const doll = (P: Page) => P.evaluate(() => {
	// @ts-ignore bare let-globals
	const models = (KinkyDungeonPlayer.Appearance || []).map((a: any) => a && a.Model && a.Model.Name).filter(Boolean);
	// @ts-ignore
	const shoes = models.filter((n: string) => (ModelDefs[n] && ModelDefs[n].Categories || []).includes('Shoes'));
	return { models, shoes };
});

test('#1 single player: a boots restraint is drawn and the shoes are lost (ground truth)', async ({ isolatedPage }) => {
	test.setTimeout(240_000);
	const P = isolatedPage;
	await bootKD(P);
	await P.evaluate(() => { /* @ts-ignore */ KinkyDungeonStartNewGame(false); });
	const before = await doll(P);
	expect(before.shoes.length, 'precondition: the starting look wears shoes').toBeGreaterThan(0);
	await P.evaluate((r) => {
		// @ts-ignore
		KinkyDungeonAddRestraintIfWeaker(r, 0, true);
		// @ts-ignore
		KinkyDungeonDressPlayer();
	}, RESTRAINT);
	const after = await doll(P);
	expect(after.models, 'the restraint is drawn').toContain(RESTRAINT_MODEL);
	expect(after.shoes, 'the shoes are lost').toEqual([]);
});

test('#2 co-op: your own character shows the same — not the server copy of it', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
	const A = await ctxA.newPage(); const B = await ctxB.newPage();
	const turn = () => coopWaitTurn(A, B);
	try {
		// Each player declares their own CUSTOMISED character (`declareDyedCharacter`): with a stock or
		// undeclared look the server's paper doll never leaves its baseline, is never captured, and the
		// bug cannot show — measured: this test is green without it.
		await bootCoopPair(A, B, port, { characters: { A: declareDyedCharacter('#11CC33'), B: declareDyedCharacter('#11CC33') } });
		await turn();
		const before = await doll(A);
		expect(before.shoes.length, 'precondition: A starts wearing shoes').toBeGreaterThan(0);

		const s = bridge.session; const aId = s._joined[0];
		s._restorePlayer(aId);
		expect(s.world.eval(`!!KinkyDungeonAddRestraintIfWeaker(${JSON.stringify(RESTRAINT)}, 0, true)`),
			'setup: the world put the restraint on A').toBe(true);
		s.bundles.set(aId, s.world.capturePlayer());
		await turn(); await turn();

		await expect.poll(async () => (await doll(A)).models, { timeout: 10_000, message: "A's own doll draws the restraint" })
			.toContain(RESTRAINT_MODEL);
		await turn();                                   // and it is still there after another adopted bundle
		const after = await doll(A);
		expect(after.models, 'still drawn after a further turn').toContain(RESTRAINT_MODEL);
		expect(after.shoes, 'the shoes are lost, as in single player').toEqual([]);
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});

/** A's look as B's screen draws it: the model names on the avatar's generated NPC character. */
const peerDoll = (B: Page, id: number) => B.evaluate((eid: number) => {
	// @ts-ignore bare let-global
	const C = KDNPCChar.get(eid);
	return C ? (C.Appearance || []).map((a: any) => a && a.Model && a.Model.Name).filter(Boolean) : null;
}, id);
const sameSet = (xs: string[] | null) => Array.from(new Set(xs || [])).sort();

test("#3 co-op: the partner sees exactly what you see of yourself (KDM-344)", async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
	const A = await ctxA.newPage(); const B = await ctxB.newPage();
	const turn = () => coopWaitTurn(A, B);
	try {
		await bootCoopPair(A, B, port, { characters: { A: declareDyedCharacter('#11CC33'), B: declareDyedCharacter('#CC1133') } });
		const peer = await waitForPeerAvatar(B, { label: "B's view of A" });
		await turn();
		await B.waitForFunction((id: number) => { /* @ts-ignore */ return !!KDNPCChar.get(id); }, peer.id, { timeout: 30_000 });
		// Control: before any restraint, B already sees A's own look (KDM-318).
		await expect.poll(async () => sameSet(await peerDoll(B, peer.id)), { timeout: 15_000, message: 'B sees A as A sees A' })
			.toEqual(sameSet((await doll(A)).models));

		// The world binds A (the same mutation an enemy's bind makes).
		const s = bridge.session; const aId = s._joined[0];
		s._restorePlayer(aId);
		expect(s.world.eval(`!!KinkyDungeonAddRestraintIfWeaker(${JSON.stringify(RESTRAINT)}, 0, true)`), 'setup: A bound').toBe(true);
		s.bundles.set(aId, s.world.capturePlayer());
		await turn(); await turn();
		const own = await doll(A);
		expect(own.models, "precondition: A's own doll draws the restraint (#2)").toContain(RESTRAINT_MODEL);
		expect(own.shoes, "precondition: A's shoes are lost (#2)").toEqual([]);
		await expect.poll(async () => sameSet(await peerDoll(B, peer.id)), { timeout: 15_000, message: "B's view of bound A" })
			.toEqual(sameSet(own.models));

		// Freed: the restraint must not outlive it on B's screen, and the shoes come back on both.
		s._restorePlayer(aId);
		s.world.eval(`KinkyDungeonRemoveRestraint("ItemBoots")`);
		s.bundles.set(aId, s.world.capturePlayer());
		await turn(); await turn();
		const freed = await doll(A);
		expect(freed.models, 'A is free').not.toContain(RESTRAINT_MODEL);
		await expect.poll(async () => sameSet(await peerDoll(B, peer.id)), { timeout: 15_000, message: "B's view of freed A" })
			.toEqual(sameSet(freed.models));
	} finally {
		await ctxA.close().catch(() => {}); await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
