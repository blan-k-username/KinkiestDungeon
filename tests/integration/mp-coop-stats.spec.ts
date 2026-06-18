/**
 * Per-player core stats: storage + accessor.
 *
 * Single-page tests (no two-client). Prove the accessor: slot 0 maps to the live
 * globals (single-player byte-identical), a non-local slot reads/writes its own
 * entity fields independently, and a P2 stat block round-trips save→load via the
 * Entities serialization. No global / change-function / tick edits are made, so
 * single-player is unaffected by construction.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('slot-0 accessor maps to the live stat globals (SP-identical)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const orig = KinkyDungeonStatStamina;
		// @ts-ignore
		const read = KDGetPlayerStat(0, 'stamina');
		// @ts-ignore
		KDSetPlayerStat(0, 'stamina', 3.5);
		// @ts-ignore
		const afterGlobal = KinkyDungeonStatStamina;
		// @ts-ignore
		KDSetPlayerStat(0, 'stamina', orig); // restore
		return { read, orig, afterGlobal };
	});
	expect(r.read).toBe(r.orig);        // accessor returns the global value
	expect(r.afterGlobal).toBe(3.5);    // writing slot 0 writes the global
});

test('slot-0 status stats map to their globals (blind/freeze/bind/MovePoints)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const orig = { blind: KinkyDungeonStatBlind, freeze: KinkyDungeonStatFreeze, bind: KinkyDungeonStatBind, mp: KDGameData.MovePoints };
		// @ts-ignore — reads map to the globals
		const read = { blind: KDGetPlayerStat(0, 'blind'), freeze: KDGetPlayerStat(0, 'freeze'), bind: KDGetPlayerStat(0, 'bind'), mp: KDGetPlayerStat(0, 'movePoints') };
		// @ts-ignore — writes hit the globals
		KDSetPlayerStat(0, 'blind', 5); KDSetPlayerStat(0, 'movePoints', -3);
		// @ts-ignore
		const after = { blind: KinkyDungeonStatBlind, mp: KDGameData.MovePoints };
		// @ts-ignore restore
		KDSetPlayerStat(0, 'blind', orig.blind); KDSetPlayerStat(0, 'movePoints', orig.mp);
		return { orig, read, after };
	});
	expect(r.read.blind).toBe(r.orig.blind);
	expect(r.read.freeze).toBe(r.orig.freeze);
	expect(r.read.bind).toBe(r.orig.bind);
	expect(r.read.mp).toBe(r.orig.mp);
	expect(r.after.blind).toBe(5);      // write routed to KinkyDungeonStatBlind
	expect(r.after.mp).toBe(-3);        // write routed to KDGameData.MovePoints
});

test('a co-op slot has independent status stats that round-trip and do not touch the globals', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;
		const p2: any = { id: 73, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore — KDInitPlayerStats seeds the new status fields to 0
		KDInitPlayerStats(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDMapData.Entities.push(p2);
		// @ts-ignore
		const globalBlindBefore = KinkyDungeonStatBlind;
		// @ts-ignore
		KDSetPlayerStat(1, 'blind', 4); KDSetPlayerStat(1, 'movePoints', -2);
		const seededZero = {
			// @ts-ignore
			freeze: KDGetPlayerStat(1, 'freeze'), bind: KDGetPlayerStat(1, 'bind'),
		};
		// @ts-ignore — save/load round-trip
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const out = {
			// @ts-ignore
			p2Blind: KDGetPlayerStat(1, 'blind'),
			// @ts-ignore
			globalBlindAfter: KinkyDungeonStatBlind,
			globalBlindBefore,
			seededZero,
			// read restored values via the accessor (kd-prefixed entity fields)
			// @ts-ignore
			restoredBlind: restored ? KDGetPlayerStat(1, 'blind') : null,
			// @ts-ignore
			restoredMp: restored ? KDGetPlayerStat(1, 'movePoints') : null,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.p2Blind).toBe(4);                       // slot-1 write landed on the entity
	expect(r.globalBlindAfter).toBe(r.globalBlindBefore); // the global was NOT touched
	expect(r.seededZero.freeze).toBe(0);             // KDInitPlayerStats seeded status fields
	expect(r.seededZero.bind).toBe(0);
	expect(r.restoredBlind).toBe(4);                 // round-tripped via Entities
	expect(r.restoredMp).toBe(-2);
});

test('a non-local slot has independent stats that do not touch the globals', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — build a P2-style entity and register it at slot 1
		const p2: any = { id: 71, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);

		// @ts-ignore
		const globalBefore = KinkyDungeonStatStamina;
		// @ts-ignore
		KDSetPlayerStat(1, 'stamina', 3);
		const out = {
			// @ts-ignore
			p2Stamina: KDGetPlayerStat(1, 'stamina'),
			// @ts-ignore
			globalAfter: KinkyDungeonStatStamina,
			globalBefore,
			// @ts-ignore — default seed gave a full block
			p2WillMax: KDGetPlayerStat(1, 'willMax'),
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.p2Stamina).toBe(3);                 // slot-1 write landed on the entity
	expect(r.globalAfter).toBe(r.globalBefore);  // the global was NOT touched
	expect(r.p2WillMax).toBeGreaterThan(0);      // KDInitPlayerStats seeded a full block
});

test('P2 stat fields round-trip through save → load', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — keep solo-drop from removing P2 during the load
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;

		// @ts-ignore
		const p2: any = { id: 72, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDInitPlayerStats(p2);
		p2.stamina = 4; p2.will = 6;
		// @ts-ignore
		KDMapData.Entities.push(p2);

		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);

		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const out = {
			present: !!restored,
			stamina: restored ? restored.stamina : null,
			will: restored ? restored.will : null,
		};
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		return out;
	});
	expect(r.present).toBe(true);
	expect(r.stamina).toBe(4);
	expect(r.will).toBe(6);
});
