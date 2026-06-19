import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	testMatch: ['tests/integration/**/*.spec.ts', 'tests/e2e/**/*.spec.ts'],
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	// Two-client integration tests can transiently time out on the cold-start
	// WebSocket handshake under heavy docker load (a documented flake — they pass
	// on a clean run). One retry automates the "re-run before treating red as a
	// real bug" guidance; a retry re-opens fresh contexts + resets the server session.
	retries: 1,
	reporter: [
		['list'],
		['html', { open: 'never', outputFolder: 'tests/_artifacts/html-report' }],
	],
	outputDir: 'tests/_artifacts/playwright',
	use: {
		baseURL: 'http://localhost:8080',
		headless: true,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
	},
	webServer: {
		command: 'npm run serve',
		url: 'http://localhost:8080',
		reuseExistingServer: true,
		timeout: 30_000,
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
	],
});
