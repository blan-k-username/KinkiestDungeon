/**
 * End-to-end determinism check for the seeded-RNG migration.
 *
 * The unit-level determinism tests in `kd-random-helpers.spec.ts` prove that
 * the new `KDRandomInt` / `KDRandomChoice` / `KDRandomChance` helpers produce
 * identical sequences from identical seeds. This file goes one step further:
 * it calls a real, migrated game function (`UIItemFromList`, the BC-derived
 * helper in `Scripts/Common.ts` now backed by `KDRandomChoice`) and asserts
 * that with the same seed it produces identical output across runs.
 *
 * If a gameplay path slips back to bare `Math.random()`, this kind of check
 * is what catches it.
 */
import { test, expect } from '../helpers/playwright-fixtures';

const RUN_LENGTH = 30;

/**
 * Seed the PRNG, then invoke a migrated bundle entry point many times.
 * Returns the sequence of picks for later comparison.
 */
async function deterministicPicks(page: import('@playwright/test').Page, seed: string): Promise<string[]> {
	return page.evaluate(({ s, n }) => {
		// @ts-ignore — bundle globals
		KDsetSeed(s);
		const pool = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
		const out: string[] = [];
		let previous = '';
		for (let i = 0; i < n; i++) {
			// @ts-ignore — UIItemFromList lives in the bundle and was migrated to KDRandomChoice
			const picked = UIItemFromList(previous, pool) as string;
			out.push(picked);
			previous = picked;
		}
		return out;
	}, { s: seed, n: RUN_LENGTH });
}

test('migrated bundle path (UIItemFromList) is deterministic under a fixed seed', async ({ kdPage }) => {
	const first = await deterministicPicks(kdPage, 'kd-010-determinism');
	const second = await deterministicPicks(kdPage, 'kd-010-determinism');

	expect(first).toHaveLength(RUN_LENGTH);
	expect(second).toEqual(first);

	// Sanity: at least two distinct values appeared. If everything were stuck on
	// one bucket, the equality check above would still pass but the RNG would be
	// dead. This guards against accidentally short-circuiting the picker.
	expect(new Set(first).size).toBeGreaterThan(1);
});

test('different seeds produce different bundle-level sequences', async ({ kdPage }) => {
	const a = await deterministicPicks(kdPage, 'kd-010-determinism-A');
	const b = await deterministicPicks(kdPage, 'kd-010-determinism-B');
	expect(b).not.toEqual(a);
});
