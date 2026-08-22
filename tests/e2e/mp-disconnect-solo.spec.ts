/**
 * E2E (KDM-253) — the whole story, in two real browsers: a partner drops, the host is asked, the
 * host chooses to go on alone, and the run keeps going.
 *
 * The node spec proves each teardown step in isolation. This proves the thing it structurally
 * cannot: that a real player, clicking a real button in a real game, ends up with a working
 * single-player run instead of a half-dismantled world. That is the whole point of the slice — the
 * owner's words were *"all related to him/her items and logic should gracefully disappear"*, and
 * "gracefully" is a claim about what happens next, not about a Map being empty.
 *
 * ⚠️ THE HOST CLICKS. The choice is answered through KD's own dialogue input, exactly as a player
 * makes it — not by calling `removePlayer` from the test. A teardown driven directly would skip the
 * one path a human can actually take, which is where the KDM-230 ordering bug lived.
 *
 * TWO INVARIANTS RIDE ALONG, per TESTING_POLICY: no crash handler fires, and nothing paints an
 * unresolved text key. A disconnect teardown is exactly the kind of change that trips both, and both
 * are silent in a spec that only asserts state.
 */
import { test, expect } from '@playwright/test';
import { bootCoopPair, killCoopSocket, MP_TEST_TIMEOUT } from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PEER_LOST_DIALOGUE } = require('../../tools/mp-server/kd-disconnect-dialogue');

/** What the host's page believes, and what it is showing. */
async function hostView(P: any) {
	return P.evaluate(() => {
		const c = (window as any).__coop || {};
		const el = document.getElementById('coop-overlay');
		return {
			peerMissing: c.peerMissing || null,
			blocked: c.blocked || null,
			lastTick: c.lastTick,
			status: (el && el.textContent) || '',
			// @ts-ignore bare let-global
			dialogue: (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : '',
		};
	});
}

/** Answer the open dialogue the way its button does — KD's own routed input. */
async function clickOption(P: any, dialogue: string, option: string) {
	await P.evaluate(({ d, o }: any) => {
		// @ts-ignore bare let-global — the same call KinkyDungeonDialogue.ts:187 makes on a click
		KDSendInput('dialogue', { dialogue: d, dialogueStage: o, click: true });
	}, { d: dialogue, o: option });
}

test('a host whose partner drops can choose to go on alone, and the run keeps working',
	async ({ browser }) => {
		test.setTimeout(MP_TEST_TIMEOUT);
		const { server, bridge, port } = await start(0);

		const ctxA = await browser.newContext();   // A joins first → seat 0 → the HOST, who decides
		const ctxB = await browser.newContext();   // B → seat 1 → the guest, who leaves
		const A = await ctxA.newPage();
		const B = await ctxB.newPage();

		// Any uncaught page error is a crash — KD installs a handler, and a teardown that trips it is
		// the failure mode this slice most plausibly introduces. Collected from the first moment so
		// the BASELINE is visible: the oracle below asks what the teardown added, not what the page
		// has always done.
		const crashes: string[] = [];
		A.on('pageerror', (e) => crashes.push(String(e)));
		/**
		 * The demo server does not serve every asset the bundle asks for (`Logo.png` 404s on every
		 * boot, in every MP spec). That is pre-existing and has nothing to do with a departing player,
		 * so it is excluded BY NAME rather than by widening the oracle — and what was excluded is
		 * printed, because a filter nobody can see is how a crash oracle quietly stops working.
		 */
		const ASSET_NOISE = /\[(Loader\.load|WorkerManager\.loadImageBitmap)\]/;

		try {
			await bootCoopPair(A, B, port);

			// ---- control: nothing is missing and nothing is being asked ---------------------------
			const before = await hostView(A);
			expect(before.peerMissing, 'nobody has left yet').toBeNull();
			expect(before.dialogue, 'and the host is not being asked anything')
				.not.toBe(PEER_LOST_DIALOGUE);

			// ---- the guest goes, and does not come back --------------------------------------------
			const crashesBefore = crashes.length;
			await killCoopSocket(B, { retry: false });

			// ---- S3/S4: the host is asked, IN THE GAME ----------------------------------------------
			await A.waitForFunction(
				(name) => {
					const c = (window as any).__coop;
					// @ts-ignore bare let-global
					return !!(c && c.peerMissing) && typeof KDGameData !== 'undefined' && KDGameData
						&& KDGameData.CurrentDialog === name;
				},
				PEER_LOST_DIALOGUE, { timeout: 120_000 },
			);

			// D1 — two options, and the player can read both. A dialogue whose buttons paint
			// "[NotFound] …" is one this epic has already shipped twice.
			const asked = await A.evaluate((name) => {
				// @ts-ignore bare let-globals
				const d = (KDDialogue as any)[name];
				const opts = d && d.options ? Object.keys(d.options) : [];
				return {
					options: opts.sort(),
					// @ts-ignore
					body: TextGet('r' + name),
					// @ts-ignore
					labels: opts.map((o: string) => TextGet(`d${name}_${o}`)),
				};
			}, PEER_LOST_DIALOGUE);
			expect(asked.options, 'wait, or go on alone — and nothing else').toEqual(['Solo', 'Wait']);
			expect(asked.body, 'the question is readable').not.toMatch(/NotFound/);
			for (const label of asked.labels) expect(label, 'each button is readable').not.toMatch(/NotFound/);

			// ---- S2 (KDM-251, still true): until they answer, the game is paused ---------------------
			await A.evaluate(() => (window as any).__coop.sendMove(1, 0));
			await A.waitForFunction(
				() => (window as any).__coop && (window as any).__coop.blocked === 'peer-missing',
				undefined, { timeout: 120_000 },
			);

			// ---- S4/E5: the host clicks "go on alone" ------------------------------------------------
			const tickBefore = (await hostView(A)).lastTick;
			await clickOption(A, PEER_LOST_DIALOGUE, 'Solo');

			await A.waitForFunction(
				() => {
					const c = (window as any).__coop;
					// @ts-ignore bare let-global
					const d = (typeof KDGameData !== 'undefined' && KDGameData) ? (KDGameData.CurrentDialog || '') : '';
					return !!c && !c.peerMissing && !d;
				},
				undefined, { timeout: 120_000 },
			);

			// The server agrees, and terminally so.
			expect(bridge.presence.state('B'), 'E6 — the seat is gone, not merely missing').toBe('gone');
			expect(bridge.session.players, 'E5 — one player remains').toEqual(['A']);
			expect(bridge.session.paused, 'and nothing is being waited for').toBe(false);

			// ---- D4/E5: the run KEEPS WORKING — the actual deliverable -------------------------------
			//
			// Not "the state looks tidy": the host presses a direction and a turn resolves, alone,
			// which is what "continue solo" has to mean.
			await A.evaluate(() => (window as any).__coop.sendMove(1, 0));
			await A.waitForFunction(
				(t) => {
					const c = (window as any).__coop;
					return !!c && c.lastTick != null && c.lastTick > (t as number);
				},
				tickBefore, { timeout: 120_000 },
			);
			const after = await hostView(A);
			expect(after.blocked, 'nothing is being refused any more').not.toBe('peer-missing');
			expect(after.lastTick, 'the turn counter moved on one player\'s input')
				.toBeGreaterThan(tickBefore as number);

			// N3 — and the departed avatar is not still standing in the rendered world.
			const ghost = await A.evaluate(() => {
				// @ts-ignore bare let-global
				return (KDMapData.Entities || []).filter((e: any) => e.CustomName === 'B').length;
			});
			expect(ghost, 'no avatar left behind for a player who has gone').toBe(0);

			// ---- the invariants ----------------------------------------------------------------------
			const sinceDrop = crashes.slice(crashesBefore);
			const dropped = sinceDrop.filter((c) => ASSET_NOISE.test(c));
			// eslint-disable-next-line no-console
			if (dropped.length) console.log(`[KDM-253] ignored ${dropped.length} pre-existing asset error(s): ${dropped[0]}`);
			expect(sinceDrop.filter((c) => !ASSET_NOISE.test(c)),
				'a teardown that trips KD\'s error handler is not graceful').toEqual([]);
		} finally {
			await ctxA.close().catch(() => {});
			await ctxB.close().catch(() => {});
			try { bridge.close(); } catch (e) { /* ignore */ }
			await new Promise((r) => server.close(r));
		}
	});
