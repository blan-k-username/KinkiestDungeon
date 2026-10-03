/**
 * E2E — a friend knocks while the host is already playing, and the host is asked IN THE GAME.
 *
 * The owner's UAT: host pressed Host and was playing; the friend pressed Join and sat on "Waiting for
 * the host to let you in…" for ever, because the question went to the lobby and the host was not on
 * the lobby screen. `mp-join-late.spec.ts` never saw it — it boots with `#coop=`, whose host answers
 * by itself. This spec is the human-host road: both players come in through the lobby, as a player
 * does, and the host is already in the dungeon when the guest asks.
 *
 * ⚠️ WHY IT IS NOT A VACUOUS GREEN. Accept and Decline are the same script up to the option chosen, and
 * they diverge — one ends with two seats and the guest in the game, the other with the host alone and
 * the guest told why. And the dialogue is checked ABSENT before the guest asks, so "the host's screen
 * shows the question" is a change of value, not something that was always there.
 */
import { test, expect } from '@playwright/test';
import { press, openLobby, lobbyState, guestAsks, bootToMenu, enteredCoop } from '../helpers/mp-lobby';
import { answerCoopDialogue, MP_TEST_TIMEOUT, reportedPageErrors } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JOIN_ASK_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

/** What the host's page is showing: the open dialogue, and the text KD would paint for it. */
async function hostDialogue(P: any) {
	return P.evaluate(() => {
		// @ts-ignore bare let-globals
		const g = (typeof KDGameData !== 'undefined' && KDGameData) || {};
		const name = g.CurrentDialog || '';
		// @ts-ignore bare let-global — NOT on window (CLAUDE.md: bundle let-globals are not globalThis)
		const d = name && typeof KDDialogue !== 'undefined' ? (KDDialogue as any)[name] : null;
		// @ts-ignore bare let-global
		const body = name ? TextGet('r' + (g.CurrentDialogMsg || (d && d.response) || name)) : '';
		const opts = d && d.options ? Object.keys(d.options).sort() : [];
		return {
			name,
			data: g.CurrentDialogMsgData || null,
			body,
			// @ts-ignore bare let-global
			labels: opts.map((o: string) => TextGet(`d${name}_${o}`)),
			options: opts,
		};
	});
}

/** The host presses Host on a gateway that starts the run for one player, and is then PLAYING. */
async function hostIsPlaying(host: any, port: number) {
	await openLobby(host, port, '127.0.0.1', { preload: true });
	await press(host, 'KDMPHost');
	await enteredCoop(host);
}

for (const option of ['Accept', 'Decline'] as const) {
	test(`a host in the dungeon is asked in the game, and ${option} is honoured`, async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		// requiredPlayers: 1 — the host plays ALONE first, which is the whole join-late situation.
		const { server, bridge, port } = await start(0, { requiredPlayers: 1 });
		const hostCtx = await browser.newContext();
		const guestCtx = await browser.newContext();
		const host = await hostCtx.newPage();
		const guest = await guestCtx.newPage();
		const crashes: string[] = [];
		host.on('pageerror', (e: any) => crashes.push(`host: ${(e && e.message) || String(e)}`));
		try {
			/*
			 * Accept needs the guest's page able to ENTER the game afterwards, so it preloads — and it
			 * preloads BEFORE the host is in the dungeon, which is not a convenience.
			 *
			 * Both pages share ONE headless browser, and a page rendering a KD dungeon starves the
			 * other page's asset preload. Measured on the same host: the host's boot+preload took
			 * 21-22 s with the guest page idle; the guest's took 119-158 s with the host in the game,
			 * against a 120 s preload budget — red 4/4 on a loaded machine. Two real players are two
			 * machines, so that contention is the harness's, not the game's. The claim under test
			 * (the host is asked IN THE GAME) only needs the host in the dungeon when the guest ASKS,
			 * and that ordering is unchanged.
			 */
			if (option === 'Accept') await bootToMenu(guest, port, '127.0.0.1', { preload: true });
			await hostIsPlaying(host, port);
			expect(bridge.session.players, 'control: the host is playing alone').toEqual([bridge.gate.host]);
			expect((await hostDialogue(host)).name, 'control: nobody has asked yet').not.toBe(JOIN_ASK_DIALOGUE);

			await guestAsks(guest, port, 'Bee', undefined, { booted: option === 'Accept' });
			await expect.poll(async () => (await lobbyState(guest)).status, { timeout: 30_000 })
				.toMatch(/Waiting for the host/);

			// ---- the host is asked, IN THE GAME, by name --------------------------------------------
			await host.waitForFunction((n) => {
				// @ts-ignore bare let-global
				return typeof KDGameData !== 'undefined' && KDGameData && KDGameData.CurrentDialog === n;
			}, JOIN_ASK_DIALOGUE, { timeout: 60_000 });
			const asked = await hostDialogue(host);
			expect(asked.options, 'let them in, or not — nothing else').toEqual(['Accept', 'Decline']);
			expect(asked.data, 'the question names who is asking').toEqual({ GUESTNAME: 'Bee' });
			expect(asked.body, 'the question is readable').not.toMatch(/NotFound/);
			expect(asked.body, 'and carries the name token KD will fill').toMatch(/GUESTNAME/);
			for (const l of asked.labels) expect(l, 'each button is readable').not.toMatch(/NotFound/);
			const crashesBefore = crashes.length;

			await answerCoopDialogue(host, JOIN_ASK_DIALOGUE, option);

			if (option === 'Accept') {
				await expect.poll(() => bridge.session.players.length,
					{ timeout: 60_000, message: 'the guest is seated into the running game' }).toBe(2);
				await enteredCoop(guest);
			} else {
				await expect.poll(async () => (await lobbyState(guest)).error,
					{ timeout: 30_000, message: 'refused in words, not silence' }).toContain('declined');
				expect(bridge.session.players, 'the host plays on alone').toEqual([bridge.gate.host]);
			}
			await host.waitForFunction((n) => {
				// @ts-ignore bare let-global
				return KDGameData.CurrentDialog !== n;
			}, JOIN_ASK_DIALOGUE, { timeout: 60_000 });

			const { real, ignored } = reportedPageErrors(crashes.slice(crashesBefore));
			// eslint-disable-next-line no-console
			if (ignored.length) console.log(`ignored ${ignored.length} pre-existing asset error(s): ${ignored[0]}`);
			expect(real, 'answering the question must not trip KD\'s error handler').toEqual([]);
		} finally {
			await hostCtx.close().catch(() => {});
			await guestCtx.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
}
