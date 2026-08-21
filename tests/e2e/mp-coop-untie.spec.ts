/**
 * E2E (KDM-231) — untying your co-op partner, in TWO BROWSERS, over real turns.
 *
 * The unit spec (`tests/unit/mp-coop-untie.spec.ts`) drives the same flow through `submit`, which is
 * honest about the input path but single-process: one node host holds both bundles, and "the victim
 * sees it" is an inference. This is the half that cannot be inferred — A is a browser, B is a
 * DIFFERENT browser, and what B is wearing is read off B's own page.
 *
 * Three claims, in one session because a co-op boot is the expensive part (two full game bundles plus
 * a node host running three headless instances — see `helpers/coop.ts`):
 *
 *   AC1  A can reach the untie through KD's REAL context menu on the peer's tile.
 *   AC4  the flow draws no unresolved text key — no "[NotFound] …" in front of the player.
 *   AC2  the untie reaches B's OWN restraints, observed on B's page.
 *   AC3  and once A starts a war, the way in is shut.
 *
 * The controls are in-session rather than a second boot: opening the dialogue WITHOUT picking Untie
 * is the same shape as picking it and must change nothing, and the text-key recorder is proved to
 * fire by asking it for a tag that cannot exist.
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar, coopPos,
	contextMenuAt, pickMenuOption,
	recordDrawnText, readDrawnText, restoreDrawnText, paintMissingTextKey,
} from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

const TAPE = 'DuctTapeHands';

/** What B is really wearing, read from B's OWN page — the two-browser half of AC2. */
async function wornOn(P: any) {
	return P.evaluate(() => {
		// @ts-ignore bare let-global
		return KinkyDungeonAllRestraint().map((r: any) => ({
			name: r.name, struggleProgress: r.struggleProgress || 0,
		}));
	});
}

/** The dialogue this page currently has open, and the option keys KD would render for it. */
async function openDialogue(P: any) {
	return P.evaluate(() => {
		// @ts-ignore bare let-globals
		const cur = KDGameData.CurrentDialog || null;
		// @ts-ignore
		const d = cur ? (KDDialogue as any)[cur] : null;
		let offered: string[] = [];
		if (d && d.options) {
			// The prerequisite filter the draw applies before a button exists at all
			// (KinkyDungeonDialogue.ts:169).
			offered = Object.entries(d.options)
				// @ts-ignore
				.filter(([, o]) => KDCheckDialoguePrereq(o, KDDialogueGagged(), KDPlayer()))
				.map(([k]) => k);
		}
		return {
			dialogue: cur,
			// @ts-ignore
			stage: KDGameData.CurrentDialogStage || '',
			// @ts-ignore
			speaker: KDGameData.CurrentDialogMsgSpeaker || null,
			// @ts-ignore
			bindAmt: String((KDGameData.CurrentDialogMsgValue || {}).BINDAMNT),
			offered,
		};
	});
}

test('a co-op player unties their partner: menu → dialogue → the partner\'s own restraints', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	// Both players start wearing tape, so B is worth untying without any setup input being spent.
	process.env.KD_WEAR_RESTRAINT = TAPE;
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);
		const peer = await waitForPeerAvatar(A, { label: 'A looking for the partner to untie' });

		// ---- 0. preconditions, read on the pages that own them ----------------------------------
		expect(await wornOn(B), 'precondition: B is bound, on B\'s OWN page')
			.toEqual([{ name: TAPE, struggleProgress: 0 }]);
		const aPos = await coopPos(A);
		expect(Math.max(Math.abs(peer.x - aPos.x), Math.abs(peer.y - aPos.y)),
			'precondition: the pair spawn adjacent, so the peer is reachable without walking').toBe(1);

		// ---- 1. AC1 — the real context menu on the PEER's tile offers Talk ----------------------
		//
		// The peer's tile, not the player's own: this branch is behind a vision gate that headless
		// tests cannot pass (measured — the whole entity branch disappears), which is exactly why this
		// assertion has to live in a browser.
		const menu = await contextMenuAt(A, { x: peer.x, y: peer.y });
		expect(menu.aimed, 'precondition: the menu is aimed at the peer\'s tile').toEqual(menu.at);
		expect(menu.entity, 'precondition: the peer entity is the one standing there').not.toBeNull();
		expect(menu.entity!.name).toMatch(/^RemotePlayer/);
		expect(menu.entity!.allied, 'a co-op partner is an ally').toBe(true);
		expect(menu.entity!.talkable, 'AC1: KDTalkToEnemy is what puts Talk on the menu').toBe(true);
		expect(menu.options, 'AC1: the way in is KD\'s own Talk entry').toContain('Talk');
		expect(menu.options, 'and at peace the hostile branch is not offered').not.toContain('Attack');

		// ---- 2. AC4 — record every string the flow PAINTS, from here on -------------------------
		await recordDrawnText(A);
		// …and prove the recorder can fail. Painting a key that cannot resolve must show up as
		// unresolved; without this, "nothing unresolved" is a green a dead recorder produces too.
		const probe = await paintMissingTextKey(A, 'KDM231ThisKeyDoesNotExist');
		expect(probe, 'precondition: an unknown key resolves to the placeholder a player would read')
			.toContain('[NotFound]');
		expect((await readDrawnText(A)).unresolved,
			'the recorder must be able to SEE an unresolved key being painted').toContain(probe);

		// ---- 3. Talk → KD's ally dialogue opens on the partner -----------------------------------
		//
		// Goes through the menu callback, which sends `KDSendInput("talk", …)` — routed to the server
		// like every other input (render-client.js). B waits so the turn can resolve.
		await pickMenuOption(A, 'Talk');
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		// @ts-ignore bare let-global
		await A.waitForFunction(() => KDGameData.CurrentDialog === 'GenericAlly',
			undefined, { timeout: 60_000 });
		await A.waitForTimeout(1500);   // let the snapshots that follow land on top of it

		const dlg = await openDialogue(A);
		expect(dlg.speaker, 'the partner\'s own avatar def is the speaker').toMatch(/^RemotePlayer/);
		expect(dlg.offered, 'AC1: Untie is offered on a bound partner').toContain('Untie');
		expect(Number(dlg.bindAmt), 'with a real budget behind it').toBeGreaterThan(0);

		// ---- 3b. CONTROL — opening the dialogue is not yet an untie ------------------------------
		// Same shape as the step that follows, one option short of it. Without this, "B ended up freer
		// after two dialogue turns" would also pass if merely TALKING to a peer loosened them.
		expect(await wornOn(B), 'opening the dialogue must change nothing about B')
			.toEqual([{ name: TAPE, struggleProgress: 0 }]);

		// ---- 4. AC2 — A picks Untie; B's OWN restraints change -----------------------------------
		//
		// This is exactly what the drawn button sends (KinkyDungeonDialogue.ts:191): the dialogue, the
		// stage, `click`, and the speaker's entity id. Clicking the pixel would add nothing but a
		// coordinate that KD's own layout owns.
		await A.evaluate((id: number) => {
			const w = window as any;
			if (w.__coop) w.__coop.submitted = false;
			// @ts-ignore bare let-global
			KDSendInput('dialogue', { dialogue: 'GenericAlly', dialogueStage: 'Untie', click: true, enemy: id });
		}, peer.id);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));

		// Wait on the THING BEING ASSERTED — B's own worn state — not on a tick that only proxies it.
		await B.waitForFunction(() => {
			// @ts-ignore bare let-global
			const worn = KinkyDungeonAllRestraint();
			return worn.length === 0 || (worn[0] && (worn[0].struggleProgress || 0) > 0);
		}, undefined, { timeout: 60_000 }).catch(() => { /* asserted below with a readable message */ });

		const afterB = await wornOn(B);
		const freed = afterB.length === 0;
		const progressed = afterB.length > 0 && afterB[0].struggleProgress > 0;
		expect(freed || progressed,
			`AC2: B's own browser must show the untie — got ${JSON.stringify(afterB)}`).toBe(true);

		// ---- 5. AC4 — nothing the player READ was an unresolved key ------------------------------
		const drawn = await readDrawnText(A);
		expect(drawn.truncated,
			'the distinct-text cap was hit, so later strings went unwatched — raise it rather than '
			+ 'trusting this assertion').toBe(false);
		expect(drawn.unresolved.filter((t) => t !== probe),
			'AC4: the untie flow must paint no "[NotFound] …" in front of the player').toEqual([]);

		// …and the recorder was watching THIS flow, not an idle page. The three strings KDDrawDialogue
		// paints for it are the body, the option label and the speaker's display name — the last being
		// the family that shipped broken twice ("[NotFound] KillRemotePlayer_…"). Matched by their
		// RESOLVED text, since that is what a painted string is.
		const expected = await A.evaluate((speaker: string) => ({
			// @ts-ignore bare let-global
			body: TextGet('rGenericAlly'), option: TextGet('dGenericAllyUntie'), name: TextGet('Name' + speaker),
		}), dlg.speaker);
		expect(expected.name, 'precondition: the partner\'s name key resolves at all')
			.not.toContain('[NotFound]');
		for (const [what, text] of Object.entries(expected)) {
			// A painted line is the TEMPLATE after substitution, so match on the prefix that survives it.
			// The cut list mirrors what the draw itself rewrites (`KinkyDungeonDialogue.ts:131-176`):
			// the `CurrentDialogMsgData` placeholders, and KD's own redundant-article removal, which
			// deletes the "the " in front of SPEAKER whenever the speaker counts as named.
			const needle = String(text).split(/\b(?:[Aa]|[Tt]he)\s+SPEAKER|SPEAKER|BINDAMNT|UNTIETURNS|\||\n/)[0].trim();
			expect(needle.length, `precondition: "${what}" has a stable prefix to match on`).toBeGreaterThan(3);
			expect(drawn.texts.some((t) => t.indexOf(needle) >= 0),
				`the dialogue's ${what} was painted — otherwise AC4 passed over a flow that never drew. `
				+ `Looked for ${JSON.stringify(needle)} in ${JSON.stringify(drawn.texts)}`)
				.toBe(true);
		}

		// ---- 5b. AC1 of KDM-232 — the body NAMES the partner -------------------------------------
		//
		// This used to be pinned as a known defect: the line came out `"(You approach )"`, naming
		// nobody. `spawnAvatar` gives the avatar a `CustomName` so the client draws a name plate, and
		// `KDDrawDialogue` (`KinkyDungeonDialogue.ts:142-146`) reads that as "this speaker is NAMED",
		// which sends it to `KDGetName(id)` instead of the `Name<def>` key — and `KDGetName`
		// (`KinkyDungeonEnemies.ts:2446`) answers "" for anything neither in `KDGameData.Collection`
		// nor a persistent NPC. Fixed in `render-client.js` by restoring the `CustomName` fallback KD
		// itself uses in `KDEnemyName` (`:2437`); the mechanism and its blast-radius controls live in
		// `tests/e2e/mp-peer-name-dialogue.spec.ts`, which needs no co-op boot.
		//
		// Asserted as a VALUE, not as the absence of a blank: an absence oracle would read green just
		// as happily if the body had stopped being painted at all. And the expected name comes from
		// the REGISTERED text key (`expected.name`, resolved above from `Name<def>` — which the server
		// derives from the join label), NOT from the entity's `CustomName`. That matters: `CustomName`
		// is the field the fix reads, so expecting it here would be the fix checking its own homework.
		// Two independently-sourced spellings of the partner's name must agree.
		const body = drawn.texts.find((t) => t.indexOf('(You approach') >= 0);
		expect(body, 'the ally-dialogue body was painted').toBeTruthy();
		expect(body, 'KDM-232 AC1: the one line that names your partner must name them')
			.toBe(`(You approach ${expected.name})`);

		// ---- 6. AC3 — start a war and the way in is shut ----------------------------------------
		//
		// The same menu, the same tile, the same partner: only hostility changes. Asserted here rather
		// than in a second session, because a co-op boot is the expensive part of this spec.
		await restoreDrawnText(A);
		await A.evaluate((id: number) => {
			const w = window as any;
			// @ts-ignore
			const p = ((KDMapData as any).Entities || []).find((x: any) => x.id === id);
			if (w.__coop) w.__coop.submitted = false;
			// @ts-ignore — KD's own aggro input, the one the Aggro menu entry sends
			KDSendInput('doaggro', { tx: p.x, ty: p.y, id: p.id, unaware: true, aggroothers: false });
		}, peer.id);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!(c && c.war && c.war.length > 0);
		}, undefined, { timeout: 60_000 });

		const atWar = await waitForPeerAvatar(A, { label: 'A after starting the war' });
		const warMenu = await contextMenuAt(A, { x: atWar.x, y: atWar.y });
		expect(warMenu.aimed, 'precondition: still aimed at the peer').toEqual(warMenu.at);
		expect(warMenu.entity, 'precondition: the peer is still standing there').not.toBeNull();
		expect(warMenu.entity!.aggressive, 'precondition: the sneak really started a war').toBe(true);
		expect(warMenu.entity!.talkable, 'AC3: KDTalkToEnemy shuts the only way to the untie').toBe(false);
		expect(warMenu.options, 'AC3: no Talk at war, so no dialogue and no Untie').not.toContain('Talk');
	} finally {
		await restoreDrawnText(A).catch(() => { /* page may be gone */ });
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
		delete process.env.KD_WEAR_RESTRAINT;
	}
});
