/**
 * E2E (KDM-225) — the peace handshake through KD's REAL context menu, in two browsers.
 *
 * The user-observable half of the feature, so `TESTING_POLICY.md` requires it. It drives the same
 * surface a player does — `KDGetContextActions.Game`, the builder a right-click runs — rather than a
 * synthetic action, which is the precedent set by `mp-pvp-menu-attack.spec.ts`.
 *
 * The design under test (KDM-225 D8): the offer and the answer both live on the player's OWN tile.
 * That is what makes this reachable at all — measured in `mp-peace-menu-gate-probe.spec.ts`, the
 * peer's menu is behind a hostility gate AND a vision gate, and the player's own menu is behind
 * neither (`KDContextMenu.ts:293`, the `entity == KDPlayer()` branch).
 */
import { test, expect } from '@playwright/test';
import {
	bootCoopPair, MP_TEST_TIMEOUT, waitForPeerAvatar, contextMenuAt, pickMenuOption,
} from './helpers/coop';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../../tools/mp-server/demo-server');

/**
 * Build KD's real context menu on the player's OWN tile, plus the one verdict only this spec cares
 * about: whether the peace wrap is installed on the registry entry.
 *
 * The aiming and the build live in `contextMenuAt` (helpers/coop.ts) — three specs had grown their
 * own copy of the same eight lines, and the pixel conversion is the part that is easy to get subtly
 * wrong. Kept here: `wrapped`, because the peace sentinel is this feature's business and does not
 * belong on a shared primitive.
 */
async function ownMenu(P: any) {
	const me = await P.evaluate(() => {
		// @ts-ignore bare let-global
		const p = KDPlayer();
		return { x: p.x, y: p.y };
	});
	const menu = await contextMenuAt(P, me);
	const wrapped = await P.evaluate(() =>
		// @ts-ignore — the peace entries are added by a cooperative wrap AROUND KDGetContextActions.Game,
		// so `KDGetGameContextActionsVanilla` never sees them. (Measured: vanilla returned
		// ["Wait","Inventory","Special"] with the wrap installed and working.)
		!!(KDGetContextActions.Game as any)._kdcoop_peace_wrapped);
	return { ...menu, ok: true, wrapped };
}

/** Does this client believe it is at war with the peer? Read from the standing snapshot state (A4). */
async function atWar(P: any) {
	return P.evaluate(() => {
		const w = window as any;
		const coop = w.KDRenderClient && w.KDRenderClient.lastCoop;
		return !!(coop && coop.war && coop.war.length > 0);
	});
}

test('offer peace from your own menu; the peer accepts from theirs', async ({ browser }) => {
	test.setTimeout(MP_TEST_TIMEOUT);
	// CO-OP start (no KD_PVP) — war has to be STARTED by an attack, as in the UAT that prompted this.
	const { server, bridge, port } = await start(0);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const A = await ctxA.newPage();
	const B = await ctxB.newPage();

	try {
		await bootCoopPair(A, B, port);

		// ---- 1. no war yet → neither player is offered peace (R2) -------------------------------
		const peaceBeforeWar = await ownMenu(A);
		expect(peaceBeforeWar.ok, JSON.stringify(peaceBeforeWar)).toBe(true);
		expect(peaceBeforeWar.wrapped, 'precondition: the context-menu wrap is installed').toBe(true);
		expect(peaceBeforeWar.aimed, 'precondition: the menu is aimed at the player\'s own tile')
			.toEqual(peaceBeforeWar.at);
		expect(peaceBeforeWar.options,
			'R2: with nobody to make peace with, the entry must not be there').not.toContain('Peace');

		// ---- 2. A sneak-attacks B → war ---------------------------------------------------------
		const peer = await waitForPeerAvatar(A, { label: 'A starting the war' });
		await A.evaluate((id: number) => {
			const w = window as any;
			// @ts-ignore
			const p = ((KDMapData as any).Entities || []).find((x: any) => x.id === id);
			if (w.__coop) w.__coop.submitted = false;
			// @ts-ignore — KD's own aggro input, the one the Aggro menu option sends
			KDSendInput('doaggro', { tx: p.x, ty: p.y, id: p.id, unaware: true, aggroothers: false });
		}, peer.id);
		await B.evaluate(() => (window as any).__coop.sendAction({ kind: 'wait' }));
		await A.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!(c && c.war && c.war.length > 0);
		}, undefined, { timeout: 60_000 });
		expect(await atWar(A), 'precondition: the sneak started PvP').toBe(true);

		// ---- 3. A's own menu now offers Peace (R1) ----------------------------------------------
		const armed = await ownMenu(A);
		expect(armed.options,
			'R1/D8: at war, the offer lives on your OWN tile — no adjacency, no line of sight')
			.toContain('Peace');

		// ---- 4. A offers; nothing about the war changes yet (R4) --------------------------------
		await pickMenuOption(A, 'Peace');
		await B.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!(c && c.peaceOffer);
		}, undefined, { timeout: 60_000 });
		expect(await atWar(A), 'R4: an offer is not a truce').toBe(true);

		// ---- 5. A cannot ask twice while it is unanswered (R3) ----------------------------------
		const asked = await ownMenu(A);
		expect(asked.options, 'R3: you already asked').not.toContain('Peace');

		// ---- 5b. B is REFUSED, not queued — and knows it ----------------------------------------
		//
		// UAT bug: a blocked submit came back as `waiting`, which is the client's signal that its
		// input entered lockstep. The client then set `submitted = true` and suppressed every further
		// input — so the player could not reach the one action that would unblock them. Every key and
		// click did nothing while the overlay read "your move — others ready".
		const refused = await B.evaluate(async () => {
			const w = window as any;
			w.__coop.submitted = false;
			w.__coop.blocked = null;
			w.__coop.sendAction({ kind: 'wait' });
			await new Promise((r) => setTimeout(r, 1500));
			return { submitted: w.__coop.submitted, blocked: w.__coop.blocked };
		});
		expect(refused.blocked, 'the refusal must reach the client as a refusal').toBe('peace-offer');
		expect(refused.submitted,
			'a refused action must NOT mark the client as having acted — that is the soft-lock')
			.toBe(false);

		// ---- 6. the offer arrives as KD's own modal DIALOGUE (KDM-230) ---------------------------
		//
		// Opened server-side on B's bundle, so it reaches the client as ordinary adopted state. A
		// client-side dialogue would be erased by the very next snapshot — and the offer triggers one
		// immediately — which is why this asserts it is still open after a settle, not just present
		// for an instant.
		//
		// NOTE: bare identifiers, NOT `window.X`. The bundle's top-level `let` globals live in the
		// global LEXICAL environment and are not properties of `window`; reading one off `window`
		// yields undefined forever, a timeout that looks exactly like a broken feature.
		// @ts-ignore bare let-global
		await B.waitForFunction(() => KDGameData.CurrentDialog === 'KDCoopPeace',
			undefined, { timeout: 30_000 });
		await B.waitForTimeout(1500);   // let a few more snapshots land on top of it
		const dlg = await B.evaluate(() => {
			// @ts-ignore
			const speaker = KDGetSpeaker ? KDGetSpeaker() : null;
			// @ts-ignore — the option keys KD will render as buttons
			const opts = Object.keys((KDDialogue.KDCoopPeace || {}).options || {});
			return {
				// @ts-ignore
				open: KDGameData.CurrentDialog, stage: KDGameData.CurrentDialogStage,
				options: opts,
				// The three text keys the dialogue draws. A missing one prints "[NotFound] …" at the
				// player — the failure this epic shipped twice.
				// @ts-ignore
				body: TextGet('rKDCoopPeaceOffer'),
				// @ts-ignore
				accept: TextGet('dKDCoopPeace_Accept'),
				// @ts-ignore
				refuse: TextGet('dKDCoopPeace_Refuse'),
				speaker: speaker ? speaker.Enemy.name : null,
			};
		});
		expect(dlg.open, 'the dialogue must SURVIVE the snapshots that follow the offer')
			.toBe('KDCoopPeace');
		expect(dlg.options, 'both answers are options of the dialogue itself').toEqual(['Accept', 'Refuse']);
		for (const [k, v] of Object.entries({ body: dlg.body, accept: dlg.accept, refuse: dlg.refuse })) {
			expect(String(v), `text key for "${k}" must resolve`).not.toContain('NotFound');
			expect(String(v).length, `text key for "${k}" must not be empty`).toBeGreaterThan(0);
		}

		// …and the answer is NOT on the context menu any more (KDM-230 AC4).
		const bMenu = await ownMenu(B);
		expect(bMenu.options, 'the submenu entries are gone — the dialogue owns the answer')
			.not.toContain('PeaceAccept');

		// ---- 7. B accepts through the dialogue → both sides at peace (R6/AC3) --------------------
		//
		// Clicking an option runs `KDSendInput("dialogue", …)` (KinkyDungeonDialogue.ts:187), so this
		// sends exactly what the button sends — a routed GAME input, not a private verb.
		await B.evaluate(() => {
			const w = window as any;
			if (w.__coop) w.__coop.submitted = false;
			// @ts-ignore
			KDSendInput('dialogue', { dialogue: 'KDCoopPeace', dialogueStage: 'Accept', click: true });
		});
		await A.waitForFunction(() => {
			const c = (window as any).KDRenderClient && (window as any).KDRenderClient.lastCoop;
			return !!c && (!c.war || c.war.length === 0);
		}, undefined, { timeout: 60_000 });
		expect(await atWar(A), 'A sees peace').toBe(false);
		expect(await atWar(B), 'and so does B — no split verdict').toBe(false);

		// …and the dialogue is closed on B, not left hanging over a settled question.
		// @ts-ignore bare let-global
		await B.waitForFunction(() => KDGameData.CurrentDialog !== 'KDCoopPeace',
			undefined, { timeout: 30_000 });

		// ---- 8. and the entry is gone again (R2) -------------------------------------------------
		const atPeace = await ownMenu(A);
		expect(atPeace.options, 'nothing left to offer').not.toContain('Peace');

		// ---- 9. the peer is a FRIENDLY NPC again, not a target (UAT round 4) ---------------------
		//
		// Owner: "i still can attack. in peace (at the very beginning) i need 'sneak attack' to
		// activate pvp. also, peace mode should allow players to help each other to free."
		//
		// Both are the same requirement: after a truce the peer must read to KD exactly as a friendly
		// NPC does. KD's context menu says which it thinks: `KDTalkToEnemy` true gives the ally branch
		// (Talk + Aggro, where Aggro is the deliberate sneak that RE-starts PvP), and false gives the
		// hostile branch (Attack / Tease / Capture). The screenshot showed "Attack", so the peer was
		// still an enemy to the game after peace.
		//
		// Asserted on the PEER's tile — the vision gate that hides this headless is real in a browser,
		// which is why this lives in the e2e (see mp-pvp-menu-attack.spec.ts for the same technique).
		const peerNow = await waitForPeerAvatar(A, { label: 'A checking the peer after the truce' });
		const peerMenuAtPeace = await contextMenuAt(A, { x: peerNow.x, y: peerNow.y });

		expect(peerMenuAtPeace.aimed, 'precondition: the menu is aimed at the peer')
			.toEqual(peerMenuAtPeace.at);
		expect(peerMenuAtPeace.entity, 'precondition: the peer is the entity on that tile').not.toBeNull();
		expect(peerMenuAtPeace.entity!.faction, 'the Enemy stamp must be gone from the world entity')
			.not.toBe('Enemy');
		expect(peerMenuAtPeace.entity!.hostile, 'and KD must not consider them hostile').toBe(false);
		expect(peerMenuAtPeace.entity!.talkable,
			'a peaceful peer must be talkable — that is what makes them a friendly NPC, and what the '
			+ '"help me get free" interactions need (KDM-231 builds on exactly this)').toBe(true);
		expect(peerMenuAtPeace.options,
			'attacking must take the deliberate sneak again, exactly as at the start of a co-op session')
			.toContain('Aggro');
		expect(peerMenuAtPeace.options,
			'and the direct hostile Attack must NOT be offered at peace').not.toContain('Attack');
	} finally {
		await ctxA.close().catch(() => {});
		await ctxB.close().catch(() => {});
		try { bridge.close(); } catch (e) { /* ignore */ }
		await new Promise((r) => server.close(r));
	}
});
