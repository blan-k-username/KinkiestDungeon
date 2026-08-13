/**
 * KD-103 diagnostic #2 (PROPERTY-level, on the VICTIM's MP client — NOT pixels).
 *
 * The integration property test (mp-bind-render-property) proved that the render-client hand-rebuild
 * path produces the SAME MC.Poses/MC.Models as the real KinkyDungeonAddRestraint. So if the victim's
 * screen still shows nothing live, the divergence is on the VICTIM's MP client specifically.
 *
 * This probes A's client (the tied victim) and dumps the model-container properties before/after the
 * tie so we can see EXACTLY where it diverges from the clean integration result:
 *   - worn = KinkyDungeonAllRestraint() names
 *   - MC = KDCurrentModels.get(KinkyDungeonPlayer): does it exist? Models keys, Poses keys (bound?),
 *     Update size, Refresh size
 *   - Appearance length
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

test('PROBE: victim MP client model-container state after a tie', async ({ browser }) => {
	test.setTimeout(300_000);
	process.env.KD_PVP = '1';
	const { server, bridge, port } = await start(0);
	const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	const peerOfB = () => B.evaluate(() => {
		// @ts-ignore
		const e = ((KDMapData as any).Entities || []).find((x: any) => x.Enemy && x.Enemy.name && x.Enemy.name.indexOf('RemotePlayer') === 0);
		return e ? { id: e.id, x: e.x, y: e.y } : null;
	});
	const probeA = () => A.evaluate(() => {
		/* eslint-disable */
		// @ts-nocheck
		// @ts-ignore
		const MC = (typeof KDCurrentModels !== 'undefined' && typeof KinkyDungeonPlayer !== 'undefined') ? KDCurrentModels.get(KinkyDungeonPlayer) : null;
		return {
			// @ts-ignore
			worn: typeof KinkyDungeonAllRestraint === 'function' ? KinkyDungeonAllRestraint().map((r) => r.name) : ['<no fn>'],
			hasMC: !!MC,
			// @ts-ignore
			models: MC && MC.Models ? Array.from(MC.Models.keys()) : ['<no MC>'],
			// @ts-ignore
			poses: MC ? Object.keys(MC.Poses || {}).filter((k) => MC.Poses[k]) : ['<no MC>'],
			// @ts-ignore
			updateSize: MC && MC.Update ? MC.Update.size : -1,
			// @ts-ignore
			refreshSize: MC && MC.Refresh ? MC.Refresh.size : -1,
			// @ts-ignore
			containers: MC && MC.Containers ? MC.Containers.size : -1,
			// @ts-ignore
			appearance: (typeof KinkyDungeonPlayer !== 'undefined' && KinkyDungeonPlayer.Appearance) ? KinkyDungeonPlayer.Appearance.length : -1,
			// the properties that control whether arms render BOUND vs Free:
			// @ts-ignore
			armsBound: (typeof KinkyDungeonIsArmsBound === 'function') ? KinkyDungeonIsArmsBound(false, false) : '<undef>',
			// @ts-ignore
			hasArmsFull: (typeof KinkyDungeonPlayerTags !== 'undefined' && KinkyDungeonPlayerTags.has) ? KinkyDungeonPlayerTags.has('ItemArmsFull') : '<undef>',
			// is the player even drawn from the model path? check the local-sim flag
			// @ts-ignore
			localSimDisabled: (typeof KDRenderClient !== 'undefined' && KDRenderClient.isLocalSimDisabled) ? KDRenderClient.isLocalSimDisabled() : '<no KDRenderClient>',
		};
		/* eslint-enable */
	});

	try {
		await A.goto(`http://127.0.0.1:${port}/#coop=A`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.connected, undefined, { timeout: 150_000 });
		await B.goto(`http://127.0.0.1:${port}/#coop=B`);
		await A.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await B.waitForFunction(() => (window as any).__coop && (window as any).__coop.started, undefined, { timeout: 150_000 });
		await A.waitForTimeout(1500);
		const session = bridge.session;

		const before = await probeA();

		for (let i = 0; i < 25 && !session.isDefeated('A'); i++) {
			const peer = await peerOfB();
			await B.evaluate((p) => (window as any).__coop.sendAction({ kdType: 'doattack', data: { tx: p.x, ty: p.y, id: p.id, attackCost: 1 } }), peer);
			const t0 = await B.evaluate(() => (window as any).__coop.lastTick);
			await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
			await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, t0, { timeout: 30_000 });
		}

		const peer = await peerOfB();
		await B.evaluate((p) => {
			// @ts-ignore
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
		const tB = await B.evaluate(() => (window as any).__coop.lastTick);
		await A.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await B.waitForFunction((p) => (window as any).__coop.lastTick === p + 1, tB, { timeout: 30_000 });
		await A.waitForTimeout(2500);

		const after = await probeA();
		const serverR = session.snapshotFor('A').restraints.map((r: any) => r.name);

		// Now force the REAL pose-resolution functions and re-probe — does Free drop / Boxtie+arm model appear?
		const forced = await A.evaluate(() => {
			/* eslint-disable */
			// @ts-nocheck
			// @ts-ignore
			const sp = (typeof StandalonePatched !== 'undefined') ? StandalonePatched : '<undef>';
			// @ts-ignore
			const armsBoundBefore = (typeof KinkyDungeonIsArmsBound === 'function') ? KinkyDungeonIsArmsBound(false, false) : '<undef>';
			// @ts-ignore
			const hadArmsFullBefore = (typeof KinkyDungeonPlayerTags !== 'undefined' && KinkyDungeonPlayerTags.has) ? KinkyDungeonPlayerTags.has('ItemArmsFull') : '<undef>';
			// KDM-156: what the CLIENT produced on its own, before any manual call below. Vanilla
			// rebuilds this in its per-turn stats pass (KinkyDungeonStats.ts:1774), which the thin
			// client never runs; while it stayed stale, every inventory action on a worn restraint
			// hit an undefined `.find()` result and crashed (KDInventoryActions.ts:408 / :424).
			// @ts-ignore
			const sgGroupsAuto = (typeof KinkyDungeonStruggleGroups !== 'undefined')
				// @ts-ignore
				? KinkyDungeonStruggleGroups.map((g) => g.group) : ['<undef>'];
			// THE CANDIDATE FIX — the real per-turn player-tag computation the render-client never runs:
			// @ts-ignore
			try { if (typeof KinkyDungeonUpdateRestraints === 'function') KinkyDungeonPlayerTags = KinkyDungeonUpdateRestraints(KinkyDungeonPlayer, -1, 1); } catch (e) {}
			// @ts-ignore
			try { if (typeof KinkyDungeonDressPlayer === 'function') KinkyDungeonDressPlayer(KinkyDungeonPlayer); } catch (e) {}
			// @ts-ignore
			const armsBoundAfter = (typeof KinkyDungeonIsArmsBound === 'function') ? KinkyDungeonIsArmsBound(false, false) : '<undef>';
			// @ts-ignore
			const hasArmsFullAfter = (typeof KinkyDungeonPlayerTags !== 'undefined' && KinkyDungeonPlayerTags.has) ? KinkyDungeonPlayerTags.has('ItemArmsFull') : '<undef>';
			// @ts-ignore
			const MC = KDCurrentModels.get(KinkyDungeonPlayer);
			return {
				standalonePatched: sp,
				sgGroupsAuto,
				armsBoundBefore, hadArmsFullBefore, armsBoundAfter, hasArmsFullAfter,
				// @ts-ignore
				poses: MC ? Object.keys(MC.Poses || {}).filter((k) => MC.Poses[k]) : ['<no MC>'],
				// @ts-ignore
				models: MC && MC.Models ? Array.from(MC.Models.keys()) : ['<no MC>'],
			};
			/* eslint-enable */
		});

		// eslint-disable-next-line no-console
		console.log('=== VICTIM MODEL-STATE PROBE ===\n' + JSON.stringify({ serverRestraints: serverR, before, after, forced }, null, 2));

		// KD-103 assertions — with the render-client fix (KinkyDungeonUpdateRestraints) the victim's own
		// client must compute the arms-bound state from the worn rope, WITHOUT any manual force:
		expect(after.worn).toContain('StrongMagicRopeArmsBoxtie'); // the tie reached the victim
		// KDM-156: the client rebuilt the struggle groups by ITSELF (no manual call), so the victim
		// can open "worn" and click struggle/remove without hitting an undefined .find() result.
		expect(forced.sgGroupsAuto).toContain('ItemArms');
		expect(before.armsBound).toBe(false);                      // started free
		expect(after.armsBound).toBe(true);                        // now arms-bound (drives the bound pose)
		expect(after.hasArmsFull).toBe(true);                      // ItemArmsFull tag present
		expect(after.poses).toContain('Boxtie');                   // the bound arm pose flag
		expect(after.poses).not.toContain('Free');                 // free-arms pose removed
		expect(after.models).toContain('RopeBoxtie1');             // rope overlay layer present
	} finally {
		await ctxA.close();
		await ctxB.close();
		bridge.close();
		server.close();
		delete process.env.KD_PVP;
	}
});
