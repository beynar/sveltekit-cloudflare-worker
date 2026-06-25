import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		expect: { requireAssertions: true },
		hookTimeout: 30_000,
		include: ['tests/integration/**/*.test.ts'],
		testTimeout: 120_000
	}
});
