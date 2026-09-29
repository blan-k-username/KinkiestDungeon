/**
 * E2E (KDM-294) — host the run you are ALREADY PLAYING, from KD's own in-game menu.
 *
 * The owner's brief: "let the Host start the game as usual SP, no difference". So a player who began
 * solo, and played, opens KD's in-game menu (`KinkyDungeonDrawState === 'Restart'`) and presses one
 * entry of ours — "Host this game" — and a friend can join THAT run.
 *
 * ── WHY THESE ASSERTIONS AND NOT OTHERS ───────────────────────────────────────────────────────────
 *  1. #2 and #3 are a PAIR, and #3 is the one that matters. On the class screen every stock control is
 *     a cache button, so a geometry check was enough (KDM-293 #11). The in-game menu is different:
 *     Save & Quit, Capture and Check Perks are hand-rolled `MouseIn` hit-tests
 *     (`KinkyDungeonHUD.ts`, Restart branch) that no `KDButtonsCache` read can see — and
 *     `KDProcessButtons()` runs before them and returns on a hit (`KinkyDungeon.ts:6421`). So #3
 *     clicks REAL coordinates through KD's own dispatch and requires each stock control to still win
 *     its own pixels, with a positive control (our centre DOES open ours) so the negatives are not
 *     vacuous.
 *  2. #4 asserts on what is DECLARED, at the moment of declaring — the save handed to the transport —
 *     and plants its marker AFTER KD's last autosave. A host that sent `localStorage.KinkyDungeonSave`
 *     (up to one autosave stale) instead of the run as it is now fails it.
 *  3. #8 is the end-to-end claim: the guest arrives in THAT game. The guest is the control in the
 *     same session, as in `mp-save-import`.
 *
 * ⚠️ FAILS UNTIL KDM-294 IS IMPLEMENTED. Written first, per the project's Rule 1.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import {
	press, settle, lobbyState, openGameMenu, onGameMenu, clashes, clickAt, guestJoinsAndIsAccepted, goldOf,
	recordConnects, connects, type Rect,
} from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);
const ENTRY = 'KDMPHostRun';

/**
 * The in-game menu's hand-rolled `MouseIn` controls — mirrored from the `Restart` branch of
 * `KinkyDungeonHandleHUD` (`Game/src/base/game/KinkyDungeonHUD.ts`) because they are not data KD
 * exposes. `TestMode`-only debug controls are left out: a player never sees them.
 */
const STOCK_MOUSE_IN: Rect[] = [
	{ name: 'SaveAndQuit', x: 975, y: 650, w: 550, h: 64 },
	{ name: 'Capture', x: 975, y: 800, w: 550, h: 64 },
	{ name: 'CheckPerks', x: 1650, y: 900, w: 300, h: 64 },
];

const centre = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the page is, as the two globals that decide it. */
const where = (page: any) => page.evaluate(() => ({
	// @ts-ignore — bundle `let` globals, readable by bare name.
	state: KinkyDungeonState, draw: KinkyDungeonDrawState,
}));

/** Our entry's own rectangle, read from the cache — so #3 clicks where it really is. */
const entryRect = (page: any) => page.evaluate((n: string) => {
	// @ts-ignore
	const b = KDButtonsCache[n];
	return b ? { x: b.Left, y: b.Top, w: b.Width, h: b.Height } : null;
}, ENTRY);

/** Boot a solo run on a fresh demo server; `body` gets the page and the server's port. */
async function withSoloRun(page: any, body: (port: number) => Promise<void>) {
	const { server, bridge, port } = await start(0);
	try {
		await openGameMenu(page, port);
		await body(port);
	} finally {
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
}

test.describe('KDM-294 — the host entry on KD\'s in-game menu', () => {
	test.describe.configure({ timeout: 180_000 });

	test('#1 the entry is on the in-game menu, and only there', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			const names: string[] = await page.evaluate(() => Object.keys(KDButtonsCache));
			expect(names, 'the entry must be on KD\'s in-game menu').toContain(ENTRY);
			expect(names, 'and the menu must still be KD\'s').toEqual(expect.arrayContaining(['returnbutton', 'GameToggles']));

			// The dungeon view itself is not a menu — nothing of ours belongs on it.
			await page.evaluate(() => { KinkyDungeonDrawState = 'Game'; });
			await settle(page);
			await settle(page);
			expect(await page.evaluate(() => Object.keys(KDButtonsCache)), 'not on the dungeon view').not.toContain(ENTRY);
		});
	});

	test('#2 the entry overlaps no stock control — cache buttons AND hand-rolled MouseIn regions', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			expect(await clashes(page, [ENTRY], STOCK_MOUSE_IN),
				'a co-op entry sitting on a stock control eats its clicks').toEqual([]);
		});
	});

	test('#3 every stock control still wins its own pixels; our pixels open ours', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			await recordConnects(page);

			// Check Perks — MouseIn-only.
			await clickAt(page, centre(STOCK_MOUSE_IN[2]).x, centre(STOCK_MOUSE_IN[2]).y);
			expect(await where(page), 'Check Perks must still open the perk screen').toEqual({ state: 'Game', draw: 'Perks2' });
			await onGameMenu(page);

			// Return to game — a stock cache button.
			const ret = await page.evaluate(() => {
				// @ts-ignore
				const b = KDButtonsCache.returnbutton; return { x: b.Left, y: b.Top, w: b.Width, h: b.Height };
			});
			await clickAt(page, centre(ret).x, centre(ret).y);
			expect(await where(page), 'Return must still return to the dungeon').toEqual({ state: 'Game', draw: 'Game' });
			await onGameMenu(page);

			// Capture — MouseIn-only, and only ARMS on a first click (a confirm follows), so the claim
			// here is the negative one: the click did not reach us.
			await clickAt(page, centre(STOCK_MOUSE_IN[1]).x, centre(STOCK_MOUSE_IN[1]).y);
			expect((await where(page)).state, 'Capture must not open the co-op screen').not.toBe('Multiplayer');
			await onGameMenu(page);

			// POSITIVE CONTROL — without it every negative above passes on a harness that clicks nothing.
			const mine = await entryRect(page);
			expect(mine, 'the entry must be registered').not.toBeNull();
			await clickAt(page, centre(mine!).x, centre(mine!).y);
			expect((await where(page)).state, 'our own pixels open ours').toBe('Multiplayer');
			await press(page, 'KDMPBack');
			await onGameMenu(page);

			// Save & Quit — last, because it really does quit: KD saves and returns to its main menu.
			await clickAt(page, centre(STOCK_MOUSE_IN[0]).x, centre(STOCK_MOUSE_IN[0]).y);
			expect((await where(page)).state, 'Save & Quit must still quit to KD\'s menu').toBe('Menu');
		});
	});

	test('#4 pressing it hosts THIS run as it is now — nothing stale, nothing written', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			await recordConnects(page);
			// The marker lands AFTER any autosave, so only a save taken at the press can carry it.
			const before = await page.evaluate(() => {
				// eslint-disable-next-line no-eval
				(0, eval)('KinkyDungeonGold = 4343; KDGameData.PlayerName = "Rook";');
				try { return String(localStorage.getItem('KinkyDungeonSave') || ''); } catch (e) { return 'n/a'; }
			});

			await press(page, ENTRY);

			const st = await lobbyState(page);
			expect(st.error, 'a live run must not be refused').toBe('');
			expect(st.phase).toBe('waiting');
			expect(await where(page)).toEqual({ state: 'Multiplayer', draw: 'Restart' });
			expect(await page.evaluate(() => (window as any).KDMPLobby.returnTo), 'Back must lead to the game').toBe('Game');

			const sent = await connects(page);
			expect(sent.length, 'exactly one host request').toBe(1);
			expect(sent[0].role).toBe('host');
			// R7 — the character's own name, since the player typed none.
			expect(sent[0].name).toBe('Rook');
			const gold = await page.evaluate((s: string) => {
				// @ts-ignore — KD's own decompressor, the one `saveIsUsable` and the server use.
				try { return JSON.parse(DecompressB64(s)).gold; } catch (e) { return 'unreadable'; }
			}, sent[0].save);
			expect(gold, 'the save sent must be the run as it is NOW').toBe(4343);

			// R4 — pressing the entry wrote nothing to the player's own save.
			expect(await page.evaluate(() => {
				try { return String(localStorage.getItem('KinkyDungeonSave') || ''); } catch (e) { return 'n/a'; }
			}), 'the local save must be untouched').toBe(before);

			// CONTROL for R7 — a name the player DID type wins over the character's.
			await press(page, 'KDMPBack');
			await onGameMenu(page);
			await page.evaluate(() => { (window as any).KDMPLobby.name = 'Zed'; });
			await press(page, ENTRY);
			expect((await connects(page))[1].name, 'a typed name is never overwritten').toBe('Zed');
		});
	});

	test('#5 a run that cannot be serialised is refused in words, and nothing is asked', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			await recordConnects(page);
			await page.evaluate(() => {
				// eslint-disable-next-line no-eval
				(0, eval)('window.__kdmpSaveGame = KinkyDungeonSaveGame; KinkyDungeonSaveGame = function () { throw new Error("no"); };');
			});
			try {
				await press(page, ENTRY);
				const st = await lobbyState(page);
				expect(st.error).toBe(await page.evaluate(() => (window as any).KDMPText.t('KDMPSaveUnusable')));
				expect(await connects(page), 'a refused run must not be advertised').toEqual([]);
			} finally {
				// eslint-disable-next-line no-eval
				await page.evaluate(() => (0, eval)('KinkyDungeonSaveGame = window.__kdmpSaveGame;'));
			}
		});
	});

	test('#6 Cancel before anyone joins drops the player back into their run, still solo', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			await page.evaluate(() => {
				// eslint-disable-next-line no-eval
				(0, eval)('KinkyDungeonGold = 5151;');
			});
			await press(page, ENTRY);                    // the REAL transport this time
			await expect.poll(() => page.evaluate(() => !!(window as any).__coop.connected),
				{ timeout: 30_000, message: 'the host socket should open' }).toBe(true);

			await press(page, 'KDMPBack');               // the waiting phase's Cancel
			expect(await where(page), 'back on the menu they pressed it from').toEqual({ state: 'Game', draw: 'Restart' });
			await expect.poll(() => page.evaluate(() => !!(window as any).__coop.connected),
				{ timeout: 30_000, message: 'the host socket should close' }).toBe(false);
			expect(await page.evaluate(() => !!(window as any).__coop._entered), 'still single-player').toBe(false);
			expect(await goldOf(page), 'the run is the same run').toBe(5151);

			// …and still playable: a real turn advances KD's own clock.
			const ticks = await page.evaluate(() => {
				// eslint-disable-next-line no-eval
				const t0 = Number((0, eval)('KinkyDungeonCurrentTick'));
				// eslint-disable-next-line no-eval
				(0, eval)('KinkyDungeonDrawState = "Game"; KinkyDungeonAdvanceTime(1);');
				// eslint-disable-next-line no-eval
				return Number((0, eval)('KinkyDungeonCurrentTick')) - t0;
			});
			expect(ticks, 'a turn after Cancel must still advance the solo run').toBeGreaterThan(0);
		});
	});

	test('#7 a page already in a co-op session is not offered it', async ({ isolatedPage: page }) => {
		await withSoloRun(page, async () => {
			await page.evaluate(() => { (window as any).__coop._entered = true; });
			await settle(page);
			await settle(page);
			expect(await page.evaluate(() => Object.keys(KDButtonsCache)), 'no hosting from inside a session').not.toContain(ENTRY);
			// CONTROL — the same page, the flag back down, gets it back: the gate is the flag, not the frame.
			await page.evaluate(() => { (window as any).__coop._entered = false; });
			await onGameMenu(page);
		});
	});
});

test.describe('KDM-294 — a friend joins the run in progress', () => {
	test('#8 the guest arrives in THAT game — the host keeps their run', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openGameMenu(host, port);
			// Planted after any autosave: only the run-as-it-is-now can carry it into the session.
			await host.evaluate(() => {
				// eslint-disable-next-line no-eval
				(0, eval)('KinkyDungeonGold = 6262;');
			});
			await press(host, ENTRY);
			const st = await lobbyState(host);
			expect(st.error).toBe('');
			expect(st.phase).toBe('waiting');

			await guestJoinsAndIsAccepted(host, guest, port, bridge);

			await expect.poll(() => goldOf(host),
				{ timeout: 180_000, message: 'the host should still be in their own run' }).toBe(6262);
			expect(await goldOf(guest), 'the guest must not be a copy of the host').not.toBe(6262);
			expect(bridge.session.started).toBe(true);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
