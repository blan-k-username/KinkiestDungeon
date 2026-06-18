/**
 * Integration tests for the seeded-RNG helper API exposed by KinkyDungeon.ts.
 *
 * These helpers wrap the existing `KDRandom` PRNG (sfc32, defined in
 * `Game/src/base/KinkyDungeon.ts`) and exist so that gameplay code can stop
 * calling unseeded `Math.random()` for any randomness that must be
 * deterministic given a seed (multiplayer lockstep, replay, seed sharing).
 *
 * Required helpers:
 *   - KDRandomInt(maxExclusive: number): number
 *   - KDRandomIntRange(min: number, maxInclusive: number): number
 *   - KDRandomChoice<T>(arr: T[]): T | undefined
 *   - KDRandomChance(p: number): boolean
 *
 * They live in the bundle and read the global `KDRandom` at call time, so
 * re-seeding via `KDsetSeed(str)` is honoured.
 */
import { test, expect } from '../helpers/playwright-fixtures';

const SAMPLE_COUNT = 200;

test.describe('KDRandomInt', () => {
	test('result is in [0, maxExclusive) for many draws', async ({ kdPage }) => {
		const values = await kdPage.evaluate((n) => {
			// @ts-ignore — bundle globals
			KDsetSeed('kd-random-int-bounds');
			const out: number[] = [];
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				out.push(KDRandomInt(7));
			}
			return out;
		}, SAMPLE_COUNT);

		for (const v of values) {
			expect(Number.isInteger(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(7);
		}
	});

	test('maxExclusive <= 0 returns 0 (defensive, never throws)', async ({ kdPage }) => {
		const results = await kdPage.evaluate(() => {
			// @ts-ignore
			return [KDRandomInt(0), KDRandomInt(-1), KDRandomInt(-100)];
		});
		expect(results).toEqual([0, 0, 0]);
	});

	test('maxExclusive === 1 always returns 0', async ({ kdPage }) => {
		const allZero = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-int-singleton');
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				if (KDRandomInt(1) !== 0) return false;
			}
			return true;
		}, SAMPLE_COUNT);
		expect(allZero).toBe(true);
	});
});

test.describe('KDRandomIntRange', () => {
	test('result is in [min, maxInclusive] for many draws', async ({ kdPage }) => {
		const values = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-range-bounds');
			const out: number[] = [];
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				out.push(KDRandomIntRange(5, 8));
			}
			return out;
		}, SAMPLE_COUNT);

		for (const v of values) {
			expect(Number.isInteger(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(5);
			expect(v).toBeLessThanOrEqual(8);
		}
	});

	test('min === max returns min', async ({ kdPage }) => {
		const v = await kdPage.evaluate(() => {
			// @ts-ignore
			KDsetSeed('kd-random-range-equal');
			// @ts-ignore
			return KDRandomIntRange(3, 3);
		});
		expect(v).toBe(3);
	});

	test('min > max returns min (defensive, never throws)', async ({ kdPage }) => {
		const v = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDRandomIntRange(10, 5);
		});
		expect(v).toBe(10);
	});

	test('negative ranges work', async ({ kdPage }) => {
		const values = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-range-negative');
			const out: number[] = [];
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				out.push(KDRandomIntRange(-3, -1));
			}
			return out;
		}, SAMPLE_COUNT);

		for (const v of values) {
			expect(v).toBeGreaterThanOrEqual(-3);
			expect(v).toBeLessThanOrEqual(-1);
		}
	});
});

test.describe('KDRandomChoice', () => {
	test('always returns an element of the array', async ({ kdPage }) => {
		const arr = ['a', 'b', 'c', 'd', 'e'];
		const picks = await kdPage.evaluate(({ items, n }) => {
			// @ts-ignore
			KDsetSeed('kd-random-choice-element');
			const out: (string | undefined)[] = [];
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				out.push(KDRandomChoice(items));
			}
			return out;
		}, { items: arr, n: SAMPLE_COUNT });

		for (const v of picks) expect(arr).toContain(v);
	});

	test('empty array returns undefined (matches arr[Math.floor(rand*0)] today)', async ({ kdPage }) => {
		const result = await kdPage.evaluate(() => {
			// @ts-ignore
			return KDRandomChoice([]);
		});
		expect(result).toBeUndefined();
	});

	test('single-element array always returns that element', async ({ kdPage }) => {
		const allSame = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-choice-single');
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				if (KDRandomChoice(['only']) !== 'only') return false;
			}
			return true;
		}, SAMPLE_COUNT);
		expect(allSame).toBe(true);
	});
});

test.describe('KDRandomChance', () => {
	test('p === 0 is always false', async ({ kdPage }) => {
		const allFalse = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-chance-zero');
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				if (KDRandomChance(0) !== false) return false;
			}
			return true;
		}, SAMPLE_COUNT);
		expect(allFalse).toBe(true);
	});

	test('p === 1 is always true (KDRandom returns < 1)', async ({ kdPage }) => {
		const allTrue = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-chance-one');
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				if (KDRandomChance(1) !== true) return false;
			}
			return true;
		}, SAMPLE_COUNT);
		expect(allTrue).toBe(true);
	});

	test('returns booleans for intermediate probabilities', async ({ kdPage }) => {
		const types = await kdPage.evaluate((n) => {
			// @ts-ignore
			KDsetSeed('kd-random-chance-mid');
			const out: string[] = [];
			for (let i = 0; i < n; i++) {
				// @ts-ignore
				out.push(typeof KDRandomChance(0.5));
			}
			return Array.from(new Set(out));
		}, SAMPLE_COUNT);
		expect(types).toEqual(['boolean']);
	});
});

test.describe('determinism — the multiplayer-relevant guarantee', () => {
	test('same seed produces identical sequence across helpers', async ({ kdPage }) => {
		const drawSequence = (seed: string) =>
			kdPage.evaluate((s) => {
				// @ts-ignore
				KDsetSeed(s);
				const out: unknown[] = [];
				for (let i = 0; i < 50; i++) {
					// @ts-ignore
					out.push(KDRandomInt(100));
					// @ts-ignore
					out.push(KDRandomIntRange(-10, 10));
					// @ts-ignore
					out.push(KDRandomChoice(['x', 'y', 'z']));
					// @ts-ignore
					out.push(KDRandomChance(0.5));
				}
				return out;
			}, seed);

		const first = await drawSequence('determinism-seed-A');
		const second = await drawSequence('determinism-seed-A');
		expect(second).toEqual(first);
	});

	test('different seeds produce different sequences', async ({ kdPage }) => {
		const drawSequence = (seed: string) =>
			kdPage.evaluate((s) => {
				// @ts-ignore
				KDsetSeed(s);
				const out: number[] = [];
				for (let i = 0; i < 50; i++) {
					// @ts-ignore
					out.push(KDRandomInt(1_000_000));
				}
				return out;
			}, seed);

		const a = await drawSequence('determinism-seed-A');
		const b = await drawSequence('determinism-seed-B');
		expect(b).not.toEqual(a);
	});
});
