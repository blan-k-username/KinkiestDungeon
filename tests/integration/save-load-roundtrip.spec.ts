/**
 * Integration test: KDGameData survives a full save→load round-trip.
 *
 * Uses the real save flow:
 *   - KinkyDungeonGenerateSaveData()      (KinkyDungeon.ts:6775) → object
 *   - LZString.compressToBase64(JSON)     compression
 *   - KinkyDungeonLoadGame(string, true)  (KinkyDungeon.ts:6920) → restores
 *
 * Asserts that a mutation captured in a save is correctly restored after the
 * state has been further mutated and then loaded back.
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('faction rep survives save → load round-trip', async ({ kdPage }) => {
	// Establish a known starting value.
	await kdPage.evaluate(() => {
		// @ts-ignore — KD globals
		KinkyDungeonChangeFactionRep('Maidforce', 0.1);
	});
	const targetValue = await kdPage.evaluate(() =>
		// @ts-ignore
		KDFactionRelation('Player', 'Maidforce'),
	);

	// Snapshot the current game state.
	const saved = await kdPage.evaluate(() => {
		// @ts-ignore
		const saveObj = KinkyDungeonGenerateSaveData();
		// @ts-ignore — LZString loaded by Scripts/lib/LZString.js
		return LZString.compressToBase64(JSON.stringify(saveObj));
	});

	// Mutate further so we can prove the load actually restored.
	await kdPage.evaluate(() => {
		// @ts-ignore
		KinkyDungeonChangeFactionRep('Maidforce', -0.5);
	});
	const mutated = await kdPage.evaluate(() =>
		// @ts-ignore
		KDFactionRelation('Player', 'Maidforce'),
	);
	expect(mutated, 'mutation should diverge from the saved value').not.toBeCloseTo(targetValue, 4);

	// Restore from the snapshot. kdloadconsent=true skips the consent prompt.
	await kdPage.evaluate((s) => {
		// @ts-ignore
		KinkyDungeonLoadGame(s, true);
	}, saved);

	const restored = await kdPage.evaluate(() =>
		// @ts-ignore
		KDFactionRelation('Player', 'Maidforce'),
	);
	expect(restored, 'load should restore the saved faction relation').toBeCloseTo(targetValue, 5);
});
