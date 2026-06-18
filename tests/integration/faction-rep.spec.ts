/**
 * Integration test: faction reputation change propagates symmetrically.
 *
 * Asserts KinkyDungeonChangeFactionRep updates both Player→Faction and
 * Faction→Player (the relations table is mutual; see KinkyDungeonFactionsList.ts).
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('faction rep change propagates symmetrically', async ({ kdPage }) => {
	const before = await kdPage.evaluate(() =>
		// @ts-ignore — KD globals
		KDFactionRelation('Player', 'Maidforce'),
	);

	await kdPage.evaluate(() => {
		// @ts-ignore
		KinkyDungeonChangeFactionRep('Maidforce', 0.1);
	});

	const playerToFaction = await kdPage.evaluate(() =>
		// @ts-ignore
		KDFactionRelation('Player', 'Maidforce'),
	);
	const factionToPlayer = await kdPage.evaluate(() =>
		// @ts-ignore
		KDFactionRelation('Maidforce', 'Player'),
	);

	expect(playerToFaction).toBeGreaterThan(before);
	// Mutual table — both directions must report the same value
	expect(factionToPlayer).toBeCloseTo(playerToFaction, 5);
});
