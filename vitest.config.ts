import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/unit/**/*.spec.ts', 'tests/helpers/**/*.spec.ts'],
		environment: 'node',
		globals: false,
		reporters: ['default'],
		coverage: { enabled: false },
	},
});
