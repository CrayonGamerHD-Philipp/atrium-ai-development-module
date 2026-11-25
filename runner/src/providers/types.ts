/** Gemeinsame Schnittstelle der Provider-Adapter (Claude Code, Codex, Gemini, OpenAI-kompatibel, Fake). */
import type { AccountConfig } from '../config.ts';
import type { RunEventKind } from '../protocol.ts';
import type { LimitKind } from './limits.ts';

export interface AgentUsage {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number | null;
}

export interface AgentLimit {
	limitKind: LimitKind;
	resetsAt: string | null;
	raw: string;
}

export type NormalizedEvent =
	| { kind: RunEventKind; payload: Record<string, unknown> }
	| { kind: 'usage'; usage: AgentUsage }
	| { kind: 'session'; id: string }
	| ({ kind: 'limit' } & AgentLimit);

export interface AgentResult {
	exitCode: number | null;
	sessionId: string | null;
	usage: AgentUsage | null;
	/** Letzte Antwort des Agents (Zusammenfassung) */
	lastText: string;
	limit: AgentLimit | null;
	/** Kurze Fehlerbeschreibung (z. B. Ende von stderr), falls der Agent fehlschlug */
	error: string | null;
}

export interface AgentProcess {
	events: AsyncIterable<NormalizedEvent>;
	done: Promise<AgentResult>;
	kill(): void;
}

export interface StartOptions {
	cwd: string;
	prompt: string;
	systemPrompt: string;
	model: string | null;
	resumeSessionId: string | null;
	env: NodeJS.ProcessEnv;
	readOnly: boolean;
	question?: boolean;
	signal: AbortSignal;
	account: AccountConfig;
	/** Verzeichnis für temporäre Dateien dieses Laufs (außerhalb des Worktrees) */
	tmpDir: string;
}

export interface ProbeResult {
	ok: boolean;
	loggedIn: boolean;
	version: string;
	message?: string;
}

export interface ProviderAdapter {
	id: string;
	probe(acct: AccountConfig, env: NodeJS.ProcessEnv): Promise<ProbeResult>;
	start(opts: StartOptions): AgentProcess;
}

export function emptyUsage(model = ''): AgentUsage {
	return {
		model,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: null
	};
}

/** Zahl aus unbekanntem Wert (≥ 0, ganzzahlig) */
export function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** Zustandsbehafteter Parser für die Zeilenausgabe einer CLI */
export interface LineParser {
	/** Eine stdout-Zeile verarbeiten */
	line(line: string): NormalizedEvent[];
	/** Eine stderr-Zeile verarbeiten (Limit-Erkennung, Rohtext) */
	stderr(line: string): NormalizedEvent[];
	/** Ende des Prozesses: restliche Ereignisse und Ergebnis */
	finish(exitCode: number | null, stderrTail: string): { events: NormalizedEvent[]; result: AgentResult };
}
