import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { isTransientGitError } from '../src/git/workspace.ts';
import { stripConflictMarkers } from '../src/providers/fake.ts';
import { ResearchBridge, RESEARCH_DIR, RESEARCH_SCRIPT, researchPromptSection } from '../src/research.ts';
import {
	addUsage,
	conflictRepairPrompt,
	isTransientAgentError,
	REPAIR_MARKER,
	tailText,
	testRepairPrompt
} from '../src/selfheal.ts';

describe('Selbstreparatur', () => {
	it('erkennt vorübergehende Agent-Fehler, aber keine echten Fehler', () => {
		expect(isTransientAgentError('API Error: 529 {"type":"overloaded_error"}')).toBe(true);
		expect(isTransientAgentError('Error: 503 Service Unavailable')).toBe(true);
		expect(isTransientAgentError('stream disconnected before completion')).toBe(true);
		expect(isTransientAgentError('read ECONNRESET')).toBe(true);
		expect(isTransientAgentError('TypeError: cannot read properties of undefined')).toBe(false);
		expect(isTransientAgentError('Agent beendet mit Exit-Code 1')).toBe(false);
		expect(isTransientAgentError(null)).toBe(false);
	});

	it('erkennt vorübergehende git-Netzwerkfehler', () => {
		expect(isTransientGitError(new Error('fatal: unable to access …: Could not resolve host: github.com'))).toBe(true);
		expect(isTransientGitError(new Error('error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502'))).toBe(true);
		expect(isTransientGitError(new Error("fatal: couldn't find remote ref main"))).toBe(false);
		expect(isTransientGitError(new Error('Authentication failed'))).toBe(false);
	});

	it('Reparaturaufträge enthalten Marker, Befehl, Ausgabe bzw. Dateien', () => {
		const t = testRepairPrompt({ testCmd: 'npm test', exitCode: 1, output: 'FAIL x.test.ts\n```\nboom', round: 1, rounds: 2 });
		expect(t.startsWith(`${REPAIR_MARKER} tests`)).toBe(true);
		expect(t).toContain('`npm test`');
		expect(t).toContain('FAIL x.test.ts');
		// Zaun ist länger als jede Backtick-Folge der Ausgabe
		expect(t).toContain('````\nFAIL');
		const c = conflictRepairPrompt({ files: ['a.ts', 'b/c.md'], target: 'origin/main', round: 1, rounds: 2 });
		expect(c.startsWith(`${REPAIR_MARKER} conflict`)).toBe(true);
		expect(c).toContain('- `a.ts`');
		expect(c).toContain('- `b/c.md`');
		expect(c).toContain('Do NOT rebase');
	});

	it('kürzt lange Ausgaben vom Anfang her', () => {
		const long = 'x'.repeat(100) + 'ENDE';
		expect(tailText(long, 10)).toMatch(/xxxxxxENDE$/);
		expect(tailText(long, 10)).toContain('gekürzt');
		expect(tailText('kurz', 10)).toBe('kurz');
	});

	it('addiert den Verbrauch mehrerer Aufrufe', () => {
		const u = { model: 'm', inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, costUsd: 0.5 };
		expect(addUsage(null, u)).toBe(u);
		expect(addUsage(u, null)).toBe(u);
		expect(addUsage(u, { ...u, costUsd: null })).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 2, costUsd: 0.5 });
		expect(addUsage({ ...u, costUsd: null }, { ...u, costUsd: null })?.costUsd).toBeNull();
	});

	it('Fake-Agent: Konfliktmarker entfernen, beide Seiten behalten', () => {
		const text = ['a', '<<<<<<< HEAD', 'meins', '=======', 'deins', '>>>>>>> abc123', 'z'].join('\n');
		expect(stripConflictMarkers(text)).toBe(['a', 'meins', 'deins', 'z'].join('\n'));
	});
});

describe('Konfiguration', () => {
	const base = { ATRIUM_URL: 'https://atrium.example.org', ATRIUM_API_KEY: 'geheim-12345' };
	it('Standardwerte für Selbstreparatur und Recherche', () => {
		const c = loadConfig({ env: base, cwd: os.tmpdir() });
		expect(c).toMatchObject({ autoRepairRounds: 2, research: true, researchMax: 3, researchAccounts: [] });
	});
	it('Umgebungsvariablen', () => {
		const c = loadConfig({
			env: { ...base, AUTO_REPAIR_ROUNDS: '0', RESEARCH: 'off', RESEARCH_MAX: '5', RESEARCH_ACCOUNTS: 'gemini-1, codex-1' },
			cwd: os.tmpdir()
		});
		expect(c).toMatchObject({ autoRepairRounds: 0, research: false, researchMax: 5, researchAccounts: ['gemini-1', 'codex-1'] });
	});
	it('ungültige Werte', () => {
		expect(() => loadConfig({ env: { ...base, AUTO_REPAIR_ROUNDS: '99' }, cwd: os.tmpdir() })).toThrow(/AUTO_REPAIR_ROUNDS/);
		expect(() => loadConfig({ env: { ...base, RESEARCH: 'vielleicht' }, cwd: os.tmpdir() })).toThrow(/RESEARCH/);
	});
});

describe('Recherche-Schnittstelle', () => {
	let dir = '';
	let bridge: ResearchBridge | null = null;
	afterEach(async () => {
		await bridge?.stop();
		bridge = null;
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it('Hilfsskript fordert an, wartet und gibt die Antwort aus', async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), 'aidev-research-'));
		const asked: string[] = [];
		bridge = new ResearchBridge({
			worktree: dir,
			max: 1,
			pollMs: 20,
			handle: (req) => {
				asked.push(req.question);
				return Promise.resolve(`Antwort auf: ${req.question}`);
			}
		});
		await bridge.start();
		// Skript asynchron starten (die Brücke läuft in derselben Ereignisschleife)
		const call = (q: string) =>
			new Promise<{ code: number; out: string; err: string }>((resolve) => {
				execFile(process.execPath, [path.join(dir, RESEARCH_SCRIPT), q], { cwd: dir, encoding: 'utf8' }, (err, out, stderr) =>
					resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out, err: stderr })
				);
			});
		const first = await call('Welche Node-Version?');
		expect(first.code).toBe(0);
		expect(first.out.trim()).toBe('Antwort auf: Welche Node-Version?');
		// Höchstzahl erreicht → Fehlermeldung statt Recherche
		const second = await call('Noch eine Frage?');
		expect(second.code).toBe(1);
		expect(second.err).toContain('Höchstzahl');
		expect(asked).toEqual(['Welche Node-Version?']);
	});

	it('ungültige Anfrage wird mit Fehler beantwortet; stop() beantwortet offene Anfragen', async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), 'aidev-research-'));
		bridge = new ResearchBridge({ worktree: dir, max: 3, pollMs: 20, handle: () => new Promise(() => undefined), stopWaitMs: 50 });
		await bridge.start();
		const rd = path.join(dir, RESEARCH_DIR);
		await writeFile(path.join(rd, 'bad.request.json'), '{"question": ""}');
		await new Promise((r) => setTimeout(r, 150));
		expect(JSON.parse(await readFile(path.join(rd, 'bad.answer.json'), 'utf8'))).toMatchObject({ ok: false });
		await writeFile(path.join(rd, 'hang.request.json'), '{"question": "Hängt das?"}');
		await new Promise((r) => setTimeout(r, 150));
		await bridge.stop();
		expect(JSON.parse(await readFile(path.join(rd, 'hang.answer.json'), 'utf8'))).toMatchObject({ ok: false, error: 'Der Lauf ist beendet' });
	});

	it('Prompt-Abschnitt nennt Befehl und Höchstzahl', () => {
		const s = researchPromptSection({ max: 2 });
		expect(s).toContain(`node ${RESEARCH_SCRIPT}`);
		expect(s).toContain('at most 2 times');
	});
});
