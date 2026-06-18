/**
 * Integration tests for KDComputeStateHash — the function the multiplayer turn
 * loop uses to detect simulation desync between two clients that should
 * otherwise have run identical lockstep simulation.
 *
 * The contract is narrow:
 *   1. Deterministic — identical game state must produce an identical hash.
 *   2. Sensitive   — a meaningful change in game state must produce a
 *                    different hash.
 *   3. Cheap and pure — no Date.now, no Math.random, no DOM access.
 *
 * The hash is not cryptographic. Hex string output is fine (it just gets
 * compared as a string on the wire).
 */
import { test, expect } from '../helpers/playwright-fixtures';

test('returns a non-empty hex string', async ({ kdPage }) => {
	const h = await kdPage.evaluate(() => {
		// @ts-ignore — bundle globals
		return KDComputeStateHash();
	});
	expect(typeof h).toBe('string');
	expect(h.length).toBeGreaterThan(0);
	expect(h).toMatch(/^[0-9a-f]+$/);
});

test('deterministic: same state yields same hash across calls', async ({ kdPage }) => {
	const [a, b] = await kdPage.evaluate(() => {
		// @ts-ignore
		const x = KDComputeStateHash();
		// @ts-ignore
		const y = KDComputeStateHash();
		return [x, y];
	});
	expect(a).toBe(b);
});

test('deterministic: same state yields same hash after a reset-state round-trip', async ({ kdPage }) => {
	const a = await kdPage.evaluate(() => {
		// @ts-ignore
		return KDComputeStateHash();
	});
	// Trigger another full reset (the kdPage fixture already reset once; this
	// confirms the hash is a function of the reset-state, not of which run we
	// happen to be on).
	await kdPage.evaluate(() => {
		// @ts-ignore
		KDInitFactions(true);
		// @ts-ignore
		KinkyDungeonInitReputation();
		// @ts-ignore
		KinkyDungeonInitialize(1);
		// @ts-ignore
		KDInitPerks();
	});
	const b = await kdPage.evaluate(() => {
		// @ts-ignore
		return KDComputeStateHash();
	});
	expect(b).toBe(a);
});

test('sensitive: mutating KDGameData changes the hash', async ({ kdPage }) => {
	const before = await kdPage.evaluate(() => {
		// @ts-ignore
		return KDComputeStateHash();
	});

	await kdPage.evaluate(() => {
		// @ts-ignore
		KDGameData.OrgasmStage = (KDGameData.OrgasmStage || 0) + 1;
	});

	const after = await kdPage.evaluate(() => {
		// @ts-ignore
		return KDComputeStateHash();
	});

	expect(after).not.toBe(before);
});

test('sensitive: changing faction rep changes the hash', async ({ kdPage }) => {
	const before = await kdPage.evaluate(() => {
		// @ts-ignore
		return KDComputeStateHash();
	});
	await kdPage.evaluate(() => {
		// @ts-ignore
		KinkyDungeonChangeFactionRep('Maidforce', 0.1);
	});
	const after = await kdPage.evaluate(() => {
		// @ts-ignore
		return KDComputeStateHash();
	});
	expect(after).not.toBe(before);
});

test('stable across object key insertion order', async ({ kdPage }) => {
	// Two semantically-identical KDGameData snapshots, built with differently
	// ordered key insertions, must hash to the same value. JSON.stringify alone
	// would NOT satisfy this — the implementation has to sort keys.
	const [h1, h2] = await kdPage.evaluate(() => {
		// @ts-ignore
		const original = KDGameData;
		// @ts-ignore
		KDGameData = { a: 1, b: 2, c: { x: 10, y: 20 } };
		// @ts-ignore
		const first = KDComputeStateHash();
		// @ts-ignore
		KDGameData = { c: { y: 20, x: 10 }, b: 2, a: 1 };
		// @ts-ignore
		const second = KDComputeStateHash();
		// @ts-ignore
		KDGameData = original;
		return [first, second];
	});
	expect(h2).toBe(h1);
});

test('purity: no Math.random / Date.now leaks into the hash', async ({ kdPage }) => {
	// Computing the hash twice in succession must not differ — this catches
	// accidental inclusion of non-deterministic inputs.
	const [a, b, c] = await kdPage.evaluate(() => {
		// @ts-ignore
		return [KDComputeStateHash(), KDComputeStateHash(), KDComputeStateHash()];
	});
	expect(b).toBe(a);
	expect(c).toBe(a);
});
