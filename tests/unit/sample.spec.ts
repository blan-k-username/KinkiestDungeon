/**
 * Sample Vitest unit test. Proves Vitest is wired up and pointing at the right
 * test paths. Future unit tests of pure helper functions will live alongside.
 */
import { describe, it, expect } from 'vitest';

describe('test infrastructure self-test', () => {
	it('vitest runs basic assertions', () => {
		expect(1 + 1).toBe(2);
	});

	it('async tests work', async () => {
		const value = await Promise.resolve('ok');
		expect(value).toBe('ok');
	});
});
