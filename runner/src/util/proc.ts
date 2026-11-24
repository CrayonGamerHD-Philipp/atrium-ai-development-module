/**
 * Prozesse starten und beenden – ohne Shell (Argumente als Array). Unter Windows löst `cross-spawn` `.cmd`-Shims
 * (npm-CLIs wie `claude`, `codex`) über PATHEXT auf und maskiert die Argumente korrekt.
 *
 * Auf POSIX läuft jeder Prozess in einer eigenen Prozessgruppe (`detached`), damit beim Abbruch auch alle
 * Kindprozesse des Agents beendet werden. Unter Windows übernimmt das `taskkill /T /F`.
 */
import { spawn as nodeSpawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { TailBuffer } from './lines.ts';

const isWindows = process.platform === 'win32';

export interface SpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Befehl über die System-Shell ausführen (nur für konfigurierte Projektbefehle wie `setupCmd`) */
	shell?: boolean;
	stdio?: StdioOptions;
}

export function spawnProcess(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
	const options = {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		stdio: opts.stdio ?? (['pipe', 'pipe', 'pipe'] as StdioOptions),
		detached: !isWindows,
		windowsHide: true
	};
	if (opts.shell) return nodeSpawn(cmd, { ...options, shell: true });
	return crossSpawn(cmd, args, options);
}

/** Signal an den Prozess samt Kindern senden */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (isWindows) {
			const k = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true
			});
			k.on('error', () => child.kill());
		} else {
			process.kill(-child.pid, signal);
		}
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Prozess existiert nicht mehr
		}
	}
}

export interface GracefulKillOptions {
	/** Wartezeit nach SIGINT bis SIGTERM */
	intGraceMs?: number;
	/** Wartezeit nach SIGTERM bis SIGKILL */
	termGraceMs?: number;
}

/** SIGINT → (10 s) → SIGTERM → (5 s) → SIGKILL; unter Windows sofort `taskkill /T /F` */
export async function gracefulKill(child: ChildProcess, o: GracefulKillOptions = {}): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((r) => child.once('exit', () => r()));
	const waitFor = (ms: number) =>
		Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
	if (isWindows) {
		killTree(child, 'SIGKILL');
		await waitFor(5000);
		return;
	}
	killTree(child, 'SIGINT');
	if (await waitFor(o.intGraceMs ?? 10_000)) return;
	killTree(child, 'SIGTERM');
	if (await waitFor(o.termGraceMs ?? 5_000)) return;
	killTree(child, 'SIGKILL');
	await waitFor(2000);
}

export interface ExecOptions extends SpawnOptions {
	input?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** stdout auf diese Anzahl Bytes begrenzen (danach wird der Prozess beendet, `truncated: true`) */
	maxStdoutBytes?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	killGrace?: GracefulKillOptions;
}

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	aborted: boolean;
	/** Programm nicht gefunden o. Ä. */
	spawnError: string | null;
}

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawnProcess(cmd, args, opts);
		} catch (e) {
			resolve({
				code: null,
				stdout: '',
				stderr: '',
				truncated: false,
				timedOut: false,
				aborted: false,
				spawnError: e instanceof Error ? e.message : String(e)
			});
			return;
		}
		const out: Buffer[] = [];
		let outBytes = 0;
		let truncated = false;
		let timedOut = false;
		let aborted = false;
		let spawnError: string | null = null;
		const err = new TailBuffer(256_000);
		const outDecoder = new TextDecoder();
		const errDecoder = new TextDecoder();

		child.stdout?.on('data', (b: Buffer) => {
			if (opts.onStdout) opts.onStdout(outDecoder.decode(b, { stream: true }));
			if (truncated) return;
			const max = opts.maxStdoutBytes;
			if (max !== undefined && outBytes + b.length > max) {
				out.push(b.subarray(0, Math.max(0, max - outBytes)));
				outBytes = max;
				truncated = true;
				killTree(child, 'SIGKILL');
				return;
			}
			out.push(b);
			outBytes += b.length;
		});
		child.stderr?.on('data', (b: Buffer) => {
			const s = errDecoder.decode(b, { stream: true });
			err.push(s);
			opts.onStderr?.(s);
		});
		child.on('error', (e) => {
			spawnError = e.message;
			if (child.pid === undefined) finish(null);
		});

		const onAbort = () => {
			aborted = true;
			void gracefulKill(child, opts.killGrace ?? { intGraceMs: 3000, termGraceMs: 2000 });
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		if (opts.signal?.aborted) onAbort();
		const timer =
			opts.timeoutMs !== undefined
				? setTimeout(() => {
						timedOut = true;
						void gracefulKill(child, opts.killGrace ?? { intGraceMs: 2000, termGraceMs: 2000 });
					}, opts.timeoutMs)
				: undefined;

		if (child.stdin) {
			child.stdin.on('error', () => {
				// Prozess hat stdin geschlossen – unkritisch
			});
			if (opts.input !== undefined) child.stdin.end(opts.input);
			else child.stdin.end();
		}

		let finished = false;
		function finish(code: number | null) {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			resolve({
				code,
				stdout: Buffer.concat(out).toString('utf8'),
				stderr: err.toString(),
				truncated,
				timedOut,
				aborted,
				spawnError
			});
		}
		child.on('close', (code) => finish(code));
	});
}
