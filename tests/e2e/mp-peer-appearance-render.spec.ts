/**
 * E2E — a co-op partner's avatar is drawn with THEIR OWN look, not a random preset.
 *
 * The report: "players see each other differently of their appearance" — a player's own portrait
 * (hair, colour) never matched how their avatar appeared on their partner's screen.
 *
 * ── ROOT CAUSE ─────────────────────────────────────────────────────────────────────────────────────
 * `spawnAvatar` (`headless-host.js`) only ever carried `style` + `outfit` for the peer's look.
 * `style` is not a per-player choice: `KDQuickGenNPC` (`KinkyDungeonEnemies.ts` ~:11378-11391) uses it
 * to pick a hairstyle/bodystyle/facestyle at RANDOM out of a small preset table the first time the
 * avatar is drawn. Nothing carried the player's actual `Appearance` (their wardrobe), so every
 * avatar's look was a coin flip unrelated to its owner's own portrait.
 *
 * ── THE FIX ────────────────────────────────────────────────────────────────────────────────────────
 * `appearance` — the player's own `Appearance`, serialised exactly as KD's own wardrobe already
 * serialises a Collection NPC's `customOutfit` (`AppearanceItemStringify` + `LZString.compressToBase64`,
 * `KinkyDungeonCollection.ts` ~:514/:558) — now rides the same entity field channel as `style`/`outfit`
 * (`HeadlessHost.spawnAvatar` → `ENT_FIELDS` on both ends). `render-client.js`'s `applyPeerAppearances`
 * applies it onto the generated NPC with `CharacterAppearanceRestore`, the same KD-native call the
 * wardrobe's own revert path uses.
 *
 * ── WHY THIS SPEC, NEXT TO THE TWO-BROWSER CO-OP SUITE ────────────────────────────────────────────
 * Same reasoning as `mp-peer-name-dialogue.spec.ts`: the real two-browser flow is the integration
 * proof, but a co-op boot is minutes of two game bundles and a three-instance node host. This needs
 * neither a peer nor a server — it plants an avatar shaped exactly like `spawnAvatar`'s and drives KD's
 * OWN NPC-generation + appearance-restore calls directly.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 *  1. The BEFORE half really runs `KDQuickGenNPC` (force) the way the real draw path does, so the
 *     avatar has a REAL randomly-generated appearance before the fix is exercised — asserted to
 *     differ from the source, or the "after" half proves nothing.
 *  2. The AFTER half is asserted as the exact serialised VALUE (`AppearanceItemStringify` equality
 *     with the declared source), not as "some change happened" or "is no longer the default".
 *  3. CONTROL — an avatar with NO `appearance` field (the undeclared case) is left exactly as
 *     `KDQuickGenNPC` generated it: the fix must not touch a peer who declared nothing.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';

const LABEL = 'Player B';
const DEF = 'RemotePlayer_B';
const LABEL_PLAIN = 'Player Plain';
const DEF_PLAIN = 'RemotePlayer_Plain';

/** Plant an entity shaped like `spawnAvatar`'s, optionally carrying an `appearance` field. */
async function plantPeerAvatar(page: any, label: string, def: string, appearance?: string): Promise<number> {
	return page.evaluate(({ label, def, appearance }: { label: string; def: string; appearance?: string }) => {
		/* eslint-disable */
		// @ts-nocheck
		// @ts-ignore
		const base = KinkyDungeonGetEnemyByName('RemotePlayer') || KinkyDungeonGetEnemyByName('Dressmaker') || KinkyDungeonEnemies[0];
		// @ts-ignore
		let d = KinkyDungeonGetEnemyByName(def);
		if (!d) {
			d = Object.assign({}, base, {
				name: def, faction: 'Player', allied: true, ethereal: false,
				maxhp: 100, evasion: 0, armor: 0, followRange: 100, lowpriority: true, style: 'BlueHair',
			});
			// @ts-ignore
			KinkyDungeonEnemies.push(d);
			// @ts-ignore
			if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
		}
		// @ts-ignore
		addTextKey('Name' + def, label);

		// @ts-ignore
		const p = KinkyDungeonPlayerEntity;
		const ent: any = {
			// @ts-ignore
			id: KinkyDungeonGetEnemyID(), Enemy: d, x: p.x + 1, y: p.y, hp: 100,
			movePoints: 0, attackPoints: 0,
			CustomName: label, CustomNameColor: '#88bbff', style: 'BlueHair',
		};
		if (appearance) ent.appearance = appearance;
		// @ts-ignore
		KDAddNewEntity(ent);
		// @ts-ignore
		KDUpdateEnemyCache = true;
		return ent.id;
	}, { label, def, appearance });
}

/** A few real draw frames. */
async function frames(page: any, n = 15) {
	await page.evaluate((count: number) => new Promise<void>((res) => {
		let i = 0;
		const tick = () => (++i >= count ? res() : requestAnimationFrame(tick));
		requestAnimationFrame(tick);
	}), n);
}

/** Force KD's own lazy NPC generation for this entity — exactly what its first real draw does. */
async function genNPC(page: any, id: number) {
	await page.evaluate((id: number) => {
		// @ts-ignore
		const ent = KinkyDungeonFindID(id);
		// @ts-ignore
		KDQuickGenNPC(ent, true);
	}, id);
}

/** `AppearanceItemStringify` of the generated NPC's current Appearance, or null if none exists yet. */
async function npcAppearance(page: any, id: number): Promise<string | null> {
	return page.evaluate((id: number) => {
		// @ts-ignore
		const npc = KDNPCChar.get(id);
		if (!npc) return null;
		// @ts-ignore
		return AppearanceItemStringify(npc.Appearance);
	}, id);
}

test.describe('a co-op partner\'s avatar wears the partner\'s own look', () => {
	test('the avatar\'s generated NPC adopts the owner\'s OWN appearance, not the random default', async ({ isolatedPage }) => {
		await bootKD(isolatedPage);
		await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });

		// A real game, so `KinkyDungeonPlayer.Appearance` and `KDAddNewEntity` have something real to
		// work with — the same precondition `mp-peer-name-dialogue.spec.ts` sets up per-avatar.
		await isolatedPage.evaluate(() => {
			// @ts-ignore
			KinkyDungeonStartNewGame(false);
			// @ts-ignore
			KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
		});

		// A distinct, KD-valid appearance to declare as "the peer's own look": the LIVE player's real
		// Appearance, recoloured — guaranteed different from both KD's random preset generation and the
		// unmodified player, so a match below cannot be a coincidence.
		const built = await isolatedPage.evaluate(() => {
			// @ts-ignore
			const mine = JSON.parse(JSON.stringify(KinkyDungeonPlayer.Appearance));
			if (mine[0]) mine[0].Color = (mine[0].Color === '#FF8000') ? '#2244AA' : '#FF8000';
			// @ts-ignore
			const sourceStringified = AppearanceItemStringify(mine);
			// @ts-ignore
			const wire = LZString.compressToBase64(sourceStringified);
			return { sourceStringified, wire };
		});
		expect(built.wire.length, 'precondition: a real appearance produces a non-empty wire blob')
			.toBeGreaterThan(0);

		const id = await plantPeerAvatar(isolatedPage, LABEL, DEF, built.wire);

		// ---- BEFORE — the defect, reproduced on this page: a real random generation, unrelated to
		// the declared appearance (precondition the whole spec rests on).
		await genNPC(isolatedPage, id);
		const before = await npcAppearance(isolatedPage, id);
		expect(before, 'precondition: KDQuickGenNPC really generated something').toBeTruthy();
		expect(before, 'precondition: the random preset must not already match the declared appearance '
			+ '— otherwise the fix below proves nothing').not.toBe(built.sourceStringified);

		// ---- the fix, installed by the client's own apply() — as it runs in production -------------
		// Applied and read back in the SAME evaluate: the page's own draw loop keeps ticking via rAF
		// between separate evaluate() round-trips and (harmlessly, per KD's own per-frame NPC-sprite
		// dressing) can re-derive the avatar's CLOTHING slots before a second round-trip gets to read
		// them — a timing artefact of this single-page harness, not of the fix. Reading atomically
		// with the write is what `appearance` actually guarantees: the restore itself is exact.
		const after = await isolatedPage.evaluate((id: number) => {
			// @ts-ignore
			(window as any).KDRenderClient.apply({ messages: { log: [] }, bundle: { v: 1, gameData: {}, globals: {} } });
			// @ts-ignore
			const npc = KDNPCChar.get(id);
			// @ts-ignore
			return npc ? AppearanceItemStringify(npc.Appearance) : null;
		}, id);
		expect(after, 'the avatar now looks exactly like its owner declared, not like the random preset')
			.toBe(built.sourceStringified);

		// ---- CONTROL — an avatar that declared NOTHING is never touched by `applyPeerAppearances` ----
		// Same atomicity reasoning as the AC above: generate, apply and read in ONE evaluate, so the
		// page's own per-frame NPC redraw cannot be mistaken for a change OUR code made.
		const plainId = await plantPeerAvatar(isolatedPage, LABEL_PLAIN, DEF_PLAIN);
		const plain = await isolatedPage.evaluate((id: number) => {
			// @ts-ignore
			const ent = KinkyDungeonFindID(id);
			// @ts-ignore
			KDQuickGenNPC(ent, true);
			// @ts-ignore
			const npcBefore = KDNPCChar.get(id);
			// @ts-ignore
			const before = AppearanceItemStringify(JSON.parse(JSON.stringify(npcBefore.Appearance)));
			// @ts-ignore
			(window as any).KDRenderClient.apply({ messages: { log: [] }, bundle: { v: 1, gameData: {}, globals: {} } });
			// @ts-ignore
			const npcAfter = KDNPCChar.get(id);
			// @ts-ignore
			return { before, after: AppearanceItemStringify(npcAfter.Appearance), sameObject: npcBefore === npcAfter };
		}, plainId);
		expect(plain.sameObject, 'precondition: no (re)generation happened between the two reads').toBe(true);
		expect(plain.after, 'an undeclared peer\'s appearance is never rewritten by our code')
			.toBe(plain.before);
	});

	/*
	 * ── THE RESTORE MUST BE STABLE ACROSS REAL FRAMES, NOT A ONE-SHOT ────────────────────────────────
	 * `after` above reads in the SAME evaluate as the write, on purpose (documented there as a
	 * necessary precaution against a timing artefact). This test is the other half: read in a
	 * SEPARATE round-trip, after several more real draw frames have run, with KD's own per-frame NPC
	 * sprite-draw ticking the whole time. If the restored look is only ever correct for the instant it
	 * was written, a real co-op session — where a player keeps drawing every frame, forever — would
	 * show the DEFECT again a moment later.
	 */
	test('the restored appearance survives further real draw frames, not just the instant of the write', async ({ isolatedPage }) => {
		await bootKD(isolatedPage);
		await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });
		await isolatedPage.evaluate(() => {
			// @ts-ignore
			KinkyDungeonStartNewGame(false);
			// @ts-ignore
			KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';
		});

		const built = await isolatedPage.evaluate(() => {
			// @ts-ignore
			const mine = JSON.parse(JSON.stringify(KinkyDungeonPlayer.Appearance));
			if (mine[0]) mine[0].Color = (mine[0].Color === '#FF8000') ? '#2244AA' : '#FF8000';
			// @ts-ignore
			const sourceStringified = AppearanceItemStringify(mine);
			// @ts-ignore
			return { sourceStringified, wire: LZString.compressToBase64(sourceStringified) };
		});
		const id = await plantPeerAvatar(isolatedPage, LABEL, DEF, built.wire);
		await genNPC(isolatedPage, id);

		// the fix, applied — same production call as the AC above, but this time NOT read atomically.
		await isolatedPage.evaluate(() => {
			// @ts-ignore
			(window as any).KDRenderClient.apply({ messages: { log: [] }, bundle: { v: 1, gameData: {}, globals: {} } });
		});

		// several more real frames — the window the real co-op flow never closes.
		await frames(isolatedPage, 15);

		const stillAfter = await npcAppearance(isolatedPage, id);
		expect(stillAfter, 'the restored look must not be clobbered by KD\'s own later per-frame redraw')
			.toBe(built.sourceStringified);
	});
});
