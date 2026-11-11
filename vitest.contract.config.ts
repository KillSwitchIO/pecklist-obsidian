import { defineConfig } from 'vitest/config';

// Runs the sync engine against a real PeckList server: set PECKLIST_URL and PECKLIST_TOKEN.
export default defineConfig({
	test: {
		include: ['tests/contract/**/*.test.ts'],
		testTimeout: 60_000,
		fileParallelism: false,
	},
});
