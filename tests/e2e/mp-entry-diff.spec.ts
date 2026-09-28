/**
 * E2E (KDM-293) — co-op is reached from KD's OWN class/start screen, not from a menu of ours.
 *
 * ── WHAT THIS SLICE INVERTS ───────────────────────────────────────────────────────────────────────
 * Until now the road was: main menu -> OUR Multiplayer menu -> "Character" -> KD's 'Diff' screen ->
 * commit -> back to OUR menu -> Host/Join. The lobby SENT you to KD's screen and had to BORROW three
 * of its buttons to get you back (borrowButtons, KDM-256).
 *
 * Now the player is simply on 'Diff' — KD's own road, Menu -> Name -> Diff — builds a character the
 * way they always would, and Host / Continue Save / Join are right there. Nothing is borrowed,
 * because nothing needs to come back: startQuick / startGameKinky / startGame keep starting solo
 * games, which is the right answer for a player who changed their mind.
 *
 * ⚠️ THE ROUTERS DIE, THE ACTIONS MOVE. KDMPPerks and KDMPChar existed only to send the player to
 * screens they can now reach by KD's own road; KDMPHost / KDMPContinue / KDMPJoin keep their ids and
 * their labels and change only their home. Keeping the ids is deliberate — it is what lets the
 * existing suite migrate through two helpers instead of being rewritten.
 *
 * ── WHY THESE ASSERTIONS AND NOT OTHERS ───────────────────────────────────────────────────────────
 *  1. #1 and #6 are a PAIR, and #6 catches the bug worth catching. Adding a button to a stock screen
 *     is easy; adding one that quietly eats a stock button is easy too (pitfall #30 —
 *     KDProcessButtons runs before KD's MouseIn chain and returns on a hit). #6 presses each of the
 *     three start buttons WITH our entries present and requires a solo game.
 *  2. #7 guards a real, non-obvious channel. KDUpdatePlugSettings (KinkyDungeon.ts:6116-6146) writes
 *     21 WORLD-mode keys into KinkyDungeonStatsChoice — the same Map the perk grid uses and the same
 *     Map the character declaration is read from. So a guest's world toggles DO ride the wire, on the
 *     character.perks channel, and are stopped server-side by applyPerks' whitelist
 *     (join-gate.js:223) and by applyModes running after it (headless-host.js:1793).
 *     It therefore asserts the HOST'S WORLD, never the wire — the key on the wire is EXPECTED, and a
 *     test asserting its absence would go green for the wrong reason.
 *  3. #8 is #7's twin from the other side: the world controls must stay LIVE. KDM-291 decided against
 *     suppressing them, so a future "helpful" enabled = false is a regression nothing else notices.
 *  4. #10 is what keeps the de-duplication claim honest. Without it "we deleted the root menu" is
 *     asserted nowhere, and a half-done deletion passes every other test in this file.
 *
 * ⚠️ FAILS UNTIL KDM-293 IS IMPLEMENTED. Written first, per the project's Rule 1.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { injectLobby, press, settle, openEntry, lobbyState } from '../helpers/mp-lobby';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const MP_TEST_TIMEOUT = Number(process.env.KD_MP_TEST_TIMEOUT || 600_000);

/** The stock buttons our entries must NOT disturb. */
const STOCK_STARTS = ['startQuick', 'startGameKinky', 'startGame'];
/** The two routers this slice deletes, plus the menu entry that opened the lobby. */
const DELETED = ['KDMPPerks', 'KDMPChar', 'MultiplayerButton'];

const buttonNames = (page: any) => page.evaluate(() => Object.keys(KDButtonsCache));

/** Put the page on KD's class/start screen, the way KD's own road arrives there. */
async function onClassScreen(page: any) {
	await page.evaluate(() => { KinkyDungeonState = 'Diff'; });
	await settle(page);
}

/** Pick a class through KD's OWN grid button, never by assigning the global. */
async function pickClass(page: any, index: number) {
	await press(page, 'Class' + index);
	return page.evaluate(() => KinkyDungeonClassMode);
}

/**
 * Press a co-op entry, and dismiss the briefing if this page has never seen it.
 *
 * KDM-272's briefing is shown on a first-ever co-op entry, and a bundle-only test page never has
 * `__coopBriefingSeen`, so it is shown EVERY time here. `openLobby` in the shared helper takes the
 * same line for the same reason: every spec but the one that is about the briefing wants what comes
 * after it. #12 below is that one spec, and it opts out by not using this.
 */
async function enter(page: any, button: string) {
	await press(page, button);
	const phase = await page.evaluate(() => (window as any).KDMPLobby.phase);
	if (phase === 'about') await press(page, 'KDMPBack');
}

test.describe('KDM-293 — the co-op entries live on KD\'s class screen', () => {

	test('#1 the entries are on the class screen, and the screen is still KD\'s', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);

		const names = await buttonNames(page);
		expect(names, 'Host is registered on the stock screen').toContain('KDMPHost');
		expect(names, 'Join is registered on the stock screen').toContain('KDMPJoin');
		// The screen must remain KD's — this is what stops #2 passing because we painted our own.
		expect(names.filter((n: string) => /^Class\d+$/.test(n)).length,
			'KD\'s own class grid is still painted').toBeGreaterThan(1);
		for (const b of STOCK_STARTS) expect(names, 'stock start button survives').toContain(b);
	});

	test('#2 Join opens the handshake screen, remembering where it came from', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);
		await enter(page, 'KDMPJoin');

		const st = await page.evaluate(() => ({
			screen: KinkyDungeonState,
			// @ts-ignore — bundle `let` globals are in the global lexical scope.
			phase: window.KDMPLobby.phase,
			// @ts-ignore
			returnTo: window.KDMPLobby.returnTo,
		}));
		expect(st.screen).toBe('Multiplayer');
		expect(st.phase, 'straight to connect — there is no menu any more').toBe('connect');
		expect(st.returnTo, 'so Back is a real route back').toBe('Diff');
	});

	test('#3 Back returns to the class grid, with the character intact', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);
		const chosen = await pickClass(page, 1);

		await enter(page, 'KDMPJoin');
		await press(page, 'KDMPBack');
		await settle(page);

		const after = await page.evaluate(() => ({
			screen: KinkyDungeonState,
			klass: KinkyDungeonClassMode,
			grid: Object.keys(KDButtonsCache).filter((n) => /^Class\d+$/.test(n)).length,
		}));
		expect(after.screen, 'back to the screen we came from').toBe('Diff');
		expect(after.klass, 'and the choice survived the trip').toBe(chosen);
		expect(after.grid, 'the grid is painted again, not a husk').toBeGreaterThan(1);
	});

	test('#4 a class changed after Back is the one that gets declared', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);

		const first = await pickClass(page, 0);
		await enter(page, 'KDMPJoin');
		await press(page, 'KDMPBack');
		const second = await pickClass(page, 1);
		test.skip(!second || second === first, 'this build has fewer than two selectable classes');
		await enter(page, 'KDMPJoin');

		// The declaration is read AT CONNECT, not cached when the entry was first pressed — which is
		// the whole reason commitCharacter could be deleted rather than moved.
		const declared = await page.evaluate(() => (window as any).KDMPLobby.playerCharacter());
		expect(declared?.class, 'the LATEST choice travels, not the first').toBe(second);
	});

	test('#6 the three stock start buttons still start a solo game', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);

		for (const button of STOCK_STARTS) {
			await onClassScreen(page);
			await press(page, button);
			const st = await page.evaluate(() => ({
				screen: KinkyDungeonState,
				// @ts-ignore
				phase: window.KDMPLobby.phase,
			}));
			expect(st.screen,
				button + ' must still do KD\'s own thing — pitfall #30, our button must not eat it')
				.not.toBe('Multiplayer');
		}
	});

	/**
	 * KDM-272's invariant, re-established (KDM-293 R4.5).
	 *
	 * The briefing's first line is about start perks being the PARTY's — a choice the player cannot
	 * take back. It used to be guaranteed upstream of every declaration by sitting on the root menu,
	 * which was upstream of the Host button. With the buttons on KD's own screen that guarantee has to
	 * be made explicitly, and it is: `open()` takes the connect as a CALLBACK and the briefing's Back
	 * runs it.
	 *
	 * This test is why that shape exists. The first implementation called `hostConnect()` on the same
	 * line as `open()`, which advertised the session while the player was still reading the rules
	 * governing it — green on every other test in this file.
	 */
	test('#12 a first-ever entry reads the briefing BEFORE anything is asked of the server', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);

		// Record every connect attempt instead of stubbing one out — a stub that returns nothing would
		// also pass if the call simply failed.
		await page.evaluate(() => {
			(window as any).__asked = [];
			(window as any).__coopConnect = (o: any) => { (window as any).__asked.push(o.role); return null; };
		});

		await press(page, 'KDMPHost');
		const during = await page.evaluate(() => ({
			// @ts-ignore
			phase: window.KDMPLobby.phase, asked: (window as any).__asked.slice(),
		}));
		expect(during.phase, 'a first-ever entry lands on the briefing').toBe('about');
		expect(during.asked, 'and NOTHING has been asked of the server yet').toEqual([]);

		await press(page, 'KDMPBack');
		const after = await page.evaluate(() => ({
			// @ts-ignore
			phase: window.KDMPLobby.phase, asked: (window as any).__asked.slice(),
		}));
		expect(after.phase, 'reading it hands off to the phase the entry was headed for').toBe('waiting');
		expect(after.asked, 'and only now do we ask for a seat').toEqual(['host']);
	});

	test('#8 the world controls stay LIVE — no suppression, by decision', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);

		// KDM-291 / KDM-293 R6: the server partitions world keys from player keys, so these are
		// misleading at worst, never harmful — and the answer is a sentence on the handshake screen,
		// not dead controls. This fails the moment somebody adds suppression.
		//
		// ⚠️ FOUR controls, not the seven KDM-293's assessment claimed. The three
		// KinkyDungeonProgressionMode* buttons sit inside a BLOCK COMMENT in KD
		// (KinkyDungeon.ts:2662-2698, "now its all handled in the logic for the roguelike map
		// selector"), so a grep for DrawButtonKDEx( counted them and the running game does not.
		const live = await page.evaluate(() => ['KinkyDungeonSexyMode0', 'KinkyDungeonSexyMode1',
			'KinkyDungeonRandomMode0', 'KinkyDungeonRandomMode1']
			.map((n) => !!(KDButtonsCache[n] && KDButtonsCache[n].enabled)));
		expect(live, 'stock world controls are untouched').toEqual([true, true, true, true]);
	});

	/**
	 * Pitfall #30, as an assertion rather than a warning.
	 *
	 * KinkyDungeonHandleClick runs KDProcessButtons() before its MouseIn chain and returns on a hit
	 * (KinkyDungeon.ts:6225), and among cache buttons the highest priority wins. So a button of ours
	 * that OVERLAPS a stock one steals its clicks, silently, with both still painted.
	 *
	 * Not hypothetical: the first geometry proposed for this slice was a full-width row at y=860,
	 * which covers backButton at (1075, 900, 350, 64) — KD's own way off the class screen. The
	 * assessment missed it because backButton is drawn by the setup-tab helper, not by the 'Diff'
	 * branch. A pixel rule is cheaper than remembering.
	 */
	test('#11 our entries overlap no stock control on the class screen', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);
		await onClassScreen(page);

		const clashes = await page.evaluate((ours: string[]) => {
			const box = (b: any) => ({ l: b.Left, t: b.Top, r: b.Left + b.Width, b: b.Top + b.Height });
			const hits: string[] = [];
			for (const mine of ours) {
				const a = KDButtonsCache[mine];
				if (!a) { hits.push(mine + ':MISSING'); continue; }
				const A = box(a);
				for (const name of Object.keys(KDButtonsCache)) {
					if (ours.indexOf(name) >= 0) continue;
					const B = box(KDButtonsCache[name]);
					if (A.l < B.r && B.l < A.r && A.t < B.b && B.t < A.b) hits.push(mine + ' over ' + name);
				}
			}
			return hits;
		}, ['KDMPHost', 'KDMPJoin']);

		expect(clashes, 'a co-op entry sitting on a stock button eats its clicks').toEqual([]);
	});

	test('#10 the routers and the menu entry are gone from every screen', async ({ isolatedPage: page }) => {
		await bootKD(page);
		await injectLobby(page);

		// Every screen the old road touched. If any of these still registers a deleted button, the
		// root menu was only half removed — which every other test in this file would pass.
		for (const screen of ['Menu', 'Diff', 'Stats', 'Multiplayer']) {
			await page.evaluate((s: string) => { KinkyDungeonState = s; }, screen);
			await settle(page);
			const names = await buttonNames(page);
			for (const dead of DELETED) {
				expect(names, dead + ' must not exist on ' + screen).not.toContain(dead);
			}
		}
	});
});

test.describe('KDM-293 — a character built on KD\'s screen reaches the host', () => {

	test('#5 the guest arrives as the character they built', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openEntry(host, port);
			await enter(host, 'KDMPHost');
			expect((await lobbyState(host)).phase).toBe('waiting');

			await openEntry(guest, port);
			await onClassScreen(guest);
			await press(guest, 'Class1');
			const klass = await guest.evaluate(() => KinkyDungeonClassMode);
			await enter(guest, 'KDMPJoin');
			await guest.locator('#KDMPAddress').fill('127.0.0.1:' + port);
			await guest.locator('#KDMPName').fill('Ada');
			await press(guest, 'KDMPConnect');

			await expect.poll(async () => (await lobbyState(host)).pending?.name,
				{ timeout: 30_000 }).toBe('Ada');
			await press(host, 'KDMPAccept');
			await expect.poll(() => bridge.session.players.length, { timeout: 120_000 }).toBe(2);

			/*
			 * Asserted on the SEAT the server holds for this guest, not on `KDGameData.Class`.
			 *
			 * ⚠️ `KDGameData.Class` in the host's world is the HOST's class — the guest is a peer seat,
			 * not the player slot — so the first version of this assertion compared the guest's Rogue
			 * against the host's default Mage and failed while everything worked. The deciding record
			 * for "what did this player bring" is `gate.characterOf(seat)` (`join-gate.js:368`), which
			 * `SwapSession.characterOf` is the sole consumer of.
			 */
			const guestSeat = bridge.gate.guest;
			expect(guestSeat, 'the guest holds a seat').toBeTruthy();
			expect(bridge.gate.characterOf(guestSeat)?.class,
				'the class built on KD\'s screen is what the session records for that seat')
				.toBe(klass);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});

	test('#7 a guest\'s world toggle does not change the host\'s world', async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		try {
			await openEntry(host, port);
			await enter(host, 'KDMPHost');

			/*
			 * The guest carries a WORLD key in the Map the declaration is read from.
			 *
			 * ⚠️ SET DIRECTLY, and that is not laziness. Pressing `KinkyDungeonRandomMode1` does NOT
			 * put `randomMode` into `KinkyDungeonStatsChoice`: the toggle only writes the global and
			 * localStorage (`KinkyDungeon.ts:2636-2637`), and the bridge into the Map is
			 * `KDUpdatePlugSettings`, which KD calls at init (`:4427`) and from the three START buttons
			 * (`:2555, :2569, :2581`) — buttons a co-op player never presses. So driving the toggle
			 * reproduces the wrong state and the first version of this test asserted `undefined`.
			 * What actually reaches a host is a key seeded at init from a previous session's settings,
			 * which is exactly the state set here.
			 */
			await openEntry(guest, port);
			await guest.evaluate(() => { KinkyDungeonStatsChoice.set('randomMode', true); });
			expect(await guest.evaluate(() => KinkyDungeonStatsChoice.get('randomMode')),
				'precondition: the guest really does carry the world key').toBe(true);
			expect(await guest.evaluate(() => ((window as any).KDMPLobby.playerCharacter() || {}).perks || []),
				'precondition: and it really does travel on the perk channel').toContain('randomMode');

			await enter(guest, 'KDMPJoin');
			await guest.locator('#KDMPAddress').fill('127.0.0.1:' + port);
			await guest.locator('#KDMPName').fill('Ada');
			await press(guest, 'KDMPConnect');
			await expect.poll(async () => (await lobbyState(host)).pending?.name,
				{ timeout: 30_000 }).toBe('Ada');
			await press(host, 'KDMPAccept');
			await expect.poll(() => bridge.session.players.length, { timeout: 120_000 }).toBe(2);

			const hostRandom = bridge.session.world.eval(
				'(function(){ return !!KinkyDungeonStatsChoice.get("randomMode"); })()');
			expect(hostRandom, 'the host names the world; a guest cannot vote on it').toBe(false);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
});
