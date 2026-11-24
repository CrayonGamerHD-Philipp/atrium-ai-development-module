import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// `modules/aidev/protocol.ts` liegt außerhalb des Pakets: `zod` immer aus `runner/node_modules` auflösen,
		// damit Protokoll und Runner dieselbe Zod-Instanz nutzen.
		dedupe: ['zod']
	},
	test: {
		include: ['test/**/*.test.ts'],
		testTimeout: 90_000,
		hookTimeout: 90_000,
		pool: 'forks'
	}
});
