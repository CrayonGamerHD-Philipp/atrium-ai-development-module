/**
 * Claude Code (`claude` 2.1.x): `claude -p --output-format stream-json --verbose --dangerously-skip-permissions
 * --append-system-prompt-file <datei> [--model m] [--resume id]`, Auftrag über stdin.
 *
 * stream-json: `system/init` (session_id, model), `assistant` (message.content: text/thinking/tool_use),
 * `user` (tool_result), `rate_limit_event` (status, resetsAt, rateLimitType), `result` (result, usage,
 * total_cost_usd, is_error, subtype).
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountConfig } from '../config.ts';
import { exec } from '../util/proc.ts';
import { claudeRateLimitWindows } from './limit-snapshot.ts';
import { claudeWindowKind, detectLimit } from './limits.ts';
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

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringify(v: unknown): string {
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) {
		// tool_result.content: [{ type: 'text', text }, { type: 'image', … }]
		return v
			.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : isObj(p) ? `[${String(p.type ?? 'inhalt')}]` : String(p)))
			.join('\n');
	}
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export function createClaudeParser(now: () => Date = () => new Date()): LineParser {
	let sessionId: string | null = null;
	let model = '';
	let lastText = '';
	let usage: AgentUsage | null = null;
	let limit: AgentLimit | null = null;
	let resultError: string | null = null;
	let isError = false;
	const toolNames = new Map<string, string>();

	const setLimit = (l: AgentLimit): NormalizedEvent[] => {
		if (limit) return [];
		limit = l;
		return [{ kind: 'limit', ...l }];
	};
	const checkText = (text: string): NormalizedEvent[] => {
		const d = detectLimit('claude', text, now());
		return d ? setLimit({ limitKind: d.kind, resetsAt: d.resetsAt, raw: text.slice(0, 2000) }) : [];
	};

	return {
		line(line) {
			let o: unknown;
			try {
				o = JSON.parse(line);
			} catch {
				return [{ kind: 'text', payload: { text: line } }, ...checkText(line)];
			}
			if (!isObj(o)) return [{ kind: 'text', payload: { text: line } }];
			const out: NormalizedEvent[] = [];
			const type = o.type;
			if (typeof o.session_id === 'string' && o.session_id && o.session_id !== sessionId) {
				sessionId = o.session_id;
				out.push({ kind: 'session', id: sessionId });
			}
			if (type === 'system') {
				if (o.subtype === 'init') {
					if (typeof o.model === 'string') model = o.model;
					out.push({
						kind: 'system',
						payload: {
							text: `Claude Code gestartet${model ? ` (Modell ${model})` : ''}`,
							model,
							version: typeof o.claude_code_version === 'string' ? o.claude_code_version : undefined
						}
					});
				} else if (typeof o.subtype === 'string') {
					out.push({ kind: 'status', payload: { text: `Claude: ${o.subtype}` } });
				}
				return out;
			}
			if (type === 'assistant' && isObj(o.message)) {
				const msg = o.message;
				if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') model = msg.model;
				const content = Array.isArray(msg.content) ? msg.content : [];
				const texts: string[] = [];
				for (const c of content) {
					if (!isObj(c)) continue;
					if (c.type === 'text' && typeof c.text === 'string') {
						texts.push(c.text);
						out.push({ kind: 'text', payload: { text: c.text } });
					} else if (c.type === 'thinking' && typeof c.thinking === 'string') {
						if (c.thinking) out.push({ kind: 'thinking', payload: { text: c.thinking } });
					} else if (c.type === 'tool_use') {
						const name = typeof c.name === 'string' ? c.name : 'tool';
						if (typeof c.id === 'string') toolNames.set(c.id, name);
						out.push({ kind: 'tool', payload: { name, input: c.input ?? {}, id: c.id } });
					}
				}
				if (texts.length) lastText = texts.join('\n');
				// Synthetische Fehlermeldungen (z. B. Limit) erkennt man an `error` bzw. Modell `<synthetic>`
				if ((o.error !== undefined && o.error !== null) || msg.model === '<synthetic>') {
					out.push(...checkText(texts.join('\n') + ' ' + stringify(o.error ?? '')));
				}
				return out;
			}
			if (type === 'user' && isObj(o.message)) {
				const content = Array.isArray(o.message.content) ? o.message.content : [];
				for (const c of content) {
					if (!isObj(c) || c.type !== 'tool_result') continue;
					const id = typeof c.tool_use_id === 'string' ? c.tool_use_id : undefined;
					out.push({
						kind: 'tool-result',
						payload: {
							name: id ? toolNames.get(id) : undefined,
							output: stringify(c.content ?? ''),
							isError: c.is_error === true,
							id
						}
					});
				}
				return out;
			}
			if (type === 'rate_limit_event' && isObj(o.rate_limit_info)) {
				const info = o.rate_limit_info;
				// Limit-Stand bei jedem Ereignis melden (auch `allowed`); Treffer und Warnungen bleiben unverändert
				const windows = claudeRateLimitWindows(info);
				if (windows) out.push({ kind: 'limits', windows });
				const status = typeof info.status === 'string' ? info.status : '';
				const resetsAt =
					typeof info.resetsAt === 'number' && info.resetsAt > 0
						? new Date(info.resetsAt * (info.resetsAt > 1e12 ? 1 : 1000)).toISOString()
						: null;
				if (status === 'rejected' || status === 'blocked') {
					out.push(
						...setLimit({
							limitKind: claudeWindowKind(info.rateLimitType),
							resetsAt,
							raw: JSON.stringify(info).slice(0, 2000)
						})
					);
				} else if (status && status !== 'allowed') {
					out.push({
						kind: 'status',
						payload: {
							text: `Limit-Warnung (${String(info.rateLimitType ?? 'unbekannt')})${resetsAt ? `, zurückgesetzt ${resetsAt}` : ''}`
						}
					});
				}
				return out;
			}
			if (type === 'result') {
				if (isObj(o.usage)) {
					const u = o.usage;
					usage = {
						...emptyUsage(model),
						inputTokens: num(u.input_tokens),
						outputTokens: num(u.output_tokens),
						cacheReadTokens: num(u.cache_read_input_tokens),
						cacheWriteTokens: num(u.cache_creation_input_tokens),
						costUsd:
							typeof o.total_cost_usd === 'number' && o.total_cost_usd >= 0 ? o.total_cost_usd : null
					};
					out.push({ kind: 'usage', usage });
				}
				const resultText = typeof o.result === 'string' ? o.result : '';
				if (resultText) lastText = resultText;
				isError = o.is_error === true || (typeof o.subtype === 'string' && o.subtype.startsWith('error'));
				if (isError) {
					resultError = (resultText || String(o.subtype ?? 'Fehler')).slice(0, 2000);
					out.push(...checkText(`${resultText} ${o.api_error_status ?? ''}`));
					if (!limit && (o.api_error_status === 429 || o.api_error_status === '429'))
						out.push(...setLimit({ limitKind: 'rate', resetsAt: null, raw: resultError }));
					out.push({ kind: 'error', payload: { text: resultError } });
				}
				return out;
			}
			// Unbekannte JSON-Zeilen (stream_event, …) werden ignoriert
			return out;
		},
		stderr(line) {
			return [{ kind: 'stderr', payload: { text: line } }, ...checkText(line)];
		},
		finish(exitCode, stderrTail) {
			const events: NormalizedEvent[] = [];
			if (exitCode !== 0 && !limit) events.push(...checkText(stderrTail));
			let error: string | null = null;
			if (exitCode !== 0 || isError)
				error = resultError ?? (stderrTail.trim().slice(-2000) || `Claude beendet mit Exit-Code ${exitCode}`);
			return {
				events,
				result: {
					exitCode: isError && exitCode === 0 ? 1 : exitCode,
					sessionId,
					usage,
					lastText,
					limit,
					error
				}
			};
		}
	};
}

function credentialDir(env: NodeJS.ProcessEnv): string {
	if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
	return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.claude');
}

export const claudeAdapter: ProviderAdapter = {
	id: 'claude',
	async probe(acct: AccountConfig, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
		const cmd = acct.command ?? 'claude';
		const v = await probeVersion(cmd, env);
		if (!v.ok) return probeFailed(v.message ?? 'claude nicht gefunden');
		if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, loggedIn: true, version: v.version };
		const r = await exec(cmd, ['auth', 'status', '--json'], { env, timeoutMs: 20_000 });
		if (r.code === 0 || r.code === 1) {
			try {
				const j = JSON.parse(r.stdout) as { loggedIn?: unknown };
				if (typeof j.loggedIn === 'boolean') return { ok: true, loggedIn: j.loggedIn, version: v.version };
			} catch {
				// ältere Version ohne JSON-Ausgabe
			}
		}
		// Rückfall: Anmeldedaten im Config-Verzeichnis vorhanden?
		const dir = credentialDir(env);
		const loggedIn = existsSync(path.join(dir, '.credentials.json')) || existsSync(path.join(dir, '.claude.json'));
		return { ok: true, loggedIn, version: v.version };
	},
	start(o: StartOptions): AgentProcess {
		const sysFile = path.join(o.tmpDir, 'claude-system-prompt.md');
		const args = [
			'-p',
			'--output-format',
			'stream-json',
			'--verbose',
			...(o.question ? ['--tools', 'Read,Glob,Grep'] : ['--dangerously-skip-permissions'])
		];
		if (o.systemPrompt) args.push('--append-system-prompt-file', sysFile);
		if (o.model) args.push('--model', o.model);
		if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
		return deferredStart(async () => {
			if (o.systemPrompt) {
				await mkdir(o.tmpDir, { recursive: true });
				await writeFile(sysFile, o.systemPrompt, 'utf8');
			}
			return runCliAgent({
				command: o.account.command ?? 'claude',
				args,
				cwd: o.cwd,
				env: o.env,
				input: o.prompt,
				signal: o.signal,
				parser: createClaudeParser()
			});
		});
	}
};

/** Startet einen Prozess nach einer asynchronen Vorbereitung (z. B. Datei schreiben) */
export function deferredStart(prepare: () => Promise<AgentProcess>): AgentProcess {
	const queue = new AsyncQueue<NormalizedEvent>();
	let proc: AgentProcess | null = null;
	let killed = false;
	const done = (async () => {
		try {
			proc = await prepare();
		} catch (e) {
			queue.end();
			return {
				exitCode: null,
				sessionId: null,
				usage: null,
				lastText: '',
				limit: null,
				error: `Start fehlgeschlagen: ${(e as Error).message}`
			};
		}
		if (killed) proc.kill();
		for await (const ev of proc.events) queue.push(ev);
		queue.end();
		return proc.done;
	})();
	return {
		events: queue,
		done,
		kill() {
			killed = true;
			proc?.kill();
		}
	};
}
