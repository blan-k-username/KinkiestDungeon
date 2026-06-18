/**
 * Vitest unit tests for the helpers themselves. These run in node only —
 * no jsdom, no bundle. Purpose: prove the helper modules import cleanly
 * and expose their expected API surface.
 */
import { describe, it, expect } from 'vitest';

describe('test helper modules', () => {
	it('bundle.ts exports waitForBundleReady and getKDVersion', async () => {
		const mod = await import('./bundle');
		expect(typeof mod.waitForBundleReady).toBe('function');
		expect(typeof mod.getKDVersion).toBe('function');
	});

	it('state.ts exports resetKDState', async () => {
		const mod = await import('./state');
		expect(typeof mod.resetKDState).toBe('function');
	});

	it('mod-injector.ts exports injectMod', async () => {
		const mod = await import('./mod-injector');
		expect(typeof mod.injectMod).toBe('function');
	});

	it('playwright-fixtures.ts exports test and expect', async () => {
		const mod = await import('./playwright-fixtures');
		expect(typeof mod.test).toBe('function');
		expect(typeof mod.expect).toBe('function');
	});
});
