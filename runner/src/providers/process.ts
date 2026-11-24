/** Startet eine Agent-CLI, liest stdout zeilenweise (JSONL) über einen `LineParser` und beendet sie sauber. */
import { AsyncQueue } from '../util/async.ts';
import { LineSplitter, TailBuffer } from '../util/lines.ts';
import { exec, gracefulKill, spawnProcess } from '../util/proc.ts';
import type { AgentProcess, AgentResult, LineParser, NormalizedEvent, ProbeResult } from './types.ts';

export interface CliAgentOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Wird auf stdin geschrieben (danach stdin geschlossen) */
	input: string;
	signal: AbortSignal;
	parser: LineParser;
}

export function runCliAgent(o: CliAgentOptions): AgentProcess {
	const queue = new AsyncQueue<NormalizedEvent>();
	const child = spawnProcess(o.command, o.args, { cwd: o.cwd, env: o.env });
	const out = new LineSplitter();
	const err = new LineSplitter();
	const errTail = new TailBuffer(8000);
	let spawnError: string | null = null;
	let killing: Promise<void> | null = null;

	const emit = (evs: NormalizedEvent[]) => {
		for (const e of evs) queue.push(e);
	};
	const safe = (fn: () => NormalizedEvent[]) => {
		try {
			emit(fn());
		} catch (e) {
			// Parser-Fehler dürfen den Lauf nie abbrechen
			emit([{ kind: 'stderr', payload: { text: `Parser-Fehler: ${(e as Error).message}` } }]);
		}
	};

	child.stdout?.on('data', (b: Buffer) => {
		for (const l of out.push(b)) if (l.trim()) safe(() => o.parser.line(l));
	});
	child.stderr?.on('data', (b: Buffer) => {
		for (const l of err.push(b)) {
			errTail.push(l + '\n');
			if (l.trim()) safe(() => o.parser.stderr(l));
		}
	});
	child.on('error', (e) => {
		spawnError = e.message;
	});
	if (child.stdin) {
		child.stdin.on('error', () => {
			// CLI liest stdin nicht vollständig – unkritisch
		});
		child.stdin.end(o.input);
	}

	const kill = () => {
		if (!killing) killing = gracefulKill(child);
	};
	const onAbort = () => kill();
	o.signal.addEventListener('abort', onAbort, { once: true });
	if (o.signal.aborted) kill();

	const done = new Promise<AgentResult>((resolve) => {
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			o.signal.removeEventListener('abort', onAbort);
			for (const l of out.end()) if (l.trim()) safe(() => o.parser.line(l));
			for (const l of err.end()) {
				errTail.push(l + '\n');
				if (l.trim()) safe(() => o.parser.stderr(l));
			}
			let tail = errTail.toString();
			if (spawnError) tail = `${tail}\nStart fehlgeschlagen: ${spawnError}`.trim();
			let fin: { events: NormalizedEvent[]; result: AgentResult };
			try {
				fin = o.parser.finish(code, tail);
			} catch (e) {
				fin = {
					events: [],
					result: {
						exitCode: code,
						sessionId: null,
						usage: null,
						lastText: '',
						limit: null,
						error: (e as Error).message
					}
				};
			}
			emit(fin.events);
			if (spawnError && !fin.result.error) fin.result.error = `Start fehlgeschlagen: ${spawnError}`;
			if (spawnError && fin.result.exitCode === 0) fin.result.exitCode = null;
			queue.end();
			resolve(fin.result);
		};
		child.on('close', (code) => finish(code));
		child.on('error', () => {
			if (child.pid === undefined) finish(null);
		});
	});

	return { events: queue, done, kill };
}

/** `<cli> --version` ausführen */
export async function probeVersion(
	command: string,
	env: NodeJS.ProcessEnv,
	args: string[] = ['--version']
): Promise<{ ok: boolean; version: string; message?: string }> {
	const r = await exec(command, args, { env, timeoutMs: 20_000 });
	if (r.spawnError || r.code !== 0) {
		return {
			ok: false,
			version: '',
			message: r.spawnError ?? (r.stderr.trim().split('\n').pop() || `Exit-Code ${r.code}`)
		};
	}
	const text = (r.stdout.trim() || r.stderr.trim()).split('\n')[0] ?? '';
	const m = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(text);
	return { ok: true, version: (m?.[0] ?? text).slice(0, 40) };
}

export function probeFailed(message: string): ProbeResult {
	return { ok: false, loggedIn: false, version: '', message };
}
