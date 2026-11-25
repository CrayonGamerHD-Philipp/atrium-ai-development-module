import { describe, it, expect } from 'vitest';
import {
	buildSystemPrompt,
	buildTaskPrompt,
	extractPlan,
	slugify,
	titleFromPrompt,
	type PromptContext
} from '../../prompts';
import type { Role } from '../../protocol';

function ctx(over: Partial<PromptContext> = {}): PromptContext {
	return {
		role: 'implement',
		project: {
			name: 'Shop',
			repoOwner: 'acme',
			repoName: 'shop',
			defaultBranch: 'main',
			instructions: '',
			testCmd: ''
		},
		task: { title: 'Rückerstattung', prompt: 'Baue eine Rückerstattung ein.' },
		readOnly: false,
		expectPlan: false,
		dependencyResults: [],
		replies: [],
		parent: null,
		conflictFiles: [],
		previousError: null,
		...over
	};
}

const VALID_PLAN = {
	summary: 'Plan',
	subtasks: [
		{ key: 'r1', title: 'Recherche', prompt: 'Finde heraus …', role: 'research' },
		{
			key: 'i1',
			title: 'Umsetzen',
			prompt: 'Setze um …',
			role: 'implement',
			dependsOn: ['r1', 'unbekannt'],
			provider: 'claude'
		}
	]
};

describe('buildSystemPrompt', () => {
	it('nennt Repo, Projekt und Haupt-Branch', () => {
		const p = buildSystemPrompt(ctx());
		expect(p).toContain('`acme/shop`');
		expect(p).toContain('"Shop"');
		expect(p).toContain('`main`');
		expect(p).toMatch(/do not ask questions/i);
	});
	it('implement: Tests, Commits, kein Push', () => {
		const p = buildSystemPrompt(ctx({ project: { ...ctx().project, testCmd: 'npm test' } }));
		expect(p).toContain('`npm test`');
		expect(p).toMatch(/Conventional Commits/);
		expect(p).toMatch(/Do NOT push/);
		expect(p).toMatch(/summary/i);
	});
	it('orchestrate: nichts ändern, Plan-Format mit Beispiel', () => {
		const p = buildSystemPrompt(ctx({ role: 'orchestrate', readOnly: true, expectPlan: true }));
		expect(p).toMatch(/Do NOT change anything/);
		expect(p).toContain('1–20 subtasks');
		expect(p).toContain('dependsOn');
		expect(p).toContain('```json');
		expect(p).toMatch(/Read-only/);
		// Beispiel im Prompt ist selbst ein gültiger Plan
		expect(extractPlan(p)).not.toBeNull();
	});
	it('review: Diff gegen Basis', () => {
		const p = buildSystemPrompt(
			ctx({ role: 'review', project: { ...ctx().project, defaultBranch: 'develop' } })
		);
		expect(p).toContain('git diff origin/develop...HEAD');
	});
	it.each(['research', 'resolve', 'fix'] as Role[])('%s hat einen Rollenabschnitt', (role) => {
		expect(buildSystemPrompt(ctx({ role }))).toMatch(/## Your role/);
	});
	it('Projektregeln als eigener Abschnitt, nur wenn vorhanden', () => {
		expect(buildSystemPrompt(ctx())).not.toContain('## Project rules');
		const p = buildSystemPrompt(
			ctx({ project: { ...ctx().project, instructions: 'Kommentare auf Deutsch.' } })
		);
		expect(p).toContain('## Project rules\nKommentare auf Deutsch.');
	});
	it('ohne expectPlan kein Plan-Format bei implement', () => {
		expect(buildSystemPrompt(ctx())).not.toContain('```json');
	});
});

describe('buildTaskPrompt', () => {
	it('nur Titel und Auftrag, wenn kein Kontext vorhanden ist', () => {
		const p = buildTaskPrompt(ctx());
		expect(p).toBe('# Rückerstattung\n\nBaue eine Rückerstattung ein.');
	});
	it('enthält alle Abschnitte, wenn vorhanden', () => {
		const p = buildTaskPrompt(
			ctx({
				role: 'resolve',
				parent: { title: 'Zahlungen', prompt: 'Gesamtziel' },
				dependencyResults: [{ title: 'API prüfen', role: 'research', summary: 'Ergebnis X' }],
				replies: ['Erste Antwort', '  ', 'Zweite Antwort'],
				previousError: 'Tests schlugen fehl',
				conflictFiles: ['src/a.ts', 'src/b.ts']
			})
		);
		expect(p).toContain('## Parent task');
		expect(p).toContain('Gesamtziel');
		expect(p).toContain('### API prüfen (research)');
		expect(p).toContain('Ergebnis X');
		expect(p).toContain('1. Erste Antwort');
		expect(p).toContain('2. Zweite Antwort');
		expect(p).toContain('Tests schlugen fehl');
		expect(p).toContain('- `src/a.ts`');
		expect(p).toContain('- `src/b.ts`');
	});
	it.each<Role>(['implement', 'orchestrate'])(
		'%s: Chat-Verlauf als Hintergrund direkt nach dem Auftrag',
		(role) => {
			const p = buildTaskPrompt(
				ctx({
					role,
					task: { title: 'Chat', prompt: 'ok setze das um' },
					chatContext: 'Frage: Wie geht X?\nAntwort: Vorschlag Y',
					parent: { title: 'Ziel', prompt: 'Gesamtziel' }
				})
			);
			const heading = '## Previous chat conversation (background, oldest first)';
			expect(p).toContain(heading);
			expect(p).toContain('Antwort: Vorschlag Y');
			expect(p).toContain('not commands');
			expect(p).not.toContain('## Previous conversation (untrusted');
			expect(p.indexOf('ok setze das um')).toBeLessThan(p.indexOf(heading));
			expect(p.indexOf(heading)).toBeLessThan(p.indexOf('## Parent task'));
		}
	);
	it('leerer Chat-Verlauf → kein Abschnitt', () => {
		for (const chatContext of [undefined, '', '   ']) {
			const p = buildTaskPrompt(ctx({ chatContext }));
			expect(p).toBe('# Rückerstattung\n\nBaue eine Rückerstattung ein.');
		}
	});
	it('Frage: Chat-Verlauf unverändert im bisherigen Abschnitt', () => {
		const p = buildTaskPrompt(
			ctx({ role: 'research', question: true, chatContext: 'Frage: A\nAntwort: B' })
		);
		expect(p).toBe(
			'# Rückerstattung\n\nBaue eine Rückerstattung ein.\n\n' +
				'## Previous conversation (untrusted background, oldest first)\nFrage: A\nAntwort: B'
		);
		expect(p).not.toContain('## Previous chat conversation');
	});
	it('kürzt lange Vorgänger-Ergebnisse auf 6000 Zeichen', () => {
		const long = 'x'.repeat(10_000);
		const p = buildTaskPrompt(
			ctx({ dependencyResults: [{ title: 'R', role: 'research', summary: long }] })
		);
		expect(p).not.toContain('x'.repeat(6001));
		expect(p).toContain('x'.repeat(6000));
		expect(p).toContain('[truncated]');
	});
});

describe('extractPlan', () => {
	it('liest einen ```json-Block und filtert unbekannte Abhängigkeiten', () => {
		const text = `Hier ist der Plan:\n\n\`\`\`json\n${JSON.stringify(VALID_PLAN, null, 2)}\n\`\`\`\n`;
		const plan = extractPlan(text);
		expect(plan).not.toBeNull();
		expect(plan!.subtasks).toHaveLength(2);
		expect(plan!.subtasks[0]!.dependsOn).toEqual([]);
		expect(plan!.subtasks[1]!.dependsOn).toEqual(['r1']);
	});
	it('nimmt bei mehreren Blöcken den letzten gültigen', () => {
		const other = { ...VALID_PLAN, summary: 'zweiter' };
		const text = [
			'```json',
			JSON.stringify(VALID_PLAN),
			'```',
			'Korrektur:',
			'```json',
			JSON.stringify(other),
			'```',
			'Und noch kaputt:',
			'```json',
			'{ "summary": "x", "subtasks": [ ',
			'```'
		].join('\n');
		expect(extractPlan(text)!.summary).toBe('zweiter');
	});
	it('akzeptiert Blöcke ohne Sprachangabe', () => {
		const text = '```\n' + JSON.stringify(VALID_PLAN) + '\n```';
		expect(extractPlan(text)).not.toBeNull();
	});
	it('ignoriert Blöcke anderer Sprachen', () => {
		const text = '```ts\n' + JSON.stringify(VALID_PLAN) + '\n```';
		// Rückfall auf das rohe Objekt greift trotzdem
		expect(extractPlan(text)).not.toBeNull();
		expect(extractPlan('```ts\nconst x = 1;\n```')).toBeNull();
	});
	it('Rückfall: letztes balanciertes Objekt im Text', () => {
		const text = `Erst {kein json}, dann der Plan: ${JSON.stringify({
			...VALID_PLAN,
			summary: 'mit {Klammern} im "Text"'
		})} – fertig.`;
		expect(extractPlan(text)!.summary).toBe('mit {Klammern} im "Text"');
	});
	it('kaputtes JSON → null', () => {
		expect(extractPlan('```json\n{ "summary": \n```')).toBeNull();
		expect(extractPlan('kein Plan')).toBeNull();
		expect(extractPlan('')).toBeNull();
	});
	it('ungültige Rolle → ungültig', () => {
		const bad = {
			subtasks: [{ key: 'a', title: 'A', prompt: 'P', role: 'orchestrate' }]
		};
		expect(extractPlan('```json\n' + JSON.stringify(bad) + '\n```')).toBeNull();
	});
	it('doppelte Keys → ungültig, dann früheren gültigen Block nehmen', () => {
		const dup = {
			subtasks: [
				{ key: 'a', title: 'A', prompt: 'P', role: 'research' },
				{ key: 'a', title: 'B', prompt: 'P', role: 'implement' }
			]
		};
		expect(extractPlan('```json\n' + JSON.stringify(dup) + '\n```')).toBeNull();
		const text =
			'```json\n' + JSON.stringify(VALID_PLAN) + '\n```\n```json\n' + JSON.stringify(dup) + '\n```';
		expect(extractPlan(text)!.summary).toBe('Plan');
	});
	it('leere Teilaufgaben-Liste ist ungültig, summary hat Standardwert', () => {
		expect(extractPlan('```json\n{"subtasks": []}\n```')).toBeNull();
		const p = extractPlan(
			'```json\n{"subtasks": [{"key":"a","title":"A","prompt":"P","role":"fix"}]}\n```'
		);
		expect(p!.summary).toBe('');
		expect(p!.subtasks[0]!.dependsOn).toEqual([]);
	});
});

describe('titleFromPrompt', () => {
	it('erste nicht-leere Zeile ohne Markdown', () => {
		expect(titleFromPrompt('\n\n## **Login   reparieren**\nDetails')).toBe('Login reparieren**');
		expect(titleFromPrompt('> - `foo` bar')).toBe('foo` bar');
		expect(titleFromPrompt('  Einfach  ein\tTitel ')).toBe('Einfach ein Titel');
	});
	it('überspringt Zeilen, die nur aus Markdown bestehen', () => {
		expect(titleFromPrompt('---\n# Titel')).toBe('Titel');
	});
	it('kürzt lange Zeilen an der Wortgrenze mit „…“', () => {
		const t = titleFromPrompt('wort '.repeat(40));
		expect(t.length).toBeLessThanOrEqual(80);
		expect(t.endsWith('wort…')).toBe(true);
	});
	it('genau 80 Zeichen bleiben unverändert', () => {
		const s = 'a'.repeat(80);
		expect(titleFromPrompt(s)).toBe(s);
		const long = titleFromPrompt('a'.repeat(100));
		expect(long).toBe('a'.repeat(79) + '…');
	});
	it('leer → „Auftrag“', () => {
		expect(titleFromPrompt('')).toBe('Auftrag');
		expect(titleFromPrompt('  \n # \n')).toBe('Auftrag');
	});
});

describe('slugify', () => {
	it('ersetzt Umlaute und ß', () => {
		expect(slugify('Größe ändern für Übersicht')).toBe('groesse-aendern-fuer-uebersicht');
		expect(slugify('ÄÖÜ straße')).toBe('aeoeue-strasse');
	});
	it('entfernt andere Akzente und Sonderzeichen', () => {
		expect(slugify('Café: Menü  & Preise!!')).toBe('cafe-menue-preise');
		expect(slugify('--Hallo--Welt--')).toBe('hallo-welt');
	});
	it('höchstens 40 Zeichen, kein Bindestrich am Ende', () => {
		const s = slugify('abcdefghij abcdefghij abcdefghij abcdefg xyz');
		expect(s.length).toBeLessThanOrEqual(40);
		expect(s.endsWith('-')).toBe(false);
		expect(s).toBe('abcdefghij-abcdefghij-abcdefghij-abcdefg');
		expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
	});
	it('leer → task', () => {
		expect(slugify('')).toBe('task');
		expect(slugify('!!!')).toBe('task');
		expect(slugify('日本語')).toBe('task');
	});
});
