/**
 * KDM-162 — I4 RENDER COMPLETENESS (AC2), in a real browser.
 *
 * The claim under test: a thin client that adopts its own per-player STATE BUNDLE ends up with the
 * same state the server holds for it — so the curated `stats` block on the wire, and the pile of
 * hand-called re-derivations in `render-client.apply()`, are both unnecessary.
 *
 * That claim was measured node-side (KDM-162 probe6: 0 wrong fields across 4949 candidate globals),
 * but node-side proves nothing about the BROWSER — gray zone G1. The browser has no `restorePlayer`
 * path and holds render-model state (paper doll, poses) that lives outside the globals the node probe
 * fingerprinted. This spec is that missing half.
 *
 * ORACLE (non-circular): the server's own bundle for player A is ground truth; A's browser is the
 * thing under test. We assert the browser matches the server, per key, for every key the server
 * carries — no hand-picked field list, which is the whole point of the epic.
 *
 * RED BEFORE GREEN: today the client syncs exactly three KDGameData fields (MovePoints, SlowMoveTurns,
 * SprintTurns — `render-client.js:213`), so the parity assertion must FAIL before the change and pass
 * after. If it ever passes without the implementation, the test is vacuous — see KDM-159 §6.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KDGAMEDATA_WORLD_KEYS } = require('../../tools/mp-server/headless-host');

test('I4: browser client state matches the server bundle for that player', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	// Start already bound: an unbound player exercises almost none of the derived state this is about.
	process.env.KD_WEAR_RESTRAINT = 'DuctTapeFeet,HingedCuffs';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const advance = async () => {
		const t0 = await A.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction((p) => (window as any).__coop.lastTick > p, t0, { timeout: 60_000 });
	};

	try {
		await bootCoopPair(A, B, port);
		const session = bridge.session;

		// A few real turns so derived state is genuinely populated, not just post-boot defaults.
		for (let i = 0; i < 3; i++) await advance();

		// ---- AC3 regression guard, asserted FIRST on purpose.
		// These are the bugs already paid for (KDM-156 struggle-group crash, KD-103 arm pose, the x1
		// reticule) and they must hold WITHOUT the hand-called re-derivations that used to live in
		// apply(). Ordered before the parity block so that a causality run — adoptBundle stubbed to a
		// no-op — shows whether the BUNDLE is what keeps them green, instead of short-circuiting on
		// the parity failure and telling us nothing about them.
		const derived = await A.evaluate(() => ({
			// @ts-ignore
			worn: (typeof KinkyDungeonAllRestraint === 'function') ? KinkyDungeonAllRestraint().map((r: any) => r.name) : [],
			// @ts-ignore
			sgroups: (typeof KinkyDungeonStruggleGroups !== 'undefined' && KinkyDungeonStruggleGroups) ? Object.keys(KinkyDungeonStruggleGroups).length : -1,
			// @ts-ignore
			armsBound: (typeof KinkyDungeonIsArmsBound === 'function') ? !!KinkyDungeonIsArmsBound(false, false) : null,
			// @ts-ignore
			slowLevel: (typeof KinkyDungeonSlowLevel !== 'undefined') ? KinkyDungeonSlowLevel : -1,
			// @ts-ignore  the paper-doll half of G1: model state lives outside the globals probe6 saw
			// @ts-ignore
			poses: (typeof KDCurrentModels !== 'undefined' && typeof KinkyDungeonPlayer !== 'undefined' && KDCurrentModels.get(KinkyDungeonPlayer))
				// @ts-ignore
				? Object.keys(KDCurrentModels.get(KinkyDungeonPlayer).Poses || {}).filter((p) => KDCurrentModels.get(KinkyDungeonPlayer).Poses[p]).length
				: -1,
		}));
		expect(derived.worn.length, `A should be wearing its seeded restraints, got ${JSON.stringify(derived.worn)}`).toBeGreaterThan(0);
		expect(derived.sgroups, 'struggle groups must be populated (the KDM-156 crash class)').toBeGreaterThan(0);
		expect(derived.slowLevel, 'a bound player should have a non-zero slow level').toBeGreaterThan(0);
		expect(derived.poses, 'the player model must have poses (paper-doll / arm-pose state)').toBeGreaterThan(0);

		// ---- ground truth: the actual WIRE payload for A, not the raw internal bundle.
		// The contract under test is "everything the server ships, the client ends up with". Comparing
		// against the raw bundle instead would fail on the fields the server deliberately does NOT ship
		// because only the client can compute them (vision outputs — see CLIENT_OWNED_GAMEDATA_KEYS),
		// and it would be asserting a contract we do not want.
		const wire = session.snapshotFor('A');
		expect(wire.bundle, 'snapshot for A carries no state bundle').toBeTruthy();
		const serverGD = wire.bundle.gameData || {};
		expect(Object.keys(serverGD).length, 'wire bundle carries no KDGameData').toBeGreaterThan(10);

		// ---- what A's BROWSER actually has
		const clientGD = await A.evaluate(() =>
			// @ts-ignore  bundle-scope global, reachable by bare name from a classic script
			(typeof KDGameData !== 'undefined' && KDGameData) ? JSON.parse(JSON.stringify(KDGameData)) : null);
		expect(clientGD, 'A has no KDGameData').toBeTruthy();

		// ---- I4: per-key parity over every key the server carries (minus the shared world)
		const world = new Set(KDGAMEDATA_WORLD_KEYS);
		const mismatches: string[] = [];
		for (const k of Object.keys(serverGD)) {
			if (world.has(k)) continue;                     // shared floor/world state — not this player's
			const s = JSON.stringify(serverGD[k]);
			const c = JSON.stringify((clientGD as any)[k]);
			if (s !== c) mismatches.push(`${k}: server=${String(s).slice(0, 60)} client=${String(c).slice(0, 60)}`);
		}
		expect(
			mismatches,
			`client KDGameData diverges from the server bundle on ${mismatches.length} key(s):\n  ` +
			mismatches.slice(0, 25).join('\n  '),
		).toEqual([]);

	} finally {
		delete process.env.KD_WEAR_RESTRAINT;
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		await new Promise((r) => server.close(r));
	}
});
