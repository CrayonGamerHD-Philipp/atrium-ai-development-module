/**
 * Deterministischer Agent für Tests und Vorführungen (kein externer Prozess). Szenarien über Marker im Auftrag:
 * `[fake:fail]` (Fehler), `[fake:limit]` (5-Stunden-Limit), `[fake:plan]` (gültiger Plan als ```json-Block),
 * `[fake:slow]` (läuft bis zum Abbruch bzw. höchstens 60 s), `[fake:commit]` (Agent committet selbst).
 * Meldet außerdem einen Limit-Stand (`limits`, 5-Stunden-Fenster).
 * Schreibt `AIDEV_FAKE.md` mit einem Auszug des Auftrags (nicht bei `readOnly`).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AsyncQueue, sleep } from '../util/async.ts';
import { exec } from '../util/proc.ts';
import type {
	AgentProcess,
	AgentResult,
	NormalizedEvent,
	ProbeResult,
	ProviderAdapter,
	StartOptions
} from './types.ts';

export const FAKE_PLAN = {
	summary: 'Zwei Schritte: erst recherchieren, dann umsetzen',
	subtasks: [
		{ key: 'research', title: 'Bestehenden Code untersuchen', prompt: 'Untersuche den Code.', role: 'research', dependsOn: [] },
		{ key: 'impl', title: 'Änderung umsetzen', prompt: 'Setze die Änderung um.', role: 'implement', dependsOn: ['research'] }
	]
};

export const fakeAdapter: ProviderAdapter = {
	id: 'fake',
	probe(): Promise<ProbeResult> {
		return Promise.resolve({ ok: true, loggedIn: true, version: 'fake-1' });
	},
	start(o: StartOptions): AgentProcess {
		const queue = new AsyncQueue<NormalizedEvent>();
		const ctrl = new AbortController();
		const onAbort = () => ctrl.abort();
		o.signal.addEventListener('abort', onAbort, { once: true });
		if (o.signal.aborted) ctrl.abort();
		const sessionId = o.resumeSessionId ?? `fake-${Date.now().toString(36)}`;
		const p = o.prompt;
		const done = (async (): Promise<AgentResult> => {
			const base: AgentResult = { exitCode: 0, sessionId, usage: null, lastText: '', limit: null, error: null };
			try {
				queue.push({ kind: 'session', id: sessionId });
				queue.push({ kind: 'system', payload: { text: 'Fake-Agent gestartet', model: o.model ?? 'fake' } });
				queue.push({ kind: 'thinking', payload: { text: 'Ich lese den Auftrag.' } });
				await sleep(5, ctrl.signal);
				if (p.includes('[fake:slow]')) {
					const until = Date.now() + 60_000;
					while (!ctrl.signal.aborted && Date.now() < until) await sleep(50, ctrl.signal);
				}
				if (ctrl.signal.aborted) return { ...base, exitCode: 130, error: 'Abgebrochen' };
				if (p.includes('[fake:limit]')) {
					const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
					const raw = '5-hour limit reached · resets in 1 hour';
					queue.push({
						kind: 'limits',
						windows: [{ window: '5h', label: 'five_hour', usedPercent: 100, resetsAt, status: 'rejected' }]
					});
					queue.push({ kind: 'limit', limitKind: '5h', resetsAt, raw });
					return { ...base, exitCode: 1, limit: { limitKind: '5h', resetsAt, raw }, error: raw };
				}
				if (p.includes('[fake:fail]')) {
					queue.push({ kind: 'error', payload: { text: 'Fake-Agent: absichtlicher Fehler' } });
					return { ...base, exitCode: 1, error: 'Fake-Agent: absichtlicher Fehler' };
				}
				if (!o.readOnly && !p.includes('[fake:noop]')) {
					const file = path.join(o.cwd, 'AIDEV_FAKE.md');
					const excerpt = p.replace(/\r\n/g, '\n').slice(0, 500);
					queue.push({ kind: 'tool', payload: { name: 'write_file', input: { path: 'AIDEV_FAKE.md' } } });
					await writeFile(file, `# Fake-Agent\n\n${excerpt}\n`, 'utf8');
					queue.push({ kind: 'tool-result', payload: { name: 'write_file', output: 'ok', isError: false } });
					if (p.includes('[fake:commit]')) {
						await exec('git', ['add', '-A'], { cwd: o.cwd, env: o.env });
						await exec('git', ['commit', '-m', 'Fake-Agent: eigener Commit'], { cwd: o.cwd, env: o.env });
					}
				}
				let text = 'Fertig. Ich habe den Auftrag erledigt.';
				if (p.includes('[fake:plan]'))
					text = `Hier ist der Plan:\n\n\`\`\`json\n${JSON.stringify(FAKE_PLAN, null, 2)}\n\`\`\`\n`;
				queue.push({ kind: 'text', payload: { text } });
				queue.push({
					kind: 'limits',
					windows: [
						{
							window: '5h',
							label: 'five_hour',
							usedPercent: 42,
							resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
							status: 'allowed'
						}
					]
				});
				const usage = {
					model: o.model ?? 'fake',
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 10,
					cacheWriteTokens: 0,
					costUsd: 0
				};
				queue.push({ kind: 'usage', usage });
				return { ...base, usage, lastText: text };
			} catch (e) {
				return { ...base, exitCode: 1, error: (e as Error).message };
			} finally {
				o.signal.removeEventListener('abort', onAbort);
				queue.end();
			}
		})();
		return { events: queue, done, kill: () => ctrl.abort() };
	}
};
