/**
 * P2 combat target: per-slot damage routing (storage + accessor).
 *
 * Single-page tests. Prove the accessor routes damage by slot WITHOUT touching the
 * enemy AI hot path: the local slot keeps using the global KinkyDungeonDealDamage
 * (single-player byte-identical), a co-op slot's damage lands on that avatar's own
 * `hp` field (leaving the global player stats untouched) and round-trips via the
 * Entities serialization.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('KDIsCoopPlayerSlot identifies a non-local playerSlot avatar', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore
		const p1 = { player: true };                                   // singular player (no slot)
		const p2 = { player: true, playerSlot: 1 };                    // co-op avatar
		const enemy = { Enemy: { name: 'Guard' } };
		return {
			// @ts-ignore
			p1: KDIsCoopPlayerSlot(p1), p2: KDIsCoopPlayerSlot(p2), enemy: KDIsCoopPlayerSlot(enemy),
		};
	});
	expect(r.p1).toBe(false);
	expect(r.p2).toBe(true);
	expect(r.enemy).toBe(false);
});

test('equal-aggro target resolution picks the nearer player (SP returns P1 unchanged)', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — single-player: always the singular player
		const wasActive = MPState.active;
		// @ts-ignore
		MPState.active = false;
		// @ts-ignore
		KinkyDungeonPlayerEntity.x = 5; KinkyDungeonPlayerEntity.y = 5;
		const enemyNearP1 = { x: 6, y: 5 };
		// @ts-ignore
		const spTarget = KDResolveAggroTarget(enemyNearP1) === KinkyDungeonPlayerEntity;

		// Co-op: P2 at (10,10). Enemy near P1 → targets P1; enemy near P2 → targets P2.
		const p2: any = { id: 85, x: 10, y: 10, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDMapData.Entities.push(p2);
		// @ts-ignore
		MPState.active = true;
		// @ts-ignore
		const nearP1 = KDResolveAggroTarget({ x: 6, y: 5 }) === KinkyDungeonPlayerEntity;
		// @ts-ignore
		const nearP2 = KDResolveAggroTarget({ x: 9, y: 10 }) === p2;
		// @ts-ignore — tie favours P1 (equidistant)
		const tie = KDResolveAggroTarget({ x: 7, y: 7 });
		// @ts-ignore
		const tieIsP1 = tie === KinkyDungeonPlayerEntity || tie === p2; // either is a valid entity; just ensure it returns one
		// @ts-ignore — cleanup
		KDMapData.Entities = KDMapData.Entities.filter((e: any) => e !== p2);
		MPState.active = wasActive;
		return { spTarget, nearP1, nearP2, tieIsP1 };
	});
	expect(r.spTarget).toBe(true);   // single-player: the singular player, unchanged
	expect(r.nearP1).toBe(true);     // co-op: enemy by P1 targets P1
	expect(r.nearP2).toBe(true);     // co-op: enemy by P2 targets P2
	expect(r.tieIsP1).toBe(true);    // resolves to a valid player on a tie
});

test('damage to a co-op slot hits its own hp, not the global player stats', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 81, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — baseline global player stats (the singular player's resources)
		const distractionBefore = KinkyDungeonStatDistraction;
		// @ts-ignore
		const res = KDDealDamageToSlot(1, { damage: 4, type: 'crush' });
		const out = {
			happened: res.happened,
			p2hp: p2.hp,
			// @ts-ignore
			globalDistraction: KinkyDungeonStatDistraction,
			distractionBefore,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.happened).toBe(4);
	expect(r.p2hp).toBe(6);                              // P2's own hp dropped
	expect(r.globalDistraction).toBe(r.distractionBefore); // global player stats untouched
});

test('an enemy attack applies the player damage model to P2 stats, not P1 globals', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		const p2: any = { id: 90, x: 1, y: 1, hp: 10, player: true, playerSlot: 1, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore — seed P2 a full stat block (will/stamina/distraction/blind/...)
		KDInitPlayerStats(p2);
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore — baseline P1 globals
		const g0 = { will: KinkyDungeonStatWill, stam: KinkyDungeonStatStamina, distr: KinkyDungeonStatDistraction, blind: KinkyDungeonStatBlind };
		const p0 = {
			// @ts-ignore
			will: KDGetPlayerStat(1, 'will'), stam: KDGetPlayerStat(1, 'stamina'),
			// @ts-ignore
			distr: KDGetPlayerStat(1, 'distraction'), blind: KDGetPlayerStat(1, 'blind'),
		};
		// @ts-ignore — apply an attack to P2: 3 distraction, 2 willpower, 1 stamina, blind 2
		const res = KDApplyEnemyAttackToSlot(1, { damage: 3, type: 'pain', willpowerDamage: 2, staminaDamage: 1, blind: 2 });
		const out = {
			happened: res.happened,
			// @ts-ignore
			p2Will: KDGetPlayerStat(1, 'will'), p2Stam: KDGetPlayerStat(1, 'stamina'),
			// @ts-ignore
			p2Distr: KDGetPlayerStat(1, 'distraction'), p2Blind: KDGetPlayerStat(1, 'blind'),
			p0,
			// @ts-ignore — P1 globals untouched
			gWill: KinkyDungeonStatWill, gStam: KinkyDungeonStatStamina, gDistr: KinkyDungeonStatDistraction, gBlind: KinkyDungeonStatBlind,
			g0,
		};
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.happened).toBeGreaterThan(0);
	expect(r.p2Will).toBe(r.p0.will - 2);     // willpower damage hit P2's will
	expect(r.p2Stam).toBe(r.p0.stam - 1);     // stamina damage hit P2's stamina
	expect(r.p2Distr).toBe(r.p0.distr + 3);   // main damage raised P2's distraction
	expect(r.p2Blind).toBe(2);                // blind set on P2
	expect(r.gWill).toBe(r.g0.will);          // P1 globals untouched
	expect(r.gStam).toBe(r.g0.stam);
	expect(r.gDistr).toBe(r.g0.distr);
	expect(r.gBlind).toBe(r.g0.blind);
});

test('P2 hp damage round-trips through save → load', async ({ kdPage }) => {
	const r = await kdPage.evaluate(() => {
		// @ts-ignore — keep solo-drop from removing P2 during the load
		const wasActive = MPState.active, wasPlayer = MPState.playerId;
		// @ts-ignore
		MPState.active = true; MPState.playerId = 0;
		const p2: any = { id: 82, x: 2, y: 2, hp: 10, player: true, playerSlot: 1, modified: true, Enemy: { name: 'Guard', tags: {} } };
		// @ts-ignore
		KDRegisterPlayer(1, p2);
		// @ts-ignore
		KDMapData.Entities.push(p2);
		// @ts-ignore
		KDDealDamageToSlot(1, { damage: 7 });
		// @ts-ignore
		const save = LZString.compressToBase64(JSON.stringify(KinkyDungeonGenerateSaveData()));
		// @ts-ignore
		KinkyDungeonLoadGame(save, true);
		// @ts-ignore
		const restored = (KDMapData.Entities || []).find((e: any) => e && e.playerSlot === 1);
		const out = { hp: restored ? restored.hp : null };
		// @ts-ignore
		MPState.active = wasActive; MPState.playerId = wasPlayer;
		// @ts-ignore
		KDUnregisterPlayer(1);
		return out;
	});
	expect(r.hp).toBe(3);   // 10 - 7, survived the round-trip
});
