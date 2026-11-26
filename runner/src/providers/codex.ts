/**
 * Codex CLI (`codex-cli` 0.164): `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
 * -C <cwd> [-m model] [-c model_reasoning_effort=…] -` (Auftrag über stdin). Fortsetzen:
 * `codex exec resume <thread_id> … -` (ohne `-C`, Arbeitsverzeichnis über cwd des Prozesses).
 *
 * Die Systemanweisung wird dem Auftrag vorangestellt (stdin), weil `-c developer_instructions=…` mehrzeilige
 * Texte über die Kommandozeile bräuchte (unter Windows über `cmd.exe`-Shims nicht zuverlässig).
 *
 * JSONL: `thread.started` (thread_id), `item.started`/`item.completed` (agent_message, reasoning,
 * command_execution, file_change, mcp_tool_call, web_search, todo_list, error), `turn.completed` (usage),
 * `turn.failed`, `error`.
 */
import { existsSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountConfig } from '../config.ts';
import type { Provider } from '../protocol.ts';
import { exec } from '../util/proc.ts';
import { codexRateLimitWindows, findCodexRateLimits, toIso } from './limit-snapshot.ts';
import { detectLimit } from './limits.ts';
import { probeFailed, probeVersion, runCliAgent } from './process.ts';
import {
	emptyUsage,
	num,
	type AgentLimit,
	type AgentProcess,
	type AgentUsage,
	type LineParser,
	type NormalizedEvent,
	type ProbeResult,
	type ProviderAdapter,
	type StartOptions
} from './types.ts';
import { AsyncQueue } from '../util/async.ts';
import type { LimitWindow } from '../protocol.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function errorText(o: Json): string {
	if (typeof o.message === 'string') return o.message;
	if (isObj(o.error) && typeof o.error.message === 'string') return o.error.message;
	if (typeof o.error === 'string') return o.error;
	return JSON.stringify(o).slice(0, 2000);
}

export function createCodexParser(
	provider: Provider = 'codex',
	initialModel = '',
	now: () => Date = () => new Date()
): LineParser {
	let sessionId: string | null = null;
	let lastText = '';
	const usage: AgentUsage = emptyUsage(initialModel);
	let hasUsage = false;
	let limit: AgentLimit | null = null;
	let failed: string | null = null;

	const checkText = (text: string): NormalizedEvent[] => {
		if (limit) return [];
		const d = detectLimit(provider, text, now());
		if (!d) return [];
		limit = { limitKind: d.kind, resetsAt: d.resetsAt, raw: text.slice(0, 2000) };
		return [{ kind: 'limit', ...limit }];
	};

	const item = (phase: 'started' | 'updated' | 'completed', it: Json): NormalizedEvent[] => {
		const t = it.type;
		if (t === 'agent_message' && phase === 'completed') {
			const text = typeof it.text === 'string' ? it.text : '';
			if (!text) return [];
			lastText = text;
			return [{ kind: 'text', payload: { text } }];
		}
		if (t === 'reasoning' && phase === 'completed') {
			const text = typeof it.text === 'string' ? it.text : '';
			return text ? [{ kind: 'thinking', payload: { text } }] : [];
		}
		if (t === 'command_execution') {
			if (phase === 'started')
				return [{ kind: 'tool', payload: { name: 'shell', input: { command: it.command }, id: it.id } }];
			if (phase === 'completed') {
				const code = typeof it.exit_code === 'number' ? it.exit_code : null;
				return [
					{
						kind: 'tool-result',
						payload: {
							name: 'shell',
							output: typeof it.aggregated_output === 'string' ? it.aggregated_output : '',
							isError: (code !== null && code !== 0) || it.status === 'failed',
							exitCode: code,
							id: it.id
						}
					}
				];
			}
			return [];
		}
		if (t === 'file_change' && phase === 'completed') {
			const changes = Array.isArray(it.changes) ? it.changes : [];
			return [
				{
					kind: 'tool',
					payload: {
						name: 'file_change',
						input: { changes: changes.map((c) => (isObj(c) ? { path: c.path, kind: c.kind } : c)) },
						id: it.id
					}
				}
			];
		}
		if (t === 'mcp_tool_call') {
			const name = `${String(it.server ?? 'mcp')}.${String(it.tool ?? 'tool')}`;
			if (phase === 'started')
				return [{ kind: 'tool', payload: { name, input: it.arguments ?? {}, id: it.id } }];
			if (phase === 'completed')
				return [
					{
						kind: 'tool-result',
						payload: {
							name,
							output: it.result !== undefined ? JSON.stringify(it.result) : String(it.error ?? ''),
							isError: it.status === 'failed' || it.error != null,
							id: it.id
						}
					}
				];
			return [];
		}
		if (t === 'web_search' && phase === 'started') {
			return [{ kind: 'tool', payload: { name: 'web_search', input: { query: it.query }, id: it.id } }];
		}
		if (t === 'todo_list' && phase !== 'started') {
			const items = Array.isArray(it.items) ? it.items : [];
			const text = items
				.map((x) => (isObj(x) ? `${x.completed ? '[x]' : '[ ]'} ${String(x.text ?? '')}` : ''))
				.join('\n');
			return text ? [{ kind: 'status', payload: { text } }] : [];
		}
		if (t === 'error' && phase === 'completed') {
			const text = typeof it.message === 'string' ? it.message : JSON.stringify(it);
			return [{ kind: 'error', payload: { text } }, ...checkText(text)];
		}
		return [];
	};

	const base: LineParser = {
		line(line) {
			let o: unknown;
			try {
				o = JSON.parse(line);
			} catch {
				return [{ kind: 'text', payload: { text: line } }, ...checkText(line)];
			}
			if (!isObj(o)) return [{ kind: 'text', payload: { text: line } }];
			switch (o.type) {
				case 'thread.started':
					if (typeof o.thread_id === 'string') {
						sessionId = o.thread_id;
						return [
							{ kind: 'session', id: o.thread_id },
							{ kind: 'system', payload: { text: 'Codex gestartet', threadId: o.thread_id } }
						];
					}
					return [];
				case 'turn.started':
					return [];
				case 'item.started':
				case 'item.updated':
				case 'item.completed':
					return isObj(o.item)
						? item(o.type.slice(5) as 'started' | 'updated' | 'completed', o.item)
						: [];
				case 'turn.completed': {
					if (!isObj(o.usage)) return [];
					const u = o.usage;
					const cached = num(u.cached_input_tokens);
					usage.inputTokens += Math.max(0, num(u.input_tokens) - cached);
					usage.cacheReadTokens += cached;
					usage.cacheWriteTokens += num(u.cache_write_input_tokens);
					usage.outputTokens += num(u.output_tokens);
					hasUsage = true;
					return [{ kind: 'usage', usage: { ...usage } }];
				}
				case 'turn.failed':
				case 'error': {
					const text = errorText(o.type === 'turn.failed' && isObj(o.error) ? o.error : o);
					failed = text;
					return [{ kind: 'error', payload: { text } }, ...checkText(text)];
				}
				default:
					return [];
			}
		},
		stderr(line) {
			return [{ kind: 'stderr', payload: { text: line } }, ...checkText(line)];
		},
		finish(exitCode, stderrTail) {
			const events: NormalizedEvent[] = [];
			if (exitCode !== 0) events.push(...checkText(stderrTail));
			return {
				events,
				result: {
					exitCode: failed && exitCode === 0 ? 1 : exitCode,
					sessionId,
					usage: hasUsage ? usage : null,
					lastText,
					limit,
					error:
						exitCode !== 0 || failed
							? (failed ?? (stderrTail.trim().slice(-2000) || `Codex beendet mit Exit-Code ${exitCode}`))
							: null
				}
			};
		}
	};

	return {
		...base,
		line(line) {
			// Limit-Stand (`rate_limits.primary/secondary`), falls die Version ihn im Stream mitsendet;
			// nur beim ChatGPT-Login (Abo-Fenster), nicht bei OpenAI-kompatiblen APIs
			const limits = provider === 'codex' ? limitsOfLine(line, now()) : [];
			return [...limits, ...base.line(line)];
		}
	};
}

/** `limits`-Ereignis aus einer Codex-JSON-Zeile mit `rate_limits` (sonst leer, wirft nie) */
export function limitsOfLine(line: string, now: Date): NormalizedEvent[] {
	if (!line.includes('rate_limits') && !line.includes('rateLimits')) return [];
	try {
		const o: unknown = JSON.parse(line);
		const rl = findCodexRateLimits(o);
		// `resets_in_seconds` bezieht sich auf den Zeitpunkt der Zeile (Sitzungsdatei: `timestamp`)
		const ts = isObj(o) ? toIso(o.timestamp) : null;
		const base = ts && Date.parse(ts) <= now.getTime() ? new Date(ts) : now;
		const windows = rl !== undefined ? codexRateLimitWindows(rl, base) : null;
		return windows ? [{ kind: 'limits', windows }] : [];
	} catch {
		return [];
	}
}

/** Auftrag mit vorangestellter Systemanweisung */
export function withSystemPrompt(systemPrompt: string, prompt: string): string {
	if (!systemPrompt.trim()) return prompt;
	return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${prompt}`;
}

/** TOML-Zeichenkette für `-c key=value` */
export function tomlString(s: string): string {
	return JSON.stringify(s);
}

export interface CodexStartExtras {
	provider: Provider;
	/** Zusätzliche `-c`-Überschreibungen (z. B. model_provider) */
	configArgs: string[];
	model: string | null;
}

export function codexArgs(o: StartOptions, extra: CodexStartExtras): string[] {
	const common = ['--json', ...(o.question ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox']), '--skip-git-repo-check'];
	if (extra.model) common.push('-m', extra.model);
	if (o.account.reasoningEffort) common.push('-c', `model_reasoning_effort=${tomlString(o.account.reasoningEffort)}`);
	for (const c of extra.configArgs) common.push('-c', c);
	if (o.resumeSessionId) return ['exec', 'resume', ...common, o.resumeSessionId, '-'];
	return ['exec', ...common, '-C', o.cwd, '-'];
}

export function startCodex(o: StartOptions, extra: CodexStartExtras): AgentProcess {
	const proc = runCliAgent({
		command: o.account.command ?? 'codex',
		args: codexArgs(o, extra),
		cwd: o.cwd,
		env: o.env,
		// Beim Fortsetzen kennt die Sitzung die Systemanweisung bereits
		input: o.resumeSessionId ? o.prompt : withSystemPrompt(o.systemPrompt, o.prompt),
		signal: o.signal,
		parser: createCodexParser(extra.provider, extra.model ?? '')
	});
	// Abo-Fenster gibt es nur beim ChatGPT-Login (nicht bei OpenAI-kompatiblen APIs)
	return extra.provider === 'codex' ? withSessionLimits(proc, codexHome(o.env)) : proc;
}

/**
 * Liefert nach dem Lauf den Limit-Stand aus der Sitzungsdatei nach (`<CODEX_HOME>/sessions/JJJJ/MM/TT/
 * rollout-…-<thread_id>.jsonl`, letztes `token_count` mit `rate_limits`), falls der Stream keinen enthielt.
 */
export function withSessionLimits(
	proc: AgentProcess,
	home: string,
	now: () => Date = () => new Date()
): AgentProcess {
	const queue = new AsyncQueue<NormalizedEvent>();
	let threadId: string | null = null;
	let streamed = false;
	const done = (async () => {
		try {
			for await (const ev of proc.events) {
				if (ev.kind === 'session') threadId = ev.id;
				else if (ev.kind === 'limits') streamed = true;
				queue.push(ev);
			}
			if (threadId && !streamed) {
				const windows = await readCodexSessionLimits(home, threadId, now());
				if (windows) queue.push({ kind: 'limits', windows });
			}
		} catch {
			// Sitzungsdatei ist optional
		} finally {
			queue.end();
		}
		return proc.done;
	})();
	return { events: queue, done, kill: () => proc.kill() };
}

const SESSION_TAIL_BYTES = 512 * 1024;

/** Limit-Stand aus der Sitzungsdatei eines Threads (heute/gestern, lokale und UTC-Ordner); `null`, wenn unbekannt */
export async function readCodexSessionLimits(home: string, threadId: string, now: Date): Promise<LimitWindow[] | null> {
	if (!/^[A-Za-z0-9-]{8,80}$/.test(threadId)) return null;
	const dirs = new Set<string>();
	for (const offset of [0, -86_400_000]) {
		const d = new Date(now.getTime() + offset);
		const pad = (n: number) => String(n).padStart(2, '0');
		dirs.add(path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
		dirs.add(path.join(home, 'sessions', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
	}
	for (const dir of dirs) {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		const name = names.find((n) => n.endsWith(`${threadId}.jsonl`));
		if (!name) continue;
		const fh = await open(path.join(dir, name), 'r');
		try {
			const { size } = await fh.stat();
			const len = Math.min(size, SESSION_TAIL_BYTES);
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, size - len);
			const lines = buf.toString('utf8').split(/\r?\n/);
			for (let i = lines.length - 1; i >= 0; i--) {
				const ev = limitsOfLine(lines[i] ?? '', now)[0];
				if (ev?.kind === 'limits') return ev.windows;
			}
		} finally {
			await fh.close();
		}
		return null;
	}
	return null;
}

function codexHome(env: NodeJS.ProcessEnv): string {
	return env.CODEX_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.codex');
}

export const codexAdapter: ProviderAdapter = {
	id: 'codex',
	resumable: true,
	async probe(acct: AccountConfig, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
		const cmd = acct.command ?? 'codex';
		const v = await probeVersion(cmd, env);
		if (!v.ok) return probeFailed(v.message ?? 'codex nicht gefunden');
		const r = await exec(cmd, ['login', 'status'], { env, timeoutMs: 20_000 });
		if (r.code === 0 && /logged in/i.test(r.stdout + r.stderr) && !/not logged in/i.test(r.stdout + r.stderr))
			return { ok: true, loggedIn: true, version: v.version };
		if (r.code !== null && r.code !== 0 && !r.spawnError) return { ok: true, loggedIn: false, version: v.version };
		// Rückfall: auth.json vorhanden
		return { ok: true, loggedIn: existsSync(path.join(codexHome(env), 'auth.json')), version: v.version };
	},
	start(o: StartOptions): AgentProcess {
		return startCodex(o, { provider: 'codex', configArgs: [], model: o.model });
	}
};
