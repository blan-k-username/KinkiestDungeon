/**
 * E2E (KDM-232) — a co-op partner's avatar NAMES ITSELF in the ally dialogue.
 *
 * The bug: the one line that names your partner named nobody — `"(You approach )"`.
 *
 * `spawnAvatar` (`headless-host.js:1236`) stamps `CustomName` on the peer entity so the client draws
 * a full character rather than an HP bar. `KDDrawDialogue` (`KinkyDungeonDialogue.ts:142-146`) reads
 * that field as a PREDICATE — "this speaker is named" — and then resolves the display name through
 * `KDGetName(id)` **alone**, with none of the fallback KD itself uses everywhere else
 * (`KDEnemyName`, `:2437`: `CustomName || KDGetName(id) || TextGet("Name" + …)`). `KDGetName`
 * (`:2446`) answers `""` for anything that is neither in `KDGameData.Collection` nor a persistent
 * NPC, and a live player's avatar is neither. Being "named" ALSO strips the redundant article, so
 * `"(You approach the SPEAKER)"` collapsed to `"(You approach )"` rather than `"(You approach the )"`.
 *
 * The fix restores that fallback at the one function missing it, as a cooperative wrap in
 * `render-client.js`. Why not the alternatives — `KDGameData.Collection` injection (185 references,
 * 16 of them whole-collection sweeps: it would make a live player capturable), dropping `CustomName`
 * (it is what selects the NPC-sprite branch, `KinkyDungeonEnemies.ts:1042`), or `alwaysEnemyTypeName`
 * (a property of the SHARED stock `GenericAlly` dialogue) — is recorded in KDM-232's Assessment.
 *
 * ── WHAT THIS SPEC IS FOR, next to `mp-coop-untie` ────────────────────────────────────────────────
 * The two-browser co-op spec proves the fix in the real product flow, but a co-op boot is ~4 minutes
 * of two game bundles and a three-instance node host. This one needs neither a peer nor a server: it
 * plants an avatar shaped exactly like `spawnAvatar`'s and drives KD's OWN dialogue draw. So the
 * mechanism has a cheap, deterministic home, and the expensive spec stays the integration proof.
 *
 * ── WHY IT IS NOT A VACUOUS GREEN ─────────────────────────────────────────────────────────────────
 * Three things guard it, and each can fail independently:
 *
 *  1. The BEFORE half is measured on this very page, before the wrap is installed. It must reproduce
 *     the defect verbatim (`"(You approach )"`). If it ever stops doing so, the fixed half is proving
 *     nothing and this spec says so instead of passing.
 *  2. The answer is asserted as a VALUE — the whole painted line — not as the ABSENCE of a blank. An
 *     absence oracle reads green just as happily when the body stops being painted at all.
 *  3. Two CONTROLS pin the blast radius, which is the actual risk in wrapping a getter KD calls from
 *     many places: an entity WITHOUT `CustomName` must still answer `""`, and a `Collection` entry
 *     must still WIN over `CustomName`. The wrap may only ever turn `""` into a name.
 *
 * KDM-216 — `isolatedPage`, not `kdPage`: this spec injects render-client.js, whose wrappers a
 * resetKDState() cannot undo.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { bootKD } from '../helpers/bundle';
import { recordDrawnText, readDrawnText, restoreDrawnText } from './helpers/coop';

/** What `swap-session.js:291` labels a peer: `'Player ' + id`. */
const LABEL = 'Player B';
/** The per-peer def name `spawnAvatar` builds, and which `Name<def>` is registered against. */
const DEF = 'RemotePlayer_B';

/**
 * Plant an entity shaped exactly like `spawnAvatar`'s, on the live map.
 *
 * Deliberately NOT via `KDRenderClient.apply({map})`: that adopts a whole authoritative KDMapData and
 * would drag a map fixture into a spec about a name. The fields below are the ones `spawnAvatar`
 * actually sets (`headless-host.js:1226-1239`) — including `CustomNameColor`, whose absence crashes
 * the HP/name draw on `string2hex` (`KinkyDungeonEnemies.ts:2356`).
 */
async function plantPeerAvatar(page: any, label: string, def: string): Promise<number> {
	return page.evaluate(({ label, def }: { label: string; def: string }) => {
		/* eslint-disable */
		// @ts-nocheck
		// @ts-ignore bare let-globals — the bundle's, not window's
		KinkyDungeonStartNewGame(false);
		// @ts-ignore
		KinkyDungeonState = 'Game'; KinkyDungeonDrawState = 'Game';

		// @ts-ignore — the ally template spawnAvatar clones from
		const base = KinkyDungeonGetEnemyByName('Dressmaker') || KinkyDungeonEnemies[0];
		// @ts-ignore
		let d = KinkyDungeonGetEnemyByName(def);
		if (!d) {
			d = Object.assign({}, base, {
				name: def, faction: 'Player', allied: true, ethereal: false,
				maxhp: 100, evasion: -100, armor: 0, followRange: 100, lowpriority: true,
			});
			// @ts-ignore
			KinkyDungeonEnemies.push(d);
			// @ts-ignore
			if (typeof KinkyDungeonRefreshEnemiesCache === 'function') KinkyDungeonRefreshEnemiesCache();
		}
		// @ts-ignore — the key spawnAvatar registers; correct, and used by every OTHER name path
		addTextKey('Name' + def, label);

		// @ts-ignore
		const p = KinkyDungeonPlayerEntity;
		const ent: any = {
			// @ts-ignore
			id: KinkyDungeonGetEnemyID(), Enemy: d, x: p.x + 1, y: p.y, hp: 100,
			movePoints: 0, attackPoints: 0,
			CustomName: label, CustomNameColor: '#88bbff', style: 'BlueHair',
		};
		// @ts-ignore
		KDAddNewEntity(ent);
		// @ts-ignore
		KDUpdateEnemyCache = true;
		return ent.id;
	}, { label, def });
}

/**
 * Open the stock ally dialogue on that entity and run ONE real draw of it.
 *
 * `KDStartDialog` + `KDDrawDialogue` is the game's own pair — the same two calls the product flow
 * makes after the context menu's Talk. Asserting on what the draw PAINTS (rather than re-deriving
 * `KDGetName` in the test) is the point: the defect lives in how the draw composes the line, so a
 * test that composed it itself would be asserting its own arithmetic.
 */
async function drawAllyDialogueBody(page: any, id: number, def: string) {
	await recordDrawnText(page);
	const name = await page.evaluate(({ id, def }: { id: number; def: string }) => {
		/* eslint-disable */
		// @ts-nocheck
		// @ts-ignore
		const ent = KinkyDungeonFindID(id);
		// @ts-ignore
		KDStartDialog('GenericAlly', def, true, undefined, ent);
		// @ts-ignore — KDDrawDialogue refuses to draw while a slow-move is queued
		KDGameData.SlowMoveTurns = 0;
		// @ts-ignore
		KDDrawDialogue(0);
		// @ts-ignore — the value the draw resolved the speaker's name to
		return KDGetName(id);
	}, { id, def });
	const drawn = await readDrawnText(page);
	await restoreDrawnText(page);
	return { name, body: drawn.texts.find((t) => t.indexOf('(You approach') >= 0) ?? null };
}

test('a co-op partner is named in the ally dialogue, and no other name answer changes', async ({ isolatedPage }) => {
	await bootKD(isolatedPage);
	await isolatedPage.addScriptTag({ path: 'tools/mp-server/client/render-client.js' });

	const id = await plantPeerAvatar(isolatedPage, LABEL, DEF);

	// The registered key is and always was correct — the defect is that this ONE draw path never
	// reads it. Stated as a precondition so a red here says "the fixture is wrong", not "the fix is".
	const registeredKey = await isolatedPage.evaluate((d: string) =>
		// @ts-ignore bare let-global
		TextGet('Name' + d), DEF);
	expect(registeredKey, 'precondition: the peer\'s Name<def> key resolves to their label').toBe(LABEL);

	// ---- BEFORE — the defect, reproduced on this page, before the wrap exists -------------------
	// Without this the "after" half proves nothing: a spec that only ever sees the fixed code cannot
	// tell a working fix from a bug that was never there.
	const before = await drawAllyDialogueBody(isolatedPage, id, DEF);
	expect(before.body, 'precondition: the ally-dialogue body was painted at all').toBeTruthy();
	expect(before.name, 'precondition: KDGetName answers "" for an avatar — the root cause').toBe('');
	expect(before.body,
		'precondition: the KDM-232 defect must still reproduce unfixed, or the fixed half below is '
		+ 'asserting against nothing').toBe('(You approach )');

	// ---- the fix is installed by the client's own apply(), as it is in production ---------------
	await isolatedPage.evaluate(() => {
		// @ts-ignore — a minimally-shaped snapshot: only the install point matters here
		(window as any).KDRenderClient.apply({ messages: { log: [] }, bundle: { v: 1, gameData: {}, globals: {} } });
	});

	// ---- AC1 — the partner is named, asserted as the whole painted line -------------------------
	const after = await drawAllyDialogueBody(isolatedPage, id, DEF);
	expect(after.name, 'KDGetName now falls back to the avatar\'s own CustomName').toBe(LABEL);
	expect(after.body, 'AC1: the ally dialogue names the partner').toBe(`(You approach ${LABEL})`);

	// ---- CONTROLS — the wrap may only ever turn "" into a name ----------------------------------
	const controls = await isolatedPage.evaluate(() => {
		/* eslint-disable */
		// @ts-nocheck
		// @ts-ignore
		const p = KinkyDungeonPlayerEntity;
		// @ts-ignore
		const base = KinkyDungeonGetEnemyByName('Dressmaker') || KinkyDungeonEnemies[0];

		// (a) an ordinary entity, no CustomName: KD's answer today is "", and must stay "".
		// @ts-ignore
		const plainId = KinkyDungeonGetEnemyID();
		// @ts-ignore
		KDAddNewEntity({ id: plainId, Enemy: base, x: p.x, y: p.y + 2, hp: 100, movePoints: 0, attackPoints: 0 });

		// (b) a Collection entry must still WIN — an entity carrying BOTH must answer the collection
		// name, not the CustomName. This is the assertion that fails if the wrap is ever reordered to
		// consult CustomName first, which would silently rename every captured NPC.
		// @ts-ignore
		const collId = KinkyDungeonGetEnemyID();
		// @ts-ignore
		KDAddNewEntity({ id: collId, Enemy: base, x: p.x, y: p.y + 3, hp: 100, movePoints: 0, attackPoints: 0,
			CustomName: 'CustomNameMustLose', CustomNameColor: '#ffffff' });
		// @ts-ignore
		KDGameData.Collection[collId + ''] = { name: 'CollectionMustWin', color: '#ff0000' };

		// (c) an id nothing answers to at all — the wrap must not invent an entity.
		// @ts-ignore
		return { plain: KDGetName(plainId), collection: KDGetName(collId), missing: KDGetName(987654321) };
	});
	expect(controls.plain, 'an entity without CustomName still answers "" — the wrap invents nothing')
		.toBe('');
	expect(controls.collection, 'a Collection entry still outranks CustomName — no existing non-empty '
		+ 'answer changes').toBe('CollectionMustWin');
	expect(controls.missing, 'an unknown id still answers ""').toBe('');
});
