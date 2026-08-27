/**
 * E2E (KDM-257) — the co-op lobby SHOWS the host's mods, and names what is missing.
 *
 * [[KDM-249]] shipped the whole mod-sync mechanism AND all of its data — `modDiff` rides both
 * approval messages and `__coopMods.state()` carries `status`/`missing` — but nothing rendered any
 * of it. Its R5 ("the guest SHALL be shown, in words, which mods the host is loading and which of
 * them it is missing — BEFORE it commits") and R9 ("a degraded sync SHALL be visible, not
 * mysterious") were satisfied only in the sense that the information existed. A player never saw it.
 *
 * ── WHY THE ORACLE IS `DrawTextKD`, NOT LOBBY STATE ───────────────────────────────────────────────
 * The lobby paints to a canvas; there is no DOM node to assert on, and `lobbyState` exposes only
 * view/pending/error/status. Asserting that `lobby.modDiff` holds the right value would prove the
 * data ARRIVED, which is precisely what KDM-249 already proves and precisely what this task is NOT
 * about. `paintedText()` records what actually reached the screen for one frame, so the assertion is
 * about the thing that was missing.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. THE SILENT CASE IS A CONTROL, run through the same flow on the same server. "It painted the
 *     mod name" and "it paints something always" are the same green without it — and R4 says a clean
 *     sync must say NOTHING, so the control is also a requirement in its own right.
 *  2. BOTH SIDES ARE ASSERTED. The guest's screen and the host's prompt render the same list from
 *     opposite ends; checking one would let the other stay blank.
 *  3. THE MOD NAME IS THE ASSERTION — a real mod, installed through KD's own `KDLoadMod` after page
 *     load — not a count or a truthy banner, so a renderer that says "1 mod" without naming it fails.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, guestAsks, installModZip, paintedText, paintedBy } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);
const MODNAME = 'Kdm257HostMod';
const MARKER = '__kdm257HostModRan';

/** Every string painted this frame, joined — the screen as one searchable blob. */
const screenText = async (page: any) => (await paintedText(page)).join(' │ ');

test.describe('KDM-257 — the lobby names the host\'s mods', () => {
	test('R1/R2 — a host-only mod is named on BOTH screens before anyone commits', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openLobby(host, port);
			// After page load — the real order of events (Mods menu, then host).
			await installModZip(host, MODNAME, MARKER);
			await press(host, 'KDMPHost');

			await guestAsks(guest, port, 'Nyx');
			// Both sides are parked on the approval handshake and neither has committed to anything,
			// which is the whole point of R1. WAIT ON WHAT EXISTS TODAY — `status` and `pending` are
			// KDM-233's own fields. Waiting on `modDiff` (the field this task ADDS) would make the
			// pre-implementation run hang for the full timeout instead of failing its assertion, and
			// a tests-first red that costs ten minutes teaches nothing.
			await guest.waitForFunction(
				() => /waiting/i.test(String((window as any).KDMPLobby.status || '')),
				undefined, { polling: 'raf' });
			await host.waitForFunction(() => !!(window as any).KDMPLobby.pending, undefined, { polling: 'raf' });

			expect(await screenText(guest), 'R1 — the guest is told what it will load, by name')
				.toContain(MODNAME);
			expect(await screenText(host), 'R2 — the host is not agreeing blind')
				.toContain(MODNAME);
		} finally {
			await hostCtx.close(); await guestCtx.close();
			await new Promise((r) => server.close(r));
		}
	});

	test('R4 — with nothing to sync, neither screen says anything about mods', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			// THE CONTROL: the identical flow, with no mod installed anywhere.
			await openLobby(host, port);
			await press(host, 'KDMPHost');
			await guestAsks(guest, port, 'Nyx');
			await host.waitForFunction(() => !!(window as any).KDMPLobby.pending, undefined, { polling: 'raf' });

			/*
			 * `mod` as a WHOLE WORD catches every wording a renderer might use — "1 mod", "mods you
			 * don't have", "Mods:" — so this fails for a banner that appears with an empty list, not
			 * merely for one that names a mod that isn't there. Verified against the four lead strings
			 * in `coop-lobby.js`: all of them say "mod" or "mods" as a word.
			 *
			 * ⚠️ IT WAS `.not.toContain('mod')`, AND THAT WAS OVER-BROAD. A bare substring also
			 * matches the ordinary English word "mode", so this control failed the moment KDM-283 made
			 * the WORLD banner (a different feature entirely) paint "Progression Mode: Key Hunt".
			 * Nothing about mods had changed. A control that fires on an unrelated feature's wording
			 * is not protecting this requirement, it is only reporting that the screen changed.
			 */
			const NO_MODS = /\bmods?\b/;
			expect((await screenText(guest)).toLowerCase(), 'silence is the correct output')
				.not.toMatch(NO_MODS);
			expect((await screenText(host)).toLowerCase(), 'and on the host\'s prompt too')
				.not.toMatch(NO_MODS);
		} finally {
			await hostCtx.close(); await guestCtx.close();
			await new Promise((r) => server.close(r));
		}
	});

	/**
	 * R3/R4 — the degraded notice.
	 *
	 * ⚠️ WHY THIS ONE CALLS THE RENDERER DIRECTLY, and what that does NOT prove.
	 *
	 * KD's in-game draw throws in the headless harness — `Cannot set properties of null (setting
	 * 'fillStyle')`, a canvas context that does not exist here — and the throw kills the PIXI ticker.
	 * MEASURED, with a counter inside the lobby's own wrap, on a REAL started two-player session:
	 * `KinkyDungeonRun` runs 388 frames and then exactly zero, from the frame `KinkyDungeonState`
	 * becomes `'Game'`; identical on the host and the guest. So no e2e in this repo can currently
	 * observe anything painted in-game, and a frame-driven assertion here would be measuring the
	 * harness, not the feature.
	 *
	 * What this test therefore proves: the notice RENDERS the right thing for the right state, and is
	 * silent otherwise. What it does NOT prove: that the wrap's `Game` branch reaches it during real
	 * play. That gap is real, is written down in KDM-257, and has a follow-up task — it is not
	 * papered over here.
	 */
	test('R3/R4 — the notice names a degraded sync and is silent for a clean one', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port);

			// The notice re-reads live state on every call — persistent by construction, no latch and
			// no timer — so driving `__coopMods.state()` IS driving its real input.
			const withStatus = async (status: string, missing: any[]) => {
				await page.evaluate((a: any) => {
					(window as any).__coopMods.state = () => ({
						status: a.status, latched: true, count: 0,
						declaration: [], fetched: [], missing: a.missing, error: '',
					});
				}, { status, missing });
				return (await paintedBy(page, 'drawModWarning')).join(' │ ');
			};

			expect(await withStatus('degraded', [{ modname: MODNAME }]),
				'R3 — a degraded sync names what is missing').toContain(MODNAME);

			// The control, on the same page through the same call: an implementation that always
			// paints passes the assertion above and fails this one.
			expect((await withStatus('executed', [])).toLowerCase(),
				'R4 — a clean sync is silent').not.toContain('mod');
			expect((await withStatus('nothing-to-do', [])).toLowerCase(),
				'R4 — and so is a session with nothing to sync').not.toContain('mod');
		} finally {
			await ctx.close();
			await new Promise((r) => server.close(r));
		}
	});
});
