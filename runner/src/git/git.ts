/** Aufruf von `git` mit festen Grundeinstellungen (keine Passwortabfragen, kein Pager, Autor aus der Konfiguration). */
import { exec, type ExecResult } from '../util/proc.ts';

export class GitError extends Error {
	constructor(
		message: string,
		readonly result: ExecResult | null = null
	) {
		super(message);
		this.name = 'GitError';
	}
}

export interface GitOptions {
	cwd?: string;
	input?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxStdoutBytes?: number;
	/** Fehler nicht werfen, sondern Ergebnis zurückgeben */
	allowFail?: boolean;
	/** Zusätzliche `-c`-Einstellungen vor dem Unterbefehl */
	config?: string[];
}

export interface GitRunner {
	(args: string[], o?: GitOptions): Promise<ExecResult>;
}

/** Gültiger Branch-/Ref-Name ohne Optionsinjektion */
export function assertRefName(name: string, what = 'Branch'): string {
	if (
		!name ||
		name.length > 200 ||
		name.startsWith('-') ||
		name.startsWith('/') ||
		name.endsWith('/') ||
		name.endsWith('.lock') ||
		name.endsWith('.') ||
		name.includes('..') ||
		name.includes('@{') ||
		name.includes('//') ||
		!/^[A-Za-z0-9._\/+-]+$/.test(name)
	) {
		throw new GitError(`${what} „${name}“ ist ungültig`);
	}
	return name;
}

/** Kurzfassung eines fehlgeschlagenen Aufrufs */
export function describeFailure(args: string[], r: ExecResult): string {
	const out = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-6).join('\n');
	const reason = r.spawnError
		? `konnte nicht gestartet werden (${r.spawnError})`
		: r.timedOut
			? 'Zeitlimit überschritten'
			: `Exit-Code ${r.code}`;
	return `git ${args.filter((a) => !a.startsWith('credential.')).slice(0, 4).join(' ')}: ${reason}${out ? `\n${out}` : ''}`;
}

export function createGitRunner(baseEnv: NodeJS.ProcessEnv): GitRunner {
	return async (args, o = {}) => {
		const cfg: string[] = [];
		for (const c of o.config ?? []) cfg.push('-c', c);
		const full = ['--no-pager', ...cfg, ...args];
		const r = await exec('git', full, {
			cwd: o.cwd,
			input: o.input,
			env: { ...baseEnv, ...o.env },
			timeoutMs: o.timeoutMs ?? 300_000,
			signal: o.signal,
			maxStdoutBytes: o.maxStdoutBytes
		});
		if (!o.allowFail && (r.code !== 0 || r.spawnError) && !r.truncated) {
			throw new GitError(describeFailure(args, r), r);
		}
		return r;
	};
}

/** Umgebung für git: keine interaktiven Abfragen, fester Autor */
export function gitEnv(
	base: NodeJS.ProcessEnv,
	author: { name: string; email: string }
): NodeJS.ProcessEnv {
	return {
		...base,
		GIT_TERMINAL_PROMPT: '0',
		GCM_INTERACTIVE: 'never',
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_COMMITTER_NAME: author.name,
		GIT_COMMITTER_EMAIL: author.email,
		LC_ALL: 'C',
		LANG: 'C'
	};
}
