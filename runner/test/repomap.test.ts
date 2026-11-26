import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRepoMap, REPO_MAP_MAX } from '../src/repomap.ts';
import { ResearchCache } from '../src/research.ts';

describe('Repository-Übersicht', () => {
	it('Ordner, Typen, wichtige Dateien und Skripte', () => {
		const files = [
			'README.md',
			'package.json',
			'.github/workflows/ci.yml',
			'src/index.ts',
			'src/lib/a.ts',
			'src/lib/b.ts',
			'src/routes/x.svelte',
			'docs/guide.md'
		];
		const map = formatRepoMap(files, JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }));
		expect(map).toContain('8 tracked files.');
		expect(map).toContain('- src/ (4) – lib/ (2), routes/ (1)');
		expect(map).toContain('- docs/ (1)');
		expect(map).toContain('.ts 3');
		expect(map).toContain('Key files: README.md, package.json, .github/workflows/ci.yml');
		expect(map).toContain('- `test`: `vitest run`');
	});

	it('bleibt kurz, auch bei sehr vielen Dateien; kaputtes package.json stört nicht', () => {
		const files = Array.from({ length: 5000 }, (_, i) => `dir${i % 60}/sub${i % 13}/file${i}.ts`);
		const map = formatRepoMap(files, '{kaputt');
		expect(map.length).toBeLessThanOrEqual(REPO_MAP_MAX);
		expect(map).toContain('more');
		expect(map).not.toContain('package.json scripts');
	});
});

describe('Recherche-Zwischenspeicher', () => {
	it('gleiche Frage (Schreibweise egal) → Treffer, abgelaufen → kein Treffer', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'aidev-rcache-'));
		try {
			const cache = new ResearchCache(dir, 1000);
			await cache.put({ question: 'Welche  Node-Version?' }, 'Node 22', 'claude-1', 10_000);
			expect(await cache.get({ question: 'welche node-version?' }, 10_500)).toEqual({ answer: 'Node 22', account: 'claude-1' });
			expect(await cache.get({ question: 'welche node-version?', context: 'anders' }, 10_500)).toBeNull();
			expect(await cache.get({ question: 'Welche Node-Version?' }, 12_000)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
