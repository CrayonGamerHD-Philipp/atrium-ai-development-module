// Bündelt den Runner (inkl. `modules/aidev/protocol.ts`, zod und cross-spawn) nach `dist/main.js`.
// `node-pty` bleibt extern (native optionale Abhängigkeit, wird zur Laufzeit dynamisch geladen).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** `zod` immer aus `runner/node_modules` – auch für die Protokolldatei außerhalb des Pakets */
const zodFromRunner = {
	name: 'zod-from-runner',
	setup(b) {
		b.onResolve({ filter: /^zod(\/.*)?$/ }, async (args) => {
			if (args.pluginData?.fromRunner) return undefined;
			const r = await b.resolve(args.path, {
				kind: args.kind,
				resolveDir: root,
				pluginData: { fromRunner: true }
			});
			return r.errors.length ? { errors: r.errors } : { path: r.path };
		});
	}
};

await build({
	entryPoints: [resolve(root, 'src/main.ts')],
	outfile: resolve(root, 'dist/main.js'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	sourcemap: true,
	external: ['node-pty'],
	plugins: [zodFromRunner],
	define: { __RUNNER_VERSION__: JSON.stringify(pkg.version) },
	// CommonJS-Abhängigkeiten (cross-spawn) benötigen `require` im ESM-Bündel
	banner: {
		js: "#!/usr/bin/env node\nimport { createRequire as __aidevCreateRequire } from 'node:module';\nconst require = __aidevCreateRequire(import.meta.url);"
	},
	logLevel: 'info'
});
