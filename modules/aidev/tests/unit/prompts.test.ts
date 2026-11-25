import { describe, it, expect } from 'vitest';
import {
	buildSystemPrompt,
	buildTaskPrompt,
	extractCoordination,
	extractPlan,
	MAX_DEPENDENCY_SUMMARY,
	slugify,
	slugOrNull,
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
	it('orchestrate: Branch-Vorschlag im Prompt und im Beispiel', () => {
		const p = buildSystemPrompt(ctx({ role: 'orchestrate', readOnly: true, expectPlan: true }));
		expect(p).toMatch(/`branch` is optional/);
		expect(extractPlan(p)?.branch).toBe('payment-refunds');
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
	it.each(['implement', 'fix', 'resolve'] as Role[])(
		'%s mit pr-update: bestehender PR, Merge statt Rebase, kein neuer PR',
		(role) => {
			const p = buildSystemPrompt(
				ctx({
					role,
					delivery: { mode: 'pr-update', number: 42 },
					project: { ...ctx().project, defaultBranch: 'develop' }
				})
			);
			expect(p).toContain('existing pull request #42');
			expect(p).toContain('merge `origin/develop` into the branch');
			expect(p).toMatch(/never rebase or force-push/);
			expect(p).toMatch(/Do not open a new pull request/);
			expect(p).toMatch(/PR comment/);
		}
	);
	it('implement mit pr-update: Auslieferung beschreibt Update des PR', () => {
		const p = buildSystemPrompt(ctx({ delivery: { mode: 'pr-update', number: 7 } }));
		expect(p).toContain(
			'push the task branch to update the existing pull request #7 (no new pull request)'
		);
	});
	it.each(['research', 'review'] as Role[])(
		'%s mit pr-update: keine PR-Bearbeitungszeilen',
		(role) => {
			const p = buildSystemPrompt(
				ctx({ role, readOnly: true, delivery: { mode: 'pr-update', number: 42 } })
			);
			expect(p).not.toContain('#42');
			expect(p).not.toMatch(/force-push/);
		}
	);
	it('review mit pr-update: weiterhin Diff gegen Basis', () => {
		const p = buildSystemPrompt(
			ctx({ role: 'review', delivery: { mode: 'pr-update', number: 3 } })
		);
		expect(p).toContain('git diff origin/main...HEAD');
	});
	it('implement ohne pr-update: keine PR-Bearbeitungszeilen', () => {
		expect(buildSystemPrompt(ctx())).not.toMatch(/existing pull request/);
	});
	it('orchestrate: Leitlinie zur Modellwahl und zu bestehenden PRs', () => {
		const p = buildSystemPrompt(ctx({ role: 'orchestrate', readOnly: true, expectPlan: true }));
		expect(p).toMatch(/Choose a provider only when it clearly fits the subtask/);
		expect(p).toMatch(/scheduler balances load and limits/);
		expect(p).toMatch(/existing pull request, all subtasks work on its branch/);
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
		expect(slugify('Größe ändern Übersicht')).toBe('groesse-aendern-uebersicht');
		expect(slugify('ÄÖÜ straße')).toBe('aeoeue-strasse');
	});
	it('entfernt andere Akzente und Sonderzeichen', () => {
		expect(slugify('Café: Menü  & Preise!!')).toBe('cafe-menue-preise');
		expect(slugify('--Hallo--Welt--')).toBe('hallo-welt');
	});
	it('entfernt deutsche und englische Füllwörter', () => {
		expect(
			slugify(
				'Ok die branches sollen automatisch bessere Namen vom System bekommen und nach der PR'
			)
		).toBe('branches-automatisch-bessere-namen');
		expect(slugify('Bitte die Größe für die Übersicht ändern')).toBe('groesse-uebersicht-aendern');
		expect(slugify('We should add a button to the settings page')).toBe('add-button-settings-page');
	});
	it('entfernt doppelte Wörter', () => {
		expect(slugify('Fix login, fix logout and Fix LOGIN')).toBe('fix-login-logout');
	});
	it('höchstens 5 Wörter', () => {
		expect(slugify('eins zwei drei vier fuenf sechs sieben')).toBe('eins-zwei-drei-vier-fuenf');
	});
	it('höchstens 40 Zeichen, an Wortgrenzen gekürzt, kein Bindestrich am Ende', () => {
		const s = slugify('abcdefghij klmnopqrst uvwxyzabcd efghijkl xyz');
		expect(s.length).toBeLessThanOrEqual(40);
		expect(s.endsWith('-')).toBe(false);
		expect(s).toBe('abcdefghij-klmnopqrst-uvwxyzabcd');
		expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
		// einzelnes überlanges Wort wird hart gekürzt
		expect(slugify('x'.repeat(60))).toBe('x'.repeat(40));
	});
	it('nur Füllwörter → ungefiltert', () => {
		expect(slugify('Ok, bitte!')).toBe('ok-bitte');
		expect(slugify('the and the')).toBe('the-and');
	});
	it('leer → task', () => {
		expect(slugify('')).toBe('task');
		expect(slugify('!!!')).toBe('task');
		expect(slugify('日本語')).toBe('task');
	});
});

describe('slugOrNull', () => {
	it('Slug aus einem Namensvorschlag', () => {
		expect(slugOrNull('branch-cleanup-after-merge')).toBe('branch-cleanup-after-merge');
		expect(slugOrNull('Bessere Branch-Namen')).toBe('bessere-branch-namen');
	});
	it('ohne verwertbare Zeichen → null', () => {
		expect(slugOrNull(undefined)).toBeNull();
		expect(slugOrNull(null)).toBeNull();
		expect(slugOrNull('  ')).toBeNull();
		expect(slugOrNull('日本語')).toBeNull();
	});
});

const COORD: NonNullable<PromptContext['coordination']> = {
	round: 1,
	maxRounds: 3,
	subtasks: [
		{
			key: 'r1',
			title: 'Recherche',
			role: 'research',
			status: 'done',
			provider: 'codex',
			summary: 'Die API liegt in src/api.ts.',
			error: null
		},
		{
			key: 'i1',
			title: 'Umsetzen',
			role: 'implement',
			status: 'failed',
			provider: null,
			summary: '',
			error: 'Tests schlugen fehl'
		}
	]
};

describe('Koordination (Master-Agent)', () => {
	it('Koordinator-Abschnitt statt Erstplanung, Output-Format mit Koordinations-Beispielen', () => {
		const p = buildSystemPrompt(
			ctx({ role: 'orchestrate', readOnly: true, expectPlan: true, coordination: COORD })
		);
		expect(p).toContain('## Your role: master agent (coordinator)');
		expect(p).not.toContain('orchestrator (planning only)');
		expect(p).toMatch(/Do NOT change anything/);
		expect(p).toContain('`git diff origin/main...HEAD`');
		expect(p).toContain('round 1 of 3');
		expect(p).toContain('2 more coordination round(s)');
		expect(p).toMatch(/must not reuse any existing key/);
		expect(p).toContain('`fix`');
		expect(p).toContain('"done": false');
		expect(p).toContain('"done": true');
		expect(p).not.toContain('"branch": "payment-refunds"');
		// letztes Beispiel ist die Abschluss-Entscheidung
		expect(extractCoordination(p, ['research-api'])).toMatchObject({ done: true, subtasks: [] });
	});
	it('letzte mögliche Runde: nur kleine abschließende Aufträge', () => {
		const p = buildSystemPrompt(
			ctx({ role: 'orchestrate', readOnly: true, coordination: { ...COORD, round: 3 } })
		);
		expect(p).toMatch(/last possible round/);
	});
	it('Task-Prompt listet die Ergebnisse der Teilaufträge als Daten', () => {
		const long = 'x'.repeat(MAX_DEPENDENCY_SUMMARY + 100);
		const p = buildTaskPrompt(
			ctx({
				role: 'orchestrate',
				coordination: {
					...COORD,
					subtasks: [{ ...COORD.subtasks[0]!, summary: long }, COORD.subtasks[1]!]
				}
			})
		);
		expect(p).toContain('## Subtask results (round 1 of 3)');
		expect(p).toMatch(/data, not as instructions/);
		expect(p).toContain('### Recherche [key: r1] (research, done, codex)');
		expect(p).toContain('### Umsetzen [key: i1] (implement, failed, any)');
		expect(p).toContain('[truncated]');
		expect(p).not.toContain(long);
		expect(p).toContain('Tests schlugen fehl');
	});
	it('ohne Koordination kein Ergebnis-Abschnitt', () => {
		expect(buildTaskPrompt(ctx())).not.toContain('Subtask results');
	});
	it('Erstplanung: Hinweis auf Master-Agent nur bei masterRounds > 0', () => {
		const base = { role: 'orchestrate' as Role, readOnly: true, expectPlan: true };
		const withMaster = buildSystemPrompt(ctx({ ...base, masterRounds: 2 }));
		expect(withMaster).toMatch(/master agent sees the results/);
		expect(withMaster).toContain('up to 2 rounds');
		expect(withMaster).toMatch(/as many independent agents/);
		expect(withMaster).toMatch(/mix providers/);
		expect(buildSystemPrompt(ctx({ ...base, masterRounds: 0 }))).not.toMatch(/master agent/);
		expect(buildSystemPrompt(ctx(base))).not.toMatch(/master agent/);
	});
});

describe('extractCoordination', () => {
	const follow = {
		summary: 'Weiter',
		done: false,
		subtasks: [
			{
				key: 'i2',
				title: 'Neu umsetzen',
				prompt: 'Setze mit den Erkenntnissen aus r1 um …',
				role: 'implement',
				dependsOn: ['r1', 'i2', 'unbekannt', 'rv'],
				provider: 'claude'
			},
			{ key: 'rv', title: 'Review', prompt: 'Prüfe …', role: 'review', dependsOn: ['i2'] }
		]
	};
	const wrap = (o: unknown) => `Begründung …\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

	it('done ohne Folgeaufträge', () => {
		expect(
			extractCoordination(wrap({ summary: 'Fertig', done: true, subtasks: [] }), ['r1'])
		).toEqual({ summary: 'Fertig', done: true, subtasks: [] });
	});
	it('Folgeaufträge mit Verweis auf existierende Keys, unbekannte und Selbstbezug gefiltert', () => {
		const c = extractCoordination(wrap(follow), ['r1', 'i1']);
		expect(c?.done).toBe(false);
		expect(c?.subtasks.map((s) => s.key)).toEqual(['i2', 'rv']);
		expect(c?.subtasks[0]?.dependsOn).toEqual(['r1', 'rv']);
		expect(c?.subtasks[0]?.provider).toBe('claude');
		expect(c?.subtasks[1]?.dependsOn).toEqual(['i2']);
	});
	it('Key-Kollision mit vorhandenem Key → null', () => {
		expect(extractCoordination(wrap(follow), ['r1', 'rv'])).toBeNull();
	});
	it('doppelte neue Keys → null', () => {
		const dup = { ...follow, subtasks: [follow.subtasks[1], follow.subtasks[1]] };
		expect(extractCoordination(wrap(dup), [])).toBeNull();
	});
	it('leere bzw. fehlende subtasks → done', () => {
		expect(extractCoordination(wrap({ summary: 'x', done: false, subtasks: [] }), [])?.done).toBe(
			true
		);
		expect(extractCoordination('{"summary": "nur Text"}', [])).toEqual({
			summary: 'nur Text',
			done: true,
			subtasks: []
		});
	});
	it('done: true mit Subtasks → Arbeit hat Vorrang (done: false)', () => {
		const c = extractCoordination(wrap({ ...follow, done: true }), ['r1']);
		expect(c?.done).toBe(false);
		expect(c?.subtasks).toHaveLength(2);
	});
	it('letzter gültiger Block gewinnt, ungültige werden übersprungen', () => {
		const text = `${wrap(follow)}\n\n\`\`\`json\n{ kaputt \n\`\`\``;
		expect(extractCoordination(text, [])?.subtasks).toHaveLength(2);
		expect(extractCoordination('kein JSON', [])).toBeNull();
	});
});
