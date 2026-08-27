/**
 * E2E (KDM-239 R4) — the guest is told what WORLD it is joining, before it commits.
 *
 * R3 makes the host's game-mode choices govern the shared world. R4 is the half that makes that
 * honest: a guest agreeing to join a run on the host's terms has to be able to SEE those terms while
 * it can still walk away. The wire half is unit-tested (`mp-start-ritual.spec.ts` — the gate puts the
 * host's world on the pending reply); this asserts the half a unit test cannot, which is that it
 * reaches a screen.
 *
 * ── WHY THE ORACLE IS `DrawTextKD`, NOT LOBBY STATE ───────────────────────────────────────────────
 * Same reasoning as `mp-lobby-mod-notice.spec.ts`, and for the same reason: asserting
 * `KDMPLobby.world` holds the right value would prove the data ARRIVED, which the unit layer already
 * proves. The bug this guards against is data arriving and nothing rendering it — exactly the state
 * KDM-249 was in before KDM-257. `paintedText()` records what actually reached the screen.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THE SILENT CASE IS A CONTROL, run through the same flow on the same server. Without it,
 *     "it painted the mode" and "it paints a banner always" are the same green — and a host on KD's
 *     defaults painting nothing is a REQUIREMENT (drawWorldSummary returns 0), not just tidiness.
 *  2. THE ASSERTION IS THE HOST'S ACTUAL CHOICE, set on the host page before it hosts, not a count
 *     or a truthy banner. A renderer that says "1 setting" without naming it fails.
 *  3. The two cases differ ONLY in that one assignment, so a green pair isolates it.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, guestAsks, paintedText } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** Every string painted this frame, joined — the screen as one searchable blob. */
const screenText = async (page: any) => (await paintedText(page)).join(' │ ');

/**
 * Turn on a world-level mode on the HOST page, the way a player would have on KD's own Diff screen.
 *
 * ⚠️ BARE ASSIGNMENT, deliberately. `KinkyDungeonHardMode` is a bundle-scope `let`, so it is NOT a
 * property of `window` — `(window as any).KinkyDungeonHardMode = true` would create a shadow that
 * `worldModes()` never reads. The bundle's global lexical scope IS on the scope chain inside
 * `evaluate`, which is the same mechanism `coop-mods.js` relies on to set `KDGetMods`.
 */
async function hostChoosesHardMode(page: any) {
	await page.evaluate(() => {
		// eslint-disable-next-line no-undef
		(0, eval)('KinkyDungeonHardMode = true');
	});
}

test.describe('KDM-239 R4 — the lobby names the host\'s world', () => {
	test('a world-level mode the host chose is named on the guest\'s screen before it commits', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			// Chosen BEFORE hosting — `worldModes()` is read when the join handshake is sent.
			await hostChoosesHardMode(host);
			await press(host, 'KDMPHost');

			await guestAsks(guest, port, 'Nyx');
			// Park on the approval handshake: neither side has committed, which is R4's whole window.
			// Waiting on `status` (a KDM-233 field that exists either way) rather than on `world` — a
			// wait on the field this task ADDS would make a pre-implementation run hang for the full
			// timeout instead of failing its assertion.
			await guest.waitForFunction(
				() => /waiting/i.test(String((window as any).KDMPLobby.status || '')),
				undefined, { polling: 'raf' });

			const text = (await screenText(guest)).toLowerCase();
			// `hard` covers both renderings: KD's own text key for the setting, and the raw
			// `hardMode` key we fall back to when KD has no name for it.
			expect(text, 'R4 — the guest can see the terms of the run it is joining').toContain('hard');
		} finally {
			await hostCtx.close(); await guestCtx.close();
			await new Promise((r) => server.close(r));
		}
	});

	test('CONTROL — a host on KD\'s defaults says nothing about the world at all', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			// THE CONTROL: the identical flow, minus the one assignment.
			await openLobby(host, port);
			await press(host, 'KDMPHost');
			await guestAsks(guest, port, 'Nyx');
			await guest.waitForFunction(
				() => /waiting/i.test(String((window as any).KDMPLobby.status || '')),
				undefined, { polling: 'raf' });

			const text = (await screenText(guest)).toLowerCase();
			/*
			 * ⚠️ THIS ASSERTION WAS REWRITTEN BY KDM-259, AND THE OLD ONE WAS VACUOUS.
			 *
			 * It used to read `.not.toContain("the host's game")` — "a default world paints no banner
			 * at all". That was green for the wrong reason: the lead line was painting
			 * `"[NotFound] KDMPWorldLead"`, because `coop-lobby.js`'s `text()` mistook KD's
			 * missing-key MARKER for a translation (fixed under KDM-259, pinned in
			 * `mp-lobby-seed.spec.ts`). With the marker gone the real lead line appears and the old
			 * assertion fails.
			 *
			 * It fails because it was never reachable. `KinkyDungeonProgressionMode` defaults to
			 * `"Key"` (`KinkyDungeon.ts:1382`) and `MODE_SOURCE` maps exactly that value to
			 * `escapekey`, so `worldModes()` ALWAYS returns at least one key and a host on KD's
			 * defaults always has something to declare. "Defaults ⇒ silence" is not a state this
			 * product can be in.
			 *
			 * So the control is re-aimed at what it was actually protecting: the banner must name the
			 * host's OWN choices and nothing else. The one assignment that separates this test from
			 * its sibling is `hardMode`, and its absence here is what a banner inventing settings —
			 * or echoing the other test's — would fail on.
			 *
			 * Whether naming KD's default escape rule to a guest as the raw key `escapekey` is the
			 * right thing to SHOW is a product question this spec deliberately does not settle; it is
			 * filed as its own task rather than decided inside a control.
			 */
			expect(text, 'a mode the host never chose is never named')
				.not.toContain('hard');
		} finally {
			await hostCtx.close(); await guestCtx.close();
			await new Promise((r) => server.close(r));
		}
	});
});
