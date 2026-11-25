import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/providers/claude.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { codexArgs, createCodexParser, readCodexSessionLimits, withSessionLimits } from '../src/providers/codex.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { createGeminiParser } from '../src/providers/gemini.ts';
import { openAiConfigArgs } from '../src/providers/openai-compat.ts';
import type { LineParser, NormalizedEvent } from '../src/providers/types.ts';
import { accountConfigSchema } from '../src/config.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const now = () => new Date('2026-11-24T10:00:00.000Z');

function run(parser: LineParser, file: string, exitCode = 0, stderr = '') {
	const events: NormalizedEvent[] = [];
	for (const line of readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
		if (line.trim()) events.push(...parser.line(line));
	}
	for (const l of stderr.split('\n')) if (l.trim()) events.push(...parser.stderr(l));
	const fin = parser.finish(exitCode, stderr);
	events.push(...fin.events);
	return { events, result: fin.result };
}

const kinds = (evs: NormalizedEvent[]) => evs.map((e) => e.kind);

describe('Claude-Parser', () => {
	it('normalisiert eine erfolgreiche Sitzung', () => {
		const { events, result } = run(createClaudeParser(now), 'claude-success.jsonl');
		expect(result.sessionId).toBe('ff9a6413-c2ca-4e2d-80e3-8d1e56e54afe');
		expect(result.exitCode).toBe(0);
		expect(result.limit).toBeNull();
		expect(result.lastText).toBe('Ich habe die README angepasst.');
		expect(result.usage).toEqual({
			model: 'claude-sonnet-5',
			inputTokens: 12,
			outputTokens: 45,
			cacheReadTokens: 20000,
			cacheWriteTokens: 3332,
			costUsd: 0.0123
		});
		expect(kinds(events)).toContain('thinking');
		const tool = events.find((e) => e.kind === 'tool');
		expect(tool).toMatchObject({ payload: { name: 'Bash', input: { command: 'ls -la' } } });
		const results = events.filter((e) => e.kind === 'tool-result');
		expect(results[0]).toMatchObject({ payload: { name: 'Bash', isError: false } });
		expect(results[1]).toMatchObject({ payload: { name: 'Edit', isError: true, output: 'Fehler: Datei nicht gefunden' } });
		// kaputte und fremde Zeilen brechen nicht ab, sondern werden als Text weitergegeben
		const texts = events.filter((e) => e.kind === 'text').map((e) => (e as unknown as { payload: { text: string } }).payload.text);
		expect(texts).toContain('das ist keine JSON-Zeile');
		expect(events.filter((e) => e.kind === 'session')).toHaveLength(1);
	});

	it('erkennt Limits aus rate_limit_event und synthetischer Meldung', () => {
		const { events, result } = run(createClaudeParser(now), 'claude-limit.jsonl', 1);
		expect(result.limit?.limitKind).toBe('5h');
		expect(result.limit?.resetsAt).toBe(new Date(1795566600 * 1000).toISOString());
		expect(events.filter((e) => e.kind === 'limit')).toHaveLength(1);
		expect(result.exitCode).not.toBe(0);
	});

	it('meldet den Limit-Stand bei jedem rate_limit_event (auch allowed)', () => {
		const { events, result } = run(createClaudeParser(now), 'claude-limits.jsonl');
		const limits = events.filter((e) => e.kind === 'limits');
		expect(limits).toHaveLength(3);
		expect(limits[0]).toEqual({
			kind: 'limits',
			windows: [{ window: '5h', label: 'five_hour', usedPercent: 37, resetsAt: new Date(1795566600 * 1000).toISOString(), status: 'allowed' }]
		});
		expect(limits[1]).toMatchObject({ windows: [{ window: 'week-sonnet', usedPercent: 85, status: 'warning' }] });
		expect(limits[2]).toMatchObject({
			windows: [
				{ window: 'week', usedPercent: 52, resetsAt: new Date(1795999999000).toISOString() },
				{ window: 'week-opus', usedPercent: 10 }
			]
		});
		// bisheriges Verhalten: Warnung als Status, kein Limit-Treffer
		expect(events.filter((e) => e.kind === 'status')).toHaveLength(1);
		expect(events.filter((e) => e.kind === 'limit')).toHaveLength(0);
		expect(result.limit).toBeNull();
		expect(result.exitCode).toBe(0);
	});

	it('meldet den Limit-Stand auch in den bestehenden Fixtures', () => {
		const ok = run(createClaudeParser(now), 'claude-success.jsonl');
		expect(ok.events.filter((e) => e.kind === 'limits')).toEqual([
			{ kind: 'limits', windows: [{ window: '5h', label: 'five_hour', usedPercent: null, resetsAt: new Date(1795566600 * 1000).toISOString(), status: 'allowed' }] }
		]);
		const hit = run(createClaudeParser(now), 'claude-limit.jsonl', 1);
		const kindsHit = kinds(hit.events);
		expect(kindsHit.indexOf('limits')).toBeGreaterThanOrEqual(0);
		expect(kindsHit.indexOf('limits')).toBeLessThan(kindsHit.indexOf('limit'));
		expect(hit.events.find((e) => e.kind === 'limits')).toMatchObject({ windows: [{ window: '5h', status: 'rejected' }] });
	});

	it('erkennt Limits in stderr bei Fehlschlag', () => {
		const p = createClaudeParser(now);
		const fin = p.finish(1, 'API Error: 429 rate_limit_error');
		expect(fin.result.limit?.limitKind).toBe('rate');
	});
});

describe('Codex-Parser', () => {
	it('normalisiert eine erfolgreiche Sitzung', () => {
		const { events, result } = run(createCodexParser('codex', 'gpt-5', now), 'codex-success.jsonl');
		expect(result.sessionId).toBe('01a20fb8-67b8-7ee3-80bd-f716063bef6e');
		expect(result.lastText).toBe('Fertig: hallo ausgegeben.');
		expect(result.usage).toEqual({
			model: 'gpt-5',
			inputTokens: 4014 + 1000,
			outputTokens: 49,
			cacheReadTokens: 23552,
			cacheWriteTokens: 0,
			costUsd: null
		});
		const res = events.filter((e) => e.kind === 'tool-result');
		expect(res[0]).toMatchObject({ payload: { name: 'shell', output: 'hallo\n', isError: false } });
		expect(res[1]).toMatchObject({ payload: { isError: true, exitCode: 1 } });
		expect(events.find((e) => e.kind === 'tool' && (e.payload as { name: string }).name === 'docs.search')).toBeTruthy();
		expect(events.find((e) => e.kind === 'tool' && (e.payload as { name: string }).name === 'file_change')).toBeTruthy();
		expect(kinds(events)).toContain('thinking');
		expect(kinds(events)).toContain('status');
		expect(result.limit).toBeNull();
	});

	it('meldet rate_limits aus dem Stream', () => {
		const { events, result } = run(createCodexParser('codex', '', now), 'codex-ratelimits.jsonl');
		expect(events.filter((e) => e.kind === 'limits')).toEqual([
			{
				kind: 'limits',
				windows: [
					{ window: '5h', label: 'primary', usedPercent: 12.5, resetsAt: '2026-11-24T11:00:00.000Z', status: 'allowed' },
					{ window: 'week', label: 'secondary', usedPercent: 40, resetsAt: new Date(1795566600 * 1000).toISOString(), status: 'allowed' }
				]
			}
		]);
		expect(result.lastText).toBe('Fertig.');
		expect(result.usage?.inputTokens).toBe(100);
		// Fixture ohne rate_limits: keine limits-Ereignisse
		expect(run(createCodexParser('codex', '', now), 'codex-success.jsonl').events.filter((e) => e.kind === 'limits')).toEqual([]);
	});

	it('liest den Limit-Stand aus der Sitzungsdatei nach', async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
		try {
			const thread = '01a20fb8-67b8-7ee3-80bd-f716063bef6e';
			const d = now();
			const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
			await mkdir(dir, { recursive: true });
			const lines = [
				{ timestamp: '2026-11-24T09:00:00.000Z', type: 'session_meta', payload: { id: thread } },
				{ timestamp: '2026-11-24T09:30:00.000Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 60 } } } },
				{ timestamp: '2026-11-24T09:50:00.000Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_in_seconds: 600 } } } },
				{ timestamp: '2026-11-24T09:55:00.000Z', type: 'response_item', payload: { type: 'message' } }
			];
			await writeFile(path.join(dir, `rollout-2026-11-24T09-00-00-${thread}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{kaputt\n');
			expect(await readCodexSessionLimits(home, thread, now())).toEqual([
				// resets_in_seconds relativ zum Zeitstempel der Zeile
				{ window: '5h', label: 'primary', usedPercent: 20, resetsAt: '2026-11-24T10:00:00.000Z', status: 'allowed' }
			]);
			expect(await readCodexSessionLimits(home, 'unbekannt-1234', now())).toBeNull();
			expect(await readCodexSessionLimits(path.join(home, 'fehlt'), thread, now())).toBeNull();
			expect(await readCodexSessionLimits(home, '../../etc', now())).toBeNull();

			// Prozess ohne limits im Stream → Ereignis aus der Sitzungsdatei am Ende
			const q = new AsyncQueue<NormalizedEvent>();
			q.push({ kind: 'session', id: thread });
			q.end();
			const wrapped = withSessionLimits(
				{ events: q, done: Promise.resolve({ exitCode: 0, sessionId: thread, usage: null, lastText: '', limit: null, error: null }), kill() {} },
				home,
				now
			);
			const evs: NormalizedEvent[] = [];
			for await (const e of wrapped.events) evs.push(e);
			expect(kinds(evs)).toEqual(['session', 'limits']);
			expect((await wrapped.done).exitCode).toBe(0);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it('erkennt das Nutzungslimit', () => {
		const { events, result } = run(createCodexParser('codex', '', now), 'codex-limit.jsonl', 1);
		expect(result.limit).toMatchObject({ limitKind: '5h', resetsAt: '2026-11-24T12:15:00.000Z' });
		expect(events.filter((e) => e.kind === 'limit')).toHaveLength(1);
		expect(result.error).toContain('usage limit');
	});

	it('baut Argumente für neue und fortgesetzte Sitzungen', () => {
		const account = accountConfigSchema.parse({ key: 'codex-main', provider: 'codex', reasoningEffort: 'high' });
		const base = {
			cwd: '/work/wt/1',
			prompt: 'p',
			systemPrompt: 's',
			model: 'gpt-5',
			env: {},
			readOnly: false,
			signal: new AbortController().signal,
			account,
			tmpDir: '/tmp/x'
		};
		expect(codexArgs({ ...base, resumeSessionId: null }, { provider: 'codex', configArgs: [], model: 'gpt-5' })).toEqual([
			'exec',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--skip-git-repo-check',
			'-m',
			'gpt-5',
			'-c',
			'model_reasoning_effort="high"',
			'-C',
			'/work/wt/1',
			'-'
		]);
		const question = codexArgs({ ...base, question: true, readOnly: true, resumeSessionId: null }, { provider: 'codex', configArgs: [], model: null });
		expect(question).toContain('read-only');
		expect(question).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		const resume = codexArgs({ ...base, resumeSessionId: 'abc' }, { provider: 'codex', configArgs: [], model: null });
		expect(resume.slice(0, 2)).toEqual(['exec', 'resume']);
		expect(resume.slice(-2)).toEqual(['abc', '-']);
		expect(resume).not.toContain('-C');
	});

	it('konfiguriert OpenAI-kompatible Anbieter', () => {
		const acct = accountConfigSchema.parse({
			key: 'local-llm',
			provider: 'openai-api',
			baseUrl: 'http://llm:8000/v1',
			apiKeyEnv: 'LOCAL_LLM_KEY',
			model: 'qwen3-coder'
		});
		expect(openAiConfigArgs(acct)).toEqual([
			'model_provider="aidev_local-llm"',
			'model_providers.aidev_local-llm.name="local-llm"',
			'model_providers.aidev_local-llm.base_url="http://llm:8000/v1"',
			'model_providers.aidev_local-llm.env_key="LOCAL_LLM_KEY"',
			'model_providers.aidev_local-llm.wire_api="responses"'
		]);
	});
});

describe('Gemini-Parser', () => {
	it('normalisiert eine erfolgreiche Sitzung (Deltas zusammengefasst)', () => {
		const { events, result } = run(createGeminiParser('', now), 'gemini-success.jsonl');
		expect(result.sessionId).toBe('c3a1d4e2-9f5b-4c1a-8e2d-1b2c3d4e5f60');
		expect(result.lastText).toBe('README ist aktualisiert.');
		expect(result.exitCode).toBe(0);
		expect(result.usage).toMatchObject({ model: 'gemini-3-pro', inputTokens: 1000, outputTokens: 300, cacheReadTokens: 200 });
		const texts = events.filter((e) => e.kind === 'text').map((e) => (e as unknown as { payload: { text: string } }).payload.text);
		expect(texts[0]).toBe('Ich schaue mir die Datei an.');
		expect(texts).toContain('kein JSON');
		const res = events.filter((e) => e.kind === 'tool-result');
		expect(res[0]).toMatchObject({ payload: { name: 'read_file', isError: false, output: '# Titel' } });
		expect(res[1]).toMatchObject({ payload: { name: 'replace', isError: true, output: 'old_string nicht gefunden' } });
		// Warnungen sind kein Fehler
		expect(kinds(events)).not.toContain('error');
	});

	it('erkennt RESOURCE_EXHAUSTED', () => {
		const { result } = run(createGeminiParser('', now), 'gemini-limit.jsonl', 1);
		expect(result.limit).toMatchObject({ limitKind: 'rate', resetsAt: '2026-11-24T10:00:41.000Z' });
		expect(result.exitCode).toBe(1);
	});
});
