import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Immer die Runner-tsconfig verwenden: sonst sucht der Transform für `modules/aidev/protocol.ts` die Root-tsconfig,
	// die `.core/tsconfig.json` erweitert – im Runner-CI-Job (ohne Submodul) fehlt diese, und die Tests brechen ab.
	tsconfig: './tsconfig.json',
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
