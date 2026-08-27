/**
 * E2E (KDM-285) — a co-op player can actually SEE the game's message log.
 *
 * ⚠️ READ THIS BEFORE "SIMPLIFYING" THE FIX. The defect this locks down was reported as
 * "`KinkyDungeonDrawMessages` is gated on `KinkyDungeonDrawState == 'Game'` and
 * `KinkyDungeonIsPlayer()`, and a render client satisfies neither". That reading was WRONG, and it
 * was disproved by measurement, not by argument — a probe on both co-op pages reported
 * `{drawState: "Game", isPlayer: true, drawInterface: 8, afterDrawFrame: 8}`. The whole block runs
 * every frame; `KinkyDungeonIsPlayer()` is `return true` unconditionally
 * (`Game/src/base/KinkyDungeon.ts:1358`).
 *
 * The real cause was OURS: `coop-bootstrap.js` → `ensureQuickBind()` (KD-101) pre-selects a binding
 * material through stock `KinkyDungeonAttemptQuickRestraint`, which also arms
 * `KinkyDungeonTargetingSpell = KDBondageSpell` — and nothing in a non-simulating client ever clears
 * it. So every co-op client has been sitting in permanent spell-targeting mode since boot, and stock
 * KD deliberately suppresses a long list of HUD while you aim (`KinkyDungeonDraw.ts:1934`,
 * `KinkyDungeonHUD.ts:395/3927`, …). The log was merely the casualty somebody noticed.
 *
 * This spec asserts the CAUSE (nothing is armed) and the EFFECT (KD itself paints the log), because
 * either alone can go green for the wrong reason: chat used to paint the log by hand, which made the
 * effect true while the cause stayed broken.
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, MP_TEST_TIMEOUT, reportedPageErrors,
	recordDrawnText, readDrawnText, restoreDrawnText, paintMissingTextKey,
} from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/** Everything a stuck targeting spell would have changed, read in one hop. */
async function targetingState(P: any) {
	return P.evaluate(() => ({
		// @ts-ignore bare let-global
		spell: (KinkyDungeonTargetingSpell && KinkyDungeonTargetingSpell.name) || null,
		// CONTROL — KD-101's material pre-selection must SURVIVE the fix. Without this, deleting
		// `ensureQuickBind()` outright would make `spell === null` pass while breaking "Tie Up".
		// @ts-ignore
		item: !!KinkyDungeonTargetingSpellItem,
		// @ts-ignore — two of the audited casualties, as booleans KD itself computes
		resourcesQuick: (typeof KDDrawResourcesQuick === 'function') ? KDDrawResourcesQuick() : null,
	}));
}

/** Count KD's OWN calls to the log draw, in the page's realm, on the binding KD calls. */
async function countGameLogDraws(P: any) {
	await P.evaluate(() => {
		const w = window as any;
		if (w.__kdLogDraws) return;
		w.__kdLogDraws = { n: 0 };
		// @ts-ignore bare let-global
		const original = KinkyDungeonDrawMessages;
		// @ts-ignore
		KinkyDungeonDrawMessages = function () {
			w.__kdLogDraws.n++;
			// eslint-disable-next-line prefer-rest-params
			return original.apply(this, arguments as any);
		};
	});
}

test('a co-op client is not stuck targeting, so KD paints its own message log', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();
	const errsA: string[] = []; const errsB: string[] = [];
	A.on('pageerror', (e) => errsA.push(String(e && e.message ? e.message : e)));
	B.on('pageerror', (e) => errsB.push(String(e && e.message ? e.message : e)));

	try {
		await bootCoopPair(A, B, port);

		// ---- R1, the CAUSE — neither client boots into spell-targeting mode --------------------
		for (const [label, P] of [['A', A], ['B', B]] as const) {
			const t = await targetingState(P);
			expect(t.spell,
				`${label} must not boot with a targeting spell armed — a co-op client never clears one, `
				+ 'so anything KD hides while aiming stays hidden for the whole session '
				+ '(log, buff icons, quick resources, the move helper)').toBe(null);
			expect(t.item,
				`${label}: KD-101's binding-material pre-selection must still be in place — this is the `
				+ 'control that separates "we stopped arming the spell" from "we deleted the feature"')
				.toBe(true);
			expect(t.resourcesQuick, `${label}: KD's own quick-resource predicate`).toBe(true);
		}

		// ---- R2, the EFFECT — KD's own draw pass calls the log draw, once per frame ------------
		await countGameLogDraws(B);
		await recordDrawnText(B);
		const before = await B.evaluate(() => (window as any).__kdLogDraws.n);

		// A message with a text this session can have produced no other way, pushed through KD's own
		// sender so it lands in the log exactly the way a combat or item line does.
		const MARK = 'KDM285-log-visible-marker';
		await B.evaluate((mark: string) => {
			// @ts-ignore bare let-global
			KinkyDungeonSendTextMessage(10, mark, '#ffffff', 9999);
		}, MARK);
		await B.waitForTimeout(2000);

		const drew = (await B.evaluate(() => (window as any).__kdLogDraws.n)) - before;
		expect(drew,
			'KD must call KinkyDungeonDrawMessages itself every frame. Zero here with the marker still '
			+ 'in KinkyDungeonMessageLog is exactly the KDM-285 defect: correct on the wire, invisible '
			+ 'on screen.').toBeGreaterThan(0);

		// ---- R4 — a PAINT assertion, because a data one passed throughout the whole defect -----
		const painted = await readDrawnText(B);
		expect(painted.texts.some((t) => t.indexOf(MARK) >= 0),
			`the log line must reach the screen (truncated=${painted.truncated}, `
			+ `texts=${JSON.stringify(painted.texts.slice(0, 15))})`).toBe(true);
		// CONTROL: prove the recorder is live rather than trusting a green from a dead wrap.
		const control = await paintMissingTextKey(B, 'KDM285Control');
		const after = await readDrawnText(B);
		expect(after.texts.some((t) => t.indexOf(control) >= 0),
			'the painted-text recorder itself must be firing').toBe(true);

		// ---- invariants required of every e2e in this project ----------------------------------
		expect(after.unresolved.filter((t) => t.indexOf('KDM285Control') < 0),
			'no unresolved text keys').toEqual([]);
		for (const [label, errs] of [['A', errsA], ['B', errsB]] as const) {
			const { real, ignored } = reportedPageErrors(errs);
			expect(real, `${label} page errors (ignored known noise: ${ignored.join(', ')})`).toEqual([]);
		}
		await restoreDrawnText(B).catch(() => {});
	} finally {
		await ctxA.close(); await ctxB.close();
		await new Promise<void>((r) => server.close(() => r()));
		if (bridge && bridge.close) bridge.close();
	}
});
