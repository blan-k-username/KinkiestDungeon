/**
 * E2E (KDM-286) — a co-op player can actually SEE the rest of the HUD, not only the message log.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────────
 * KDM-285 found that a permanently-armed `KinkyDungeonTargetingSpell` had been hiding TEN things
 * from every co-op player since boot, and fixed it. Only ONE of the ten got a paint-level assertion
 * (`mp-coop-log-visible.spec.ts`). The rest were locked down by asserting the shared GATE was clear
 * — `KinkyDungeonTargetingSpell === null` and `KDDrawResourcesQuick() === true` — and those two are
 * the same assertion written twice, because `KDDrawResourcesQuick` is literally
 * `return !KinkyDungeonTargetingSpell` (`KinkyDungeonHUD.ts:3927`).
 *
 * That is a proxy, and KDM-285's own lesson is that a proxy stays green while the screen is blank:
 * the whole defect survived years of specs asserting `KinkyDungeonMessageLog` CONTENTS. A different
 * future cause — a stray `KDToggles` value, an adopted state frame, an upstream re-gate — would hide
 * the buff icons again with the gate assertion fully green.
 *
 * ── THE ORACLE ────────────────────────────────────────────────────────────────────────────────────
 * `recordDrawnSprites` wraps `KDDraw`, the choke point every sprite path funnels into, so this spec
 * asserts what the co-op player's screen was actually PAINTED with:
 *
 *   buff / debuff icons   `KDDrawBuffIcons` → `stat<N>` ← `Buffs/<icon>.png`  (gated at HUD:396)
 *   quick resources       `KinkyDungeonHUD.ts:1351`     → `gold` ← `Items/Gold.png`
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THE MUTATION. The last phase RE-ARMS the targeting spell — it reproduces KDM-285's defect on
 *     purpose — and requires both sprites to vanish. An assertion that cannot tell the fixed build
 *     from the broken one is not coverage, and this is the only way to show that without hand-editing
 *     the product between two runs.
 *  2. THE SAME-SHAPE CONTROL. Every "was NOT drawn" here is paired with a "was drawn" measured in
 *     the same window: `calls > 0` (KD's own frames are still running through the wrap) and a probe
 *     sprite (the recorder itself still fires). A dead wrap, a stopped page and a genuinely-hidden
 *     icon are three different bugs that all leave the list empty.
 *  3. THE BUFF ICON IS EARNED, not toggled on. Phase 1 asserts `boundBlind` is ABSENT while the
 *     player can see, phase 2 blinds them and requires that exact icon. "Some icon was drawn" would
 *     pass on the stock always-on info icons without the buff pipeline working at all.
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, MP_TEST_TIMEOUT, reportedPageErrors,
	recordDrawnSprites, readDrawnSprites, resetDrawnSprites, restoreDrawnSprites,
	drawProbeSprite, drewSprite,
} from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Keep only the two HUD elements under test, plus this spec's own probe.
 *
 * KDDraw runs for every tile of every frame, so an unfiltered recorder fills its cap with map
 * sprites and truncates before the HUD is reached. The filter decides what is KEPT and never what is
 * COUNTED, so `calls` stays a complete liveness signal (see the helper's doc).
 */
const HUD_SPRITES = '^(stat\\d+|gold|kdm286probe_)';

/** Long enough for several of KD's own draw frames, matching `mp-coop-log-visible`'s window. */
const FRAMES_MS = 2000;

/** One measurement window: forget what was drawn, let KD paint, read it back. */
async function drawWindow(P: any) {
	await resetDrawnSprites(P);
	await P.waitForTimeout(FRAMES_MS);
	return readDrawnSprites(P);
}

const BUFF_ID = /^stat\d+$/;
const BLIND_ICON = /Buffs\/boundBlind\.png$/;
const GOLD_ID = /^gold$/;
const GOLD_IMAGE = /Items\/Gold\.png$/;

test('a co-op client paints its buff icons and its quick resources, and stops when re-gated',
	async ({ browser }) => {
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
			await recordDrawnSprites(B, { match: HUD_SPRITES });

			// ---- PHASE 1 — the quick resources are painted, and the blind icon is NOT -----------
			const probe1 = await drawProbeSprite(B, 'phase1');
			const base = await drawWindow(B);
			// Re-drawn inside the window itself: `drawWindow` resets first, so a probe from before it
			// would have been forgotten. This is the recorder-is-live control for the whole phase.
			const probe1b = await drawProbeSprite(B, 'phase1');
			await B.waitForTimeout(100);
			const baseAfter = await readDrawnSprites(B);
			expect(drewSprite(baseAfter, new RegExp(probe1b.id), new RegExp(probe1.image)),
				'the sprite recorder itself must be firing').toBe(true);

			expect(base.calls,
				"KD's own draw frames must be reaching the wrapped KDDraw — zero here means the page "
				+ 'stopped painting, and every absence below would be meaningless').toBeGreaterThan(0);
			expect(drewSprite(base, GOLD_ID, GOLD_IMAGE),
				'the quick-resource readout must reach the screen. This is the assertion KDM-285 could '
				+ 'not make: `KDDrawResourcesQuick()` is `return !KinkyDungeonTargetingSpell`, so '
				+ `asserting it is asserting the gate twice. Drawn: ${JSON.stringify(base.sprites)}`)
				.toBe(true);
			// The SAME-SHAPE control for phase 2: a player who can see has no blind icon, so phase 2
			// measures a change rather than a state that was already true.
			expect(drewSprite(base, BUFF_ID, BLIND_ICON),
				'a player who is not blinded must not be showing the blind icon').toBe(false);

			// ---- PHASE 2 — blind the co-op player; THAT icon must be painted --------------------
			// A real player condition, not `KDToggleShowAllBuffs`: the toggle paints the stock info
			// icons unconditionally, so "some stat sprite was drawn" would pass with the buff
			// pipeline dead. `KinkyDungeonHUD.ts:2817` turns this state into exactly `boundBlind`.
			await B.evaluate(() => {
				// @ts-ignore bare let-globals
				KinkyDungeonBlindLevel = 5; KinkyDungeonStatBlind = 5;
			});
			const blind = await drawWindow(B);
			expect(drewSprite(blind, BUFF_ID, BLIND_ICON),
				'the buff/debuff icon must be DRAWN, not merely present in the player\'s state — this '
				+ 'is the KDM-285 casualty that had no paint assertion at all. Drawn: '
				+ JSON.stringify(blind.sprites)).toBe(true);
			expect(drewSprite(blind, GOLD_ID, GOLD_IMAGE),
				'and the quick resources are still there').toBe(true);

			// ---- PHASE 3, THE MUTATION — re-arm the gate and require both to vanish -------------
			// KDM-285's defect, reproduced deliberately. Without this the two assertions above would
			// be green on the broken build too, which is exactly how the original bug survived.
			const armed = await B.evaluate(() => {
				// @ts-ignore bare let-globals — the same spell `ensureQuickBind()` used to leave armed
				KinkyDungeonTargetingSpell = KDBondageSpell;
				// @ts-ignore
				return !!KinkyDungeonTargetingSpell;
			});
			expect(armed, 'the mutation has to actually take, or phase 3 asserts nothing').toBe(true);

			const regated = await drawWindow(B);
			const probe3 = await drawProbeSprite(B, 'phase3');
			await B.waitForTimeout(100);
			const regatedAfter = await readDrawnSprites(B);

			// The two controls FIRST, so a failure below can never be read as "the page died".
			expect(regated.calls,
				'KD must still be painting while targeting — if it is not, the absences below are '
				+ 'about a dead page, not about the gate').toBeGreaterThan(0);
			expect(drewSprite(regatedAfter, new RegExp(probe3.id), new RegExp(probe3.image)),
				'and the recorder is still live in this window').toBe(true);

			expect(drewSprite(regated, BUFF_ID, BLIND_ICON),
				'with a targeting spell armed KD suppresses the buff icons (HUD:396) — if this is '
				+ 'still drawn, the assertion in phase 2 is not measuring the gate at all')
				.toBe(false);
			expect(drewSprite(regated, GOLD_ID, GOLD_IMAGE),
				'and the quick resources too (HUD:1351 via KDDrawResourcesQuick)').toBe(false);

			// Put the client back the way the product leaves it, so the invariants below are checked
			// against a page in its real state rather than one this spec broke.
			await B.evaluate(() => {
				// @ts-ignore bare let-globals
				KinkyDungeonTargetingSpell = null; KinkyDungeonBlindLevel = 0; KinkyDungeonStatBlind = 0;
			});
			await restoreDrawnSprites(B).catch(() => {});

			// ---- PHASE 4 — the MOVE HELPER, KDM-285's third un-asserted casualty ----------------
			// ⚠️ NOT a paint, and no sprite recorder can see it. `KDToggles.Helper` reaches the game
			// as the argument of `KinkyDungeonSetTargetLocation(!KinkyDungeonTargetingSpell &&
			// KDToggles.Helper)` (`KinkyDungeonHUD.ts:276`), where it snaps the aim OFF a wall onto a
			// walkable neighbour. Nothing is drawn differently; the player simply stops missing the
			// tile they aimed at. So the oracle is the target coordinate, and the co-op relevance is
			// the same as everywhere else in this file: the helper is ANDed with the very gate a
			// co-op client used to leave permanently armed, so it was silently off for co-op players
			// only, on an otherwise stock build.
			//
			// Driven through `KinkyDungeonHandleHUD()`, KD's own input entry point, rather than by
			// calling `KinkyDungeonSetTargetLocation` directly — the gate expression lives at the
			// CALL SITE, so a direct call would assert the helper's arithmetic while stepping over
			// the only thing this spec is about.
			const aim = await B.evaluate(() => {
				// @ts-ignore bare let-globals
				const G = KinkyDungeonGridSizeDisplay;
				/** Put the mouse over tile (tx,ty), offset by `r` grid-cells toward +X. */
				const pointAt = (tx: number, ty: number, r: number) => {
					// The inverse of `KinkyDungeonSetTargetLocation`'s own arithmetic
					// (`KinkyDungeonDraw.ts:3001`): target = round((m - G/2 - offset)/G) + Cam.
					// @ts-ignore
					MouseX = ((tx - KinkyDungeonCamX) + r) * G + G / 2 + canvasOffsetX;
					// @ts-ignore
					MouseY = ((ty - KinkyDungeonCamY) + 0) * G + G / 2 + canvasOffsetY;
				};
				// @ts-ignore
				const isWall = (x: number, y: number) => KinkyDungeonWallTiles.includes(KinkyDungeonMapGet(x, y));
				// A wall with a walkable neighbour to its RIGHT, near the player so it is on screen
				// and inside the canvas rect `KDHandleGame` gates on.
				// @ts-ignore
				const p = KinkyDungeonPlayerEntity;
				let wall: { x: number; y: number } | null = null;
				for (let d = 1; d <= 12 && !wall; d++) {
					for (let dx = -d; dx <= d && !wall; dx++) {
						for (let dy = -d; dy <= d && !wall; dy++) {
							const x = p.x + dx; const y = p.y + dy;
							// The helper deliberately refuses to snap off a wall that IS something
							// (a door, a chest); `KinkyDungeonSetTargetLocation` checks the same.
							// @ts-ignore
							if (isWall(x, y) && !(KinkyDungeonTilesGet(x + ',' + y)?.Type) && !isWall(x + 1, y)) {
								wall = { x, y };
							}
						}
					}
				}
				if (!wall) return { found: false } as any;

				// Nothing else may swallow the input before line 276.
				// @ts-ignore
				KinkyDungeonShowInventory = false; KinkyDungeonMessageToggle = false;
				// @ts-ignore
				KDToggles.Helper = true;

				const read = () => {
					// @ts-ignore
					pointAt(wall.x, wall.y, 0.3);   // 0.3 > the helper's own 0.1 aimThresh
					// @ts-ignore
					KinkyDungeonHandleHUD();
					// @ts-ignore
					return { x: KinkyDungeonTargetX, y: KinkyDungeonTargetY };
				};

				// @ts-ignore
				KinkyDungeonTargetingSpell = null;
				const helped = read();
				// THE CONTROL — KDM-285's defect again, on the same tile, in the same call.
				// @ts-ignore
				KinkyDungeonTargetingSpell = KDBondageSpell;
				const gated = read();
				// @ts-ignore
				KinkyDungeonTargetingSpell = null;

				return { found: true, wall, helped, gated };
			});

			expect(aim.found,
				'no wall with a walkable neighbour within 12 tiles of the player — the map fixture '
				+ 'cannot exercise the helper, so this phase would assert nothing').toBe(true);
			expect(aim.helped,
				`aiming just off the wall at ${JSON.stringify(aim.wall)} must SNAP onto the walkable `
				+ 'neighbour. This is the move helper, and a co-op client had it silently disabled '
				+ 'for the whole session before KDM-285 — with every gate assertion green.')
				.toEqual({ x: aim.wall.x + 1, y: aim.wall.y });
			expect(aim.gated,
				'and with the targeting spell re-armed it must NOT snap — the same mutation the '
				+ 'sprite phases use, so "the helper works" cannot pass on a build where the gate is '
				+ 'ignored entirely').toEqual({ x: aim.wall.x, y: aim.wall.y });

			// ---- invariants required of every e2e in this project --------------------------------
			for (const [label, errs] of [['A', errsA], ['B', errsB]] as const) {
				const { real, ignored } = reportedPageErrors(errs);
				expect(real, `${label} page errors (ignored known noise: ${ignored.join(', ')})`)
					.toEqual([]);
			}
		} finally {
			await ctxA.close(); await ctxB.close();
			await new Promise<void>((r) => server.close(() => r()));
			if (bridge && bridge.close) bridge.close();
		}
	});
