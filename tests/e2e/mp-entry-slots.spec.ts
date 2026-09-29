/**
 * E2E (KDM-295) — join a host with a character from a SAVE SLOT, from KD's own save-slot screen.
 *
 * The owner's second option, and the more useful one: bring a character you already made. A button
 * beside KD's "Play Slot N" (`KinkyDungeonState === 'LoadSlots'`), live exactly when KD's own is.
 *
 * ── WHAT TRAVELS (owner's decision, 2026-09-29) ───────────────────────────────────────────────────
 * The CHARACTER — class, outfit, perk choices, and the name as a default. NOT the run: floor, items,
 * spells and gold stay in the slot. The trap named on the task is discarding progress SILENTLY, so #4
 * asserts the screen says so before Connect is pressed.
 *
 * ── WHY THESE ASSERTIONS AND NOT OTHERS ───────────────────────────────────────────────────────────
 *  1. #3 plants a CONTROL: the page's live class is changed AFTER the save is made. The declaration
 *     must carry the SAVE's class — a lobby that kept reading the live globals (as the class-screen
 *     entry rightly does) passes every other test in this file and fails this one.
 *  2. #6 is #3's twin in the other direction: after a save-slot join is backed out of, the class
 *     screen's entry must declare the LIVE class again. A sticky save source is the bug it catches.
 *  3. #8 asserts on the SEAT the server holds (`gate.characterOf`), the deciding record — as
 *     `mp-entry-diff` #5 does, for the reason written there.
 *
 * ⚠️ FAILS UNTIL KDM-295 IS IMPLEMENTED. Written first, per the project's Rule 1.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import {
	press, settle, lobbyState, bootToMenu, saveCodeFor, openSlotsWith, recordConnects, connects, clashes,
	paintedText,
} from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);
const ENTRY = 'KDMPJoinSave';

const where = (page: any) => page.evaluate(() => KinkyDungeonState);

/** Boot, make a save as class #1 called Mira, change the LIVE class to #2, and select the save. */
async function withSelectedSave(page: any, body: (s: { port: number; code: string; klass: string; live: string }) => Promise<void>) {
	const { server, bridge, port } = await start(0);
	try {
		await bootToMenu(page, port, '127.0.0.1', { preload: true });
		const { code, klass } = await saveCodeFor(page, 1, 'Mira');
		// The control: whatever this page touches next is NOT the saved character.
		const live = await page.evaluate(() => {
			// eslint-disable-next-line no-eval
			const k = String((0, eval)('Object.keys(KDClassStart)[2]'));
			// eslint-disable-next-line no-eval
			(0, eval)('KinkyDungeonClassMode = ' + JSON.stringify(k) + '; KDGameData.PlayerName = "Live";');
			return k;
		});
		expect(live, 'the control class must differ from the saved one').not.toBe(klass);
		await openSlotsWith(page, code);
		await body({ port, code, klass, live });
	} finally {
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
}

test.describe('KDM-295 — the join entry on KD\'s save-slot screen', () => {
	test.describe.configure({ timeout: 180_000 });

	test('#1 the entry sits beside Play Slot, enabled exactly when KD\'s own is', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async () => {
			const both = () => page.evaluate(() => ({
				// @ts-ignore
				ours: !!(KDButtonsCache.KDMPJoinSave && KDButtonsCache.KDMPJoinSave.enabled),
				// @ts-ignore
				kds: !!(KDButtonsCache.KDLoadGame && KDButtonsCache.KDLoadGame.enabled),
			}));
			expect(await both(), 'a save is selected: both live').toEqual({ ours: true, kds: true });

			await page.evaluate(() => { LoadMenuCurrentSave = ''; });
			await settle(page);
			await settle(page);
			expect(await both(), 'nothing selected: both dead').toEqual({ ours: false, kds: false });

			await page.evaluate(() => { LoadMenuCurrentSave = undefined; });
			await settle(page);
			await settle(page);
			expect(await both(), 'never selected: both dead').toEqual({ ours: false, kds: false });
		});
	});

	test('#2 the entry overlaps no stock control on the save-slot screen', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async () => {
			expect(await clashes(page, [ENTRY]), 'a co-op entry sitting on a stock button eats its clicks').toEqual([]);
		});
	});

	test('#3 pressing it declares the SAVE\'s character, not whatever the page last touched', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async ({ klass, code }) => {
			await recordConnects(page);
			await press(page, ENTRY);
			expect(await where(page)).toBe('Multiplayer');
			const st = await lobbyState(page);
			expect(st.phase, 'straight to the address, like the class screen\'s Join').toBe('connect');
			expect(await page.evaluate(() => (window as any).KDMPLobby.returnTo)).toBe('LoadSlots');

			await page.locator('#KDMPAddress').fill('127.0.0.1:1');
			await press(page, 'KDMPConnect');
			const sent = await connects(page);
			expect(sent.length).toBe(1);
			expect(sent[0].role).toBe('guest');
			expect(sent[0].character?.class, 'the SAVE\'s class').toBe(klass);

			// Outfit and perks, from the same save, read back by KD's own decompressor.
			const fromSave = await page.evaluate((c: string) => {
				// @ts-ignore
				const d = JSON.parse(DecompressB64(c));
				const perks = (d.statchoice || []).filter((e: any) => e && e[1]).map((e: any) => String(e[0]));
				return { outfit: d.dress, perks };
			}, code);
			expect(sent[0].character?.outfit).toBe(fromSave.outfit);
			expect(sent[0].character?.perks || []).toEqual(fromSave.perks);
			// The name defaults to the save's character, not the page's.
			expect(sent[0].name).toBe('Mira');
			// …and nothing of the RUN travels: the package has exactly the character's fields.
			expect(Object.keys(sent[0].character).sort()).toEqual(
				expect.arrayContaining(['class', 'outfit']));
			expect(Object.keys(sent[0].character).every((k: string) => ['class', 'outfit', 'perks'].includes(k)),
				'only character fields may be declared').toBe(true);
		});
	});

	test('#4 the connect screen SAYS the run stays behind — before Connect is pressed', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async () => {
			await press(page, ENTRY);
			const want = await page.evaluate(() => {
				const t = (window as any).KDMPText.t;
				return [t('KDMPSaveCharacterOnly', { NAME: 'Mira' }), t('KDMPSaveRunStays')];
			});
			expect(want[0]).toContain('Mira');
			const painted = await paintedText(page);
			expect(painted, 'who you join as must be on screen').toContain(want[0]);
			expect(painted, 'and that the run stays in the slot').toContain(want[1]);
		});
	});

	test('#5 Back returns to the slot list with the selection and the paste box intact', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async ({ code }) => {
			// While OUR screen is up, KD's persistent paste box must not float over it.
			await press(page, ENTRY);
			expect(await page.locator('#saveInputField').isVisible(), 'KD\'s paste box is hidden on our screen').toBe(false);

			await press(page, 'KDMPBack');
			expect(await where(page)).toBe('LoadSlots');
			await settle(page);
			expect(await page.evaluate(() => LoadMenuCurrentSave), 'the selection survives').toBe(code);
			expect(await page.locator('#saveInputField').isVisible(), 'and KD shows its paste box again').toBe(true);
			expect(await page.locator('#saveInputField').inputValue(), 'with what was pasted').toBe(code);
		});
	});

	test('#6 the save source is per-entry: the class screen declares the LIVE character again', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async ({ live }) => {
			await recordConnects(page);
			await press(page, ENTRY);
			await press(page, 'KDMPBack');
			await page.evaluate(() => { KinkyDungeonState = 'Diff'; });
			await page.waitForFunction(() => !!(KDButtonsCache && KDButtonsCache.KDMPJoin), undefined, { polling: 'raf' });
			await press(page, 'KDMPJoin');
			await page.locator('#KDMPAddress').fill('127.0.0.1:1');
			await press(page, 'KDMPConnect');
			expect((await connects(page))[0].character?.class, 'the live class, not the stale save').toBe(live);
		});
	});

	test('#7 Play Slot still loads the save the ordinary way, with the entry present', async ({ isolatedPage: page }) => {
		await withSelectedSave(page, async () => {
			await press(page, 'KDLoadGame');
			await expect.poll(() => where(page), { timeout: 60_000, message: 'KD\'s own load must proceed' })
				.toMatch(/^(GenMap|Game)$/);
			expect(await page.evaluate(() => (window as any).KDMPLobby.phase), 'and our screen was never involved')
				.not.toBe('waiting');
		});
	});
});

test.describe('KDM-295 — a guest arrives as the save\'s character', () => {
	test('#8 the host seats the save\'s class and hears the save\'s name', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await bootToMenu(host, port, '127.0.0.1', {});
			await host.evaluate(() => { KinkyDungeonState = 'Diff'; });
			await host.waitForFunction(() => !!(KDButtonsCache && KDButtonsCache.KDMPHost), undefined, { polling: 'raf' });
			await press(host, 'KDMPHost');
			expect((await lobbyState(host)).phase).toBe('waiting');

			await bootToMenu(guest, port, '127.0.0.1', { preload: true });
			const { code, klass } = await saveCodeFor(guest, 1, 'Mira');
			await guest.evaluate(() => {
				// eslint-disable-next-line no-eval
				(0, eval)('KinkyDungeonClassMode = Object.keys(KDClassStart)[2];');
			});
			await openSlotsWith(guest, code);
			await press(guest, ENTRY);
			await guest.locator('#KDMPAddress').fill('127.0.0.1:' + port);
			await press(guest, 'KDMPConnect');

			// The host is asked by the SAVE's name — the player typed none.
			await expect.poll(async () => (await lobbyState(host)).pending?.name,
				{ timeout: 120_000, message: 'the host should be prompted by the save\'s name' }).toBe('Mira');
			await press(host, 'KDMPAccept');
			await expect.poll(() => bridge.session.players.length, { timeout: 180_000 }).toBe(2);

			const guestSeat = bridge.gate.guest;
			expect(guestSeat, 'the guest holds a seat').toBeTruthy();
			expect(bridge.gate.characterOf(guestSeat)?.class, 'the seat carries the save\'s class').toBe(klass);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
