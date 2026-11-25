/**
 * Gemini CLI (nach öffentlicher Doku, lokal nicht geprüft): `gemini -p <kurzer Hinweis> --output-format stream-json
 * --yolo [-m model]`. Der eigentliche Auftrag (mit vorangestellter Systemanweisung) kommt über stdin – die CLI
 * hängt stdin an den `-p`-Text an. Fortsetzen wird nicht unterstützt (neue Sitzung).
 *
 * stream-json (JSONL): `init` (session_id, model), `message` (role, content, delta), `tool_use` (tool_name, tool_id,
 * parameters), `tool_result` (tool_id, status, output, error), `error` (severity, message), `result` (status, error,
 * stats). Unbekannte Zeilen werden defensiv als Text weitergegeben.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountConfig } from '../config.ts';
import { withSystemPrompt } from './codex.ts';
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

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export const GEMINI_STDIN_HINT =
	'Follow the instructions provided on standard input below. Work autonomously and finish with a short summary.';

export function createGeminiParser(initialModel = '', now: () => Date = () => new Date()): LineParser {
	let sessionId: string | null = null;
	let model = initialModel;
	let usage: AgentUsage | null = null;
	let limit: AgentLimit | null = null;
	let failed: string | null = null;
	/** Laufender Assistent-Text (Deltas werden zusammengefasst) */
	let pending = '';
	let lastText = '';
	const toolNames = new Map<string, string>();

	const checkText = (text: string): NormalizedEvent[] => {
		if (limit) return [];
		const d = detectLimit('gemini', text, now());
		if (!d) return [];
		limit = { limitKind: d.kind, resetsAt: d.resetsAt, raw: text.slice(0, 2000) };
		return [{ kind: 'limit', ...limit }];
	};
	const flushText = (): NormalizedEvent[] => {
		if (!pending) return [];
		const text = pending;
		pending = '';
		lastText = text;
		return [{ kind: 'text', payload: { text } }];
	};

	return {
		line(line) {
			let o: unknown;
			try {
				o = JSON.parse(line);
			} catch {
				return [...flushText(), { kind: 'text', payload: { text: line } }, ...checkText(line)];
			}
			if (!isObj(o) || typeof o.type !== 'string')
				return [...flushText(), { kind: 'text', payload: { text: line } }];
			switch (o.type) {
				case 'init': {
					const out: NormalizedEvent[] = [];
					if (typeof o.model === 'string') model = o.model;
					if (typeof o.session_id === 'string' && o.session_id) {
						sessionId = o.session_id;
						out.push({ kind: 'session', id: o.session_id });
					}
					out.push({ kind: 'system', payload: { text: `Gemini gestartet${model ? ` (Modell ${model})` : ''}` } });
					return out;
				}
				case 'message': {
					if (o.role !== 'assistant' && o.role !== 'model') return [];
					const content = typeof o.content === 'string' ? o.content : '';
					if (o.delta === true) {
						pending += content;
						return [];
					}
					const out = flushText();
					if (content) {
						lastText = content;
						out.push({ kind: 'text', payload: { text: content } });
					}
					return out;
				}
				case 'tool_use': {
					const name = typeof o.tool_name === 'string' ? o.tool_name : 'tool';
					if (typeof o.tool_id === 'string') toolNames.set(o.tool_id, name);
					return [...flushText(), { kind: 'tool', payload: { name, input: o.parameters ?? {}, id: o.tool_id } }];
				}
				case 'tool_result': {
					const id = typeof o.tool_id === 'string' ? o.tool_id : undefined;
					const err = isObj(o.error) ? String(o.error.message ?? '') : '';
					return [
						...flushText(),
						{
							kind: 'tool-result',
							payload: {
								name: id ? toolNames.get(id) : undefined,
								output: typeof o.output === 'string' ? o.output : err || JSON.stringify(o.output ?? ''),
								isError: o.status === 'error',
								id
							}
						}
					];
				}
				case 'error': {
					const text = typeof o.message === 'string' ? o.message : JSON.stringify(o);
					const severe = o.severity !== 'warning';
					if (severe) failed = text;
					return [...flushText(), { kind: severe ? 'error' : 'status', payload: { text } }, ...checkText(text)];
				}
				case 'result': {
					const out = flushText();
					const stats = isObj(o.stats) ? o.stats : {};
					usage = {
						...emptyUsage(model),
						inputTokens: Math.max(0, num(stats.input_tokens ?? stats.input) - num(stats.cached)),
						outputTokens: num(stats.output_tokens ?? stats.output),
						cacheReadTokens: num(stats.cached)
					};
					out.push({ kind: 'usage', usage });
					if (o.status === 'error') {
						const text = isObj(o.error)
							? String(o.error.message ?? JSON.stringify(o.error))
							: String(o.error ?? 'Gemini meldet einen Fehler');
						failed = text;
						out.push({ kind: 'error', payload: { text } }, ...checkText(text));
					}
					return out;
				}
				default:
					return [...flushText(), { kind: 'text', payload: { text: line } }];
			}
		},
		stderr(line) {
			return [{ kind: 'stderr', payload: { text: line } }, ...checkText(line)];
		},
		finish(exitCode, stderrTail) {
			const events = flushText();
			if (exitCode !== 0) events.push(...checkText(stderrTail));
			return {
				events,
				result: {
					exitCode: failed && exitCode === 0 ? 1 : exitCode,
					sessionId,
					usage,
					lastText,
					limit,
					error:
						exitCode !== 0 || failed
							? (failed ?? (stderrTail.trim().slice(-2000) || `Gemini beendet mit Exit-Code ${exitCode}`))
							: null
				}
			};
		}
	};
}

function geminiDir(env: NodeJS.ProcessEnv): string {
	return path.join(env.GEMINI_CLI_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir(), '.gemini');
}

export const geminiAdapter: ProviderAdapter = {
	id: 'gemini',
	async probe(acct: AccountConfig, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
		const v = await probeVersion(acct.command ?? 'gemini', env);
		if (!v.ok) return probeFailed(v.message ?? 'gemini nicht gefunden');
		const loggedIn =
			Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_APPLICATION_CREDENTIALS) ||
			existsSync(path.join(geminiDir(env), 'oauth_creds.json'));
		return { ok: true, loggedIn, version: v.version };
	},
	start(o: StartOptions): AgentProcess {
		const args = ['-p', GEMINI_STDIN_HINT, '--output-format', 'stream-json', ...(o.question ? ['--allowed-tools', 'read_file', 'list_directory', 'glob', 'search_file_content'] : ['--yolo'])];
		if (o.model) args.push('-m', o.model);
		return runCliAgent({
			command: o.account.command ?? 'gemini',
			args,
			cwd: o.cwd,
			env: o.env,
			input: withSystemPrompt(o.systemPrompt, o.prompt),
			signal: o.signal,
			parser: createGeminiParser(o.model ?? '')
		});
	}
};
