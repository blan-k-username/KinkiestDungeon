/**
 * E2E (KDM-272) — co-op's divergences are stated ONCE, in our own lobby, before the player makes
 * any of the declarations they diverge from.
 *
 * ── WHY THE BRIEFING IS AT `lobby.open()` AND NOT "AFTER APPROVAL" ────────────────────────────────
 * The task was drafted against a flow of lobby → host/join → character → perks → run, and asked for
 * the briefing between approval and character creation. That is not the flow that shipped: **Perks**
 * (`coop-lobby.js`, `KDMPPerks`) and **Character** (`KDMPChar`) are buttons on the lobby ROOT, drawn
 * beside Host and Join, because the host connects straight from that view and anything riding the
 * handshake has to be pickable first. So there is no post-approval moment that is upstream of the
 * perk screen, and the only placement satisfying AC1 is the moment the lobby is opened.
 *
 * That is what the first test pins, and it pins it in the way that would actually catch a mistake:
 * not "the briefing appeared" but "the briefing appeared **and the Perks button did not**". A
 * briefing painted as an overlay on the root — the obvious wrong implementation, and the one that
 * would let a player press Perks straight through it — passes the first half and fails the second.
 *
 * ── WHY THESE GREENS ARE NOT VACUOUS ──────────────────────────────────────────────────────────────
 *  1. **"Once" is tested against its own control.** Reopening in the SAME browser context must give
 *     the root; a FRESH context in the same test must still give the briefing. One assertion says
 *     the flag is remembered, the other says it is not remembered *globally* — an implementation
 *     that simply never shows the briefing twice per process passes the first and fails the second.
 *  2. **The oracle is the paint, not a getter.** `paintedText` wraps `DrawTextKD` for a real frame,
 *     so what is asserted is what reached the screen. A view that sets `lobby.view = 'about'` and
 *     draws nothing fails.
 *  3. **The storage-disabled case is driven by actually breaking storage**, not by a flag, and it
 *     asserts BOTH halves of AC3: the briefing still shows every time, and nothing throws.
 *  4. **AC5/AC6 are asserted over the painted strings themselves** — no digit may appear in the
 *     briefing (rules, not gameplay values) and no line may carry KD's `[NotFound]` marker, which is
 *     the failure mode `kd-peace-dialogue.js` records this client as having shipped twice.
 *
 * AC4 (single-player unchanged) needs no test here: every line of this feature lives in
 * `coop-lobby.js`, which only the co-op server injects, and the perk screen's stock/co-op branch is
 * already pinned by `mp-lobby-perks.spec.ts`.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState, paintedText } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** The button set on screen right now — the same cache KD's own click dispatch iterates. */
const buttonNames = (page: any) => page.evaluate(() => Object.keys(KDButtonsCache));

/**
 * The briefing's own lines, picked out of everything painted this frame.
 *
 * Keyed on the English source strings rather than on a count, so a test failure names the line that
 * went missing instead of saying "expected 6, got 5".
 */
const BRIEFING = [
	'party',        // start perks are the party's
	'host',         // the host's settings and seed govern the run
	'descend',      // you descend together
	'Drop',         // drop an item to hand it over
	'peace',        // PvP resets at the hub
	'rejoin',       // a dropped connection does not end the run
];

function assertBriefingPainted(seen: string[]) {
	const blob = seen.join('\n');
	for (const needle of BRIEFING) {
		expect(blob.toLowerCase(), `the briefing must state the "${needle}" rule`)
			.toContain(needle.toLowerCase());
	}
}

test.describe('KDM-272 — how co-op differs, said once, before the run', () => {

	test('a first-ever lobby open lands on the briefing, upstream of every declaration (AC1)',
		async ({ browser }) => {
			test.setTimeout(MP_TEST_TIMEOUT);
			const { server, bridge, port } = await start(0);
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			try {
				await openLobby(page, port, '127.0.0.1', { briefing: true });

				expect((await lobbyState(page)).view, 'a player who has never seen it starts on it')
					.toBe('about');

				const seen = await paintedText(page);
				assertBriefingPainted(seen);

				// THE CONTROL. An overlay on the root would paint the same words and still let the
				// player press straight through to the perk grid.
				const names = await buttonNames(page);
				expect(names, 'the briefing REPLACES the root — it is not painted over it')
					.not.toContain('KDMPPerks');
				expect(names, 'and neither is the character pick reachable through it')
					.not.toContain('KDMPChar');

				// AC5 — rules, not values. A gameplay constant would show up as a digit.
				const briefingLines = seen.filter((s) => BRIEFING.some(
					(n) => s.toLowerCase().includes(n.toLowerCase())));
				for (const line of briefingLines) {
					expect(line, 'the briefing states rules, never numbers').not.toMatch(/[0-9]/);
				}
				// AC6 — every string went through `text()`, so none can be KD's miss marker.
				for (const line of seen) expect(line).not.toContain('[NotFound]');

				// Back returns to the root, where the declarations live.
				await press(page, 'KDMPBack');
				expect((await lobbyState(page)).view).toBe('menu');
				expect(await buttonNames(page), 'and the root is intact behind it')
					.toContain('KDMPPerks');
			} finally {
				await ctx.close().catch(() => {});
				try { bridge.close(); } catch (e) { /* ignore */ }
				await new Promise((r) => server.close(r));
			}
		});

	test('once means once — it survives a reload, and only for THIS player (AC3)',
		async ({ browser }) => {
			test.setTimeout(MP_TEST_TIMEOUT);
			const { server, bridge, port } = await start(0);
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			const other = await browser.newContext();
			const otherPage = await other.newPage();
			try {
				await openLobby(page, port, '127.0.0.1', { briefing: true });
				expect((await lobbyState(page)).view, 'first open').toBe('about');

				// A full page load, not a view change: the flag has to outlive the tab's memory.
				await openLobby(page, port, '127.0.0.1', { briefing: true });
				expect((await lobbyState(page)).view, 'second open, same browser ⇒ straight to the root')
					.toBe('menu');

				// THE CONTROL — a different browser is a different player, and has been told nothing.
				await openLobby(otherPage, port, '127.0.0.1', { briefing: true });
				expect((await lobbyState(otherPage)).view,
					'"once" is per-player, not once per server or once per process')
					.toBe('about');
			} finally {
				await ctx.close().catch(() => {});
				await other.close().catch(() => {});
				try { bridge.close(); } catch (e) { /* ignore */ }
				await new Promise((r) => server.close(r));
			}
		});

	test('it is reachable again on demand from the lobby root (AC2)', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		try {
			await openLobby(page, port, '127.0.0.1', { briefing: true });
			await press(page, 'KDMPBack');            // dismiss the automatic showing
			expect((await lobbyState(page)).view).toBe('menu');

			expect(await buttonNames(page), 'the root offers the way back in')
				.toContain('KDMPAbout');
			await press(page, 'KDMPAbout');

			expect((await lobbyState(page)).view).toBe('about');
			assertBriefingPainted(await paintedText(page));

			await press(page, 'KDMPBack');
			expect((await lobbyState(page)).view, 'and out again').toBe('menu');
		} finally {
			await ctx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('a browser with storage disabled sees it every time, and never crashes (AC3)',
		async ({ browser }) => {
			test.setTimeout(MP_TEST_TIMEOUT);
			const { server, bridge, port } = await start(0);
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			const crashes: string[] = [];
			page.on('pageerror', (e: any) => crashes.push(String(e && e.message || e)));
			try {
				// Break storage for OUR namespace only. KD's own boot reads `KDToggles` out of
				// localStorage (`KinkyDungeon.ts:1003`) and the harness seeds it, so replacing the
				// whole accessor would fail this test in the bundle rather than in the guard under
				// test. Throwing on the `kdcoop.` prefix is the same thing our code sees from a
				// locked-down browser, isolated to the code that has to survive it.
				await page.addInitScript(() => {
					const s = window.localStorage;
					const get = s.getItem.bind(s), set = s.setItem.bind(s);
					const boom = (k: string) => { throw new Error('storage disabled: ' + k); };
					s.getItem = (k: string) => (String(k).indexOf('kdcoop.') === 0 ? boom(k) : get(k));
					s.setItem = (k: string, v: string) => (String(k).indexOf('kdcoop.') === 0 ? boom(k) : set(k, v));
				});

				await openLobby(page, port, '127.0.0.1', { briefing: true });
				expect((await lobbyState(page)).view,
					'no storage ⇒ nothing was remembered ⇒ show it again').toBe('about');
				await openLobby(page, port, '127.0.0.1', { briefing: true });
				expect((await lobbyState(page)).view, 'and again, rather than crashing').toBe('about');

				assertBriefingPainted(await paintedText(page));
				expect(crashes.filter((m) => /storage disabled/.test(m)),
					'our reads and writes are both guarded — the throw must not escape').toEqual([]);
			} finally {
				await ctx.close().catch(() => {});
				try { bridge.close(); } catch (e) { /* ignore */ }
				await new Promise((r) => server.close(r));
			}
		});
});
