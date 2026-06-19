/**
 * Integration test: mod-injection helper end-to-end.
 *
 * Pushes a synthetic enemy definition into the KinkyDungeonEnemies array,
 * then verifies it's discoverable.
 */
import { test, expect } from '../helpers/playwright-fixtures';
import { injectMod } from '../helpers/mod-injector';

test('mod can push to KinkyDungeonEnemies via eval', async ({ kdPage }) => {
	const before = await kdPage.evaluate(() =>
		// @ts-ignore — KD globals
		KinkyDungeonEnemies.length,
	);

	await injectMod(kdPage, `
		'use strict';
		KinkyDungeonEnemies.push({
			name: 'KDTestEnemy019',
			tags: KDMapInit(['test', 'melee']),
			AI: 'hunt',
			maxhp: 1, minLevel: 0, weight: 0,
			movePoints: 1, attackPoints: 1,
			attack: 'Melee', power: 1, dmgType: 'crush',
			terrainTags: {}, floors: KDMapInit(['cat']),
			dropTable: [],
		});
	`);

	const after = await kdPage.evaluate(() =>
		// @ts-ignore
		KinkyDungeonEnemies.length,
	);
	expect(after).toBe(before + 1);

	const found = await kdPage.evaluate(() => {
		// @ts-ignore
		const e = KinkyDungeonEnemies.find((x) => x.name === 'KDTestEnemy019');
		return e ? e.name : null;
	});
	expect(found).toBe('KDTestEnemy019');
});
