import { describe, expect, it } from 'vitest';
import {
	cleanNote,
	extractNotes,
	KNOWLEDGE_LANG,
	knowledgeSection,
	MAX_NOTES_PER_RUN,
	mergeKnowledge,
	noteKey
} from '../../knowledge';
import { buildSystemPrompt, type PromptContext } from '../../prompts';

const day = new Date('2026-11-26T10:00:00Z');

describe('extractNotes', () => {
	it('entfernt den Block und liefert die Notizen', () => {
		const text = [
			'Fertig: Dark Mode umgesetzt.',
			'',
			'```' + KNOWLEDGE_LANG,
			'- Tests: `npm test` braucht vorher `npm run build:types`',
			'* Styles liegen in src/styles, Tokens in tokens.css',
			'',
			'- kurz',
			'```'
		].join('\n');
		const r = extractNotes(text);
		expect(r.body).toBe('Fertig: Dark Mode umgesetzt.');
		expect(r.notes).toEqual([
			'Tests: `npm test` braucht vorher `npm run build:types`',
			'Styles liegen in src/styles, Tokens in tokens.css'
		]);
	});

	it('lässt andere Blöcke und Texte ohne Notizen unverändert', () => {
		const text = 'Ergebnis\n\n```json\n{"a": 1}\n```';
		expect(extractNotes(text)).toEqual({ body: text, notes: [] });
		expect(extractNotes(null)).toEqual({ body: '', notes: [] });
	});

	it('verwirft Geheimnisse und Duplikate, begrenzt die Anzahl', () => {
		const lines = [
			'- Deploy-Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'- password = hunter22geheim',
			'- Build mit pnpm, nicht npm.',
			'- build mit PNPM, nicht npm',
			...Array.from({ length: 20 }, (_, i) => `- Fakt Nummer ${i} über das Projekt`)
		];
		const r = extractNotes(['```' + KNOWLEDGE_LANG, ...lines, '```'].join('\n'));
		expect(r.notes[0]).toBe('Build mit pnpm, nicht npm.');
		expect(r.notes.some((n) => n.includes('ghp_') || n.includes('hunter'))).toBe(false);
		expect(r.notes).toHaveLength(MAX_NOTES_PER_RUN);
	});

	it('Block ohne schließenden Zaun am Ende', () => {
		const r = extractNotes('Text\n~~~' + KNOWLEDGE_LANG + '\n- Migrationen sind unveränderlich');
		expect(r.body).toBe('Text');
		expect(r.notes).toEqual(['Migrationen sind unveränderlich']);
	});
});

describe('mergeKnowledge', () => {
	it('hängt datierte Zeilen an und überspringt Bekanntes', () => {
		const current = 'Eigene Notiz: Staging ist langsam\n- [2026-11-01] Build mit pnpm, nicht npm';
		const next = mergeKnowledge(
			current,
			['build mit pnpm, nicht npm.', 'Tests laufen mit vitest'],
			day
		);
		expect(next).toBe(`${current}\n- [2026-11-26] Tests laufen mit vitest`);
	});

	it('entfernt bei Platzmangel zuerst die ältesten automatischen Zeilen, eigene bleiben', () => {
		const own = 'EIGENE ZEILE bleibt immer';
		let k = own;
		for (let i = 0; i < 30; i++)
			k = mergeKnowledge(k, [`Automatische Notiz Nummer ${i} mit etwas Text`], day, 400);
		expect(k.length).toBeLessThanOrEqual(400);
		expect(k.startsWith(own)).toBe(true);
		expect(k).toContain('Nummer 29');
		expect(k).not.toContain('Nummer 0 ');
	});

	it('leeres Wissen', () => {
		expect(mergeKnowledge('', ['Erste Notiz zum Projekt'], day)).toBe(
			'- [2026-11-26] Erste Notiz zum Projekt'
		);
		expect(mergeKnowledge('', [], day)).toBe('');
	});

	it('Schlüssel und Säuberung', () => {
		expect(noteKey('- [2026-01-01] Foo  Bar.')).toBe('foo bar');
		expect(cleanNote('  1. Ein   Fakt ')).toBe('Ein Fakt');
		expect(cleanNote('x')).toBeNull();
	});
});

describe('Systemanweisung', () => {
	const ctx = (over: Partial<PromptContext> = {}): PromptContext => ({
		role: 'implement',
		project: {
			name: 'Shop',
			repoOwner: 'acme',
			repoName: 'shop',
			defaultBranch: 'main',
			instructions: '',
			testCmd: 'npm test'
		},
		task: { title: 'T', prompt: 'P' },
		readOnly: false,
		expectPlan: false,
		dependencyResults: [],
		replies: [],
		parent: null,
		conflictFiles: [],
		previousError: null,
		...over
	});

	it('enthält Projektwissen, Aufforderung und Arbeitsweise', () => {
		const p = buildSystemPrompt(
			ctx({ project: { ...ctx().project, knowledge: '- [2026-11-01] Build mit pnpm' } })
		);
		expect(p).toContain('## Project knowledge (notes from earlier runs)');
		expect(p).toContain('Build mit pnpm');
		expect(p).toContain('```' + KNOWLEDGE_LANG);
		expect(p).toContain('## Working method');
		expect(p).toContain('review your own diff');
	});

	it('ohne Wissen nur die Aufforderung; Fragen mit kurzer Arbeitsweise', () => {
		const p = buildSystemPrompt(ctx({ question: true, readOnly: true }));
		expect(p).not.toContain('## Project knowledge');
		expect(p).toContain('## Remember what you learned');
		expect(p).toContain('Answer concisely');
		expect(p).not.toContain('review your own diff');
		expect(knowledgeSection('').join('\n')).not.toContain('already listed');
	});
});
