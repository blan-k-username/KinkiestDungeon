/**
 * E2E — does restoring a peer's declared LOOK ever cost them their bondage state?
 *
 * `installPeerDressGuard` (`render-client.js`) re-asserts a peer avatar's declared appearance so
 * hair/body/face survive KD's own per-frame redress. It wraps `KinkyDungeonDressPlayer`, the SAME
 * function that layers a bound/restrained character's restraint items onto their model: the real
 * per-frame NPC sprite-draw (`KinkyDungeonEnemies.ts`) passes `KDGameData.NPCRestraints[enemy.id]`
 * into it, and `KDSetNPCRestraint`/`KDSetNPCRestraints` (what the stock "Tie Up" submenu calls to tie
 * a restraint onto any entity, including an avatar) arms `KDRefreshCharacter` for exactly that NPC —
 * the same flag whose gated rebuild is what calls `KDApplyItem` to lay a worn restraint's model onto
 * `Character.Appearance`. A guard that calls `CharacterAppearanceRestore` (a WHOLESALE
 * `Character.Appearance = declared`) AFTER that pass discards whatever it just laid down.
 *
 * ── WHY SINGLE-PAGE, NOT THE TWO-BROWSER SESSION ──────────────────────────────────────────────────
 * A real two-browser attempt was made first (co-op session, `KD_WEAR_RESTRAINT` + `KD_PVP=1`, several
 * real turns) to exercise `SwapSession._mirrorPeerBondage` (the mechanism that mirrors a PEER'S OWN
 * worn bondage onto their avatar as `boundLevel`/`specialBoundLevel`, locked by
 * `mp-avatar-bondage-type.spec.ts`). It measured `boundLevel: 0` on the avatar throughout, with or
 * without a declared look — `_mirrorPeerBondage` reconciles around PvP peer-arming on an ACTING
 * player's combat-relevant turn, not a passive `wait`, and reproducing that precisely was not worth
 * the cost at several minutes per attempt. This spec instead drives the OTHER, more direct mechanism
 * KD itself uses to show a bound NPC — `KDSetNPCRestraint`, the exact call the stock "Tie Up" submenu
 * makes on ANY entity — directly, in one page, the same way `mp-peer-appearance-render.spec.ts` drives
 * `KDQuickGenNPC` directly rather than booting a session to reach it. This is not a weaker proof of
 * the same mechanism: it is the SAME function (`KinkyDungeonDressPlayer`, armed by the SAME flag
 * `KDSetNPCRestraints` sets), reached directly instead of through a multi-minute live reconciliation
 * this project does not own.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 * The restraint is tied AFTER the declared appearance is already applied once, and a real
 * `KinkyDungeonDressPlayer` call (the exact signature the live sprite-draw uses, restraints included)
 * is driven afterward — so the BEFORE-fix failure mode (restraint item missing) can only be explained
 * by the guard, not by the restraint never having been tied. The CONTROL is an identical avatar with
 * NO declared appearance (the guard never touches it): it must show the SAME restraint item, proving
 * the probe itself can see one when nothing is suppressing it.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';

const TAPE = 'DuctTapeHands';
const SLOT = 'ItemHands';

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

async function genNPC(page: any, id: number) {
	await page.evaluate((id: number) => {
		// @ts-ignore
		const ent = KinkyDungeonFindID(id);
		// @ts-ignore
		KDQuickGenNPC(ent, true);
	}, id);
}

/**
 * Tie a restraint onto this avatar the way KD's OWN "Tie Up" submenu does — `KDSetNPCRestraint`,
 * which arms `KDRefreshCharacter` for its NPC (`KDSetNPCRestraints`, `KinkyDungeonEnemies.ts` — this
 * is not a fixture invented for the test, it is the stock call) — then drive one real
 * `KinkyDungeonDressPlayer` call with the EXACT signature the live sprite-draw uses, restraints
 * included, so the gated rebuild (`KDApplyItem` per worn item) actually runs once.
 */
async function tieAndRedress(page: any, id: number): Promise<any> {
	return page.evaluate(({ id, tape, slot }: { id: number; tape: string; slot: string }) => {
		/* eslint-disable */
		// @ts-nocheck
		// @ts-ignore
		const restraint = KinkyDungeonGetRestraintByName(tape);
		if (!restraint) return { tied: false, modelName: null, diag: 'no restraint def' };
		// @ts-ignore
		KDSetNPCRestraint(id, slot, restraint, true);
		// @ts-ignore
		const npc = KDNPCChar.get(id);
		if (!npc) return { tied: false, modelName: null, diag: 'no npc' };
		// @ts-ignore
		const npcRestraints = (typeof KDGetNPCRestraints === 'function') ? KDGetNPCRestraints(id) : undefined;
		// @ts-ignore
		const armedBefore = KDRefreshCharacter.get(npc);
		const lenBefore = (npc.Appearance || []).length;
		// The exact call `KinkyDungeonEnemies.ts`'s sprite-draw makes for a visible, restrained avatar.
		// @ts-ignore
		KinkyDungeonDressPlayer(npc, false, false, npcRestraints);
		const lenAfter = (npc.Appearance || []).length;
		// @ts-ignore
		const key = restraint.Model || restraint.Asset;
		// @ts-ignore
		const modelDef = (typeof ModelDefs !== 'undefined') ? ModelDefs[key] : undefined;
		const modelName = modelDef ? modelDef.Name : key;
		return {
			tied: true, modelName,
			diag: {
				armedBefore, lenBefore, lenAfter,
				npcRestraintsKeys: npcRestraints ? Object.keys(npcRestraints) : null,
				restraintArmor: restraint.armor || false,
				drawArmorToggle: (typeof KDToggles !== 'undefined') ? !!KDToggles.DrawArmor : null,
				modelKey: key, hasModelDef: !!modelDef,
				appearanceModels: (npc.Appearance || []).map((it: any) => it && it.Model && it.Model.Name),
			},
		};
	}, { id, tape: TAPE, slot: SLOT });
}

/** Does the generated NPC's CURRENT Appearance carry a model by this name? */
async function appearanceHasModel(page: any, id: number, modelName: string): Promise<boolean> {
	return page.evaluate(({ id, modelName }: { id: number; modelName: string }) => {
		// @ts-ignore
		const npc = KDNPCChar.get(id);
		if (!npc) return false;
		return (npc.Appearance || []).some((it: any) => it && it.Model && it.Model.Name === modelName);
	}, { id, modelName });
}

test.describe('a peer avatar keeps KD\'s own bondage rendering while a declared look is enforced', () => {
	test('a restraint tied onto the avatar survives the declared-appearance guard', async ({ isolatedPage }) => {
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
			return { wire: LZString.compressToBase64(sourceStringified) };
		});

		// ---- the DECLARED avatar — the guard is active for this one ---------------------------------
		const id = await plantPeerAvatar(isolatedPage, LABEL, DEF, built.wire);
		await genNPC(isolatedPage, id);
		await isolatedPage.evaluate(() => {
			// @ts-ignore
			(window as any).KDRenderClient.apply({ messages: { log: [] }, bundle: { v: 1, gameData: {}, globals: {} } });
		});
		const declaredTie = await tieAndRedress(isolatedPage, id);
		console.log('\n=== declaredTie diag ===\n' + JSON.stringify(declaredTie, null, 2) + '\n');
		expect(declaredTie.tied, 'precondition: the restraint def must resolve, or nothing here is real').toBe(true);
		expect(declaredTie.modelName, 'precondition: the restraint resolves to a real model name').toBeTruthy();

		// ---- CONTROL — an avatar that declared NOTHING, same tie, same redress ----------------------
		const plainId = await plantPeerAvatar(isolatedPage, LABEL_PLAIN, DEF_PLAIN);
		await genNPC(isolatedPage, plainId);
		const plainTie = await tieAndRedress(isolatedPage, plainId);
		console.log('\n=== plainTie diag ===\n' + JSON.stringify(plainTie, null, 2) + '\n');
		expect(plainTie.modelName, 'the same restraint, tied the same way, on the control avatar')
			.toBe(declaredTie.modelName);

		const plainHasRestraint = await appearanceHasModel(isolatedPage, plainId, plainTie.modelName!);
		expect(plainHasRestraint,
			'precondition: the probe can see a tied restraint at all, with no guard involved').toBe(true);

		// ---- AC — the DECLARED/guarded avatar must ALSO show the restraint ---------------------------
		const declaredHasRestraint = await appearanceHasModel(isolatedPage, id, declaredTie.modelName!);
		expect(declaredHasRestraint,
			'a peer\'s declared look must not cost them a restraint KD just tied onto their avatar')
			.toBe(true);
	});
});
