/**
 * KD state reset helper. Runs in the browser via page.evaluate, calling existing
 * in-game init functions to bring the world back to a clean slate between tests.
 *
 * Init sequence mirrors the manual harness at Game/src/KinkyDungeonTests.ts.
 */
import type { Page } from '@playwright/test';

export async function resetKDState(page: Page): Promise<void> {
	await page.evaluate(() => {
		// @ts-ignore — KD globals
		KDSetWorldSlot(0, 1, 0, 0);
		// @ts-ignore
		MiniGameKinkyDungeonCheckpoint = 'grv';
		// @ts-ignore — Reset=true clears KDFactionRelations map and reseeds from base
		KDInitFactions(true);
		// @ts-ignore
		KinkyDungeonInitReputation();
		// @ts-ignore — main init entry; rebuilds map, journey, inventory, dresses
		KinkyDungeonInitialize(1);
		// @ts-ignore
		KDInitPerks();
		// @ts-ignore — pin slot 0 of KDPlayers[] to the freshly-init'd
		// local-player entity. The real engine will call this from its init
		// path; this test helper simulates that integration point.
		if (typeof KDSyncLocalPlayerSlot === 'function') KDSyncLocalPlayerSlot();
	});
}
