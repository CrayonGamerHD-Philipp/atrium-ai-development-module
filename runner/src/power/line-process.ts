/**
 * Langlebiger Hilfsprozess mit zeilenweiser Ausgabe (D-Bus-Monitor, PowerShell-Fenster, JXA). Startet nach einem
 * unerwarteten Ende mit Pause neu, bis `stop()` aufgerufen wird.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface LineProcessOptions {
	command: string;
	args: string[];
	onLine(line: string): void;
	onExit?(code: number | null): void;
	/** Pause vor dem Neustart (ms); 0 = nicht neu starten */
	restartMs?: number;
	env?: NodeJS.ProcessEnv;
}

export class LineProcess {
	private child: ChildProcess | null = null;
	private stopped = false;
	private buf = '';
	private restartTimer: NodeJS.Timeout | null = null;
	/** Wurde der Prozess mindestens einmal gestartet (Programm vorhanden)? */
	spawned = false;

	constructor(private readonly o: LineProcessOptions) {}

	start(): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const done = (ok: boolean) => {
				if (!settled) {
					settled = true;
					resolve(ok);
				}
			};
			const child = spawn(this.o.command, this.o.args, {
				stdio: ['pipe', 'pipe', 'ignore'],
				windowsHide: true,
				env: this.o.env ?? process.env
			});
			this.child = child;
			child.once('spawn', () => {
				this.spawned = true;
				done(true);
			});
			child.once('error', () => done(false));
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				this.buf += chunk;
				let i: number;
				while ((i = this.buf.indexOf('\n')) >= 0) {
					const line = this.buf.slice(0, i).replace(/\r$/, '');
					this.buf = this.buf.slice(i + 1);
					if (line.trim()) this.o.onLine(line);
				}
			});
			child.once('exit', (code) => {
				this.child = null;
				this.o.onExit?.(code);
				done(false);
				const wait = this.o.restartMs ?? 10_000;
				if (!this.stopped && this.spawned && wait > 0) {
					this.restartTimer = setTimeout(() => void this.start(), wait);
					this.restartTimer.unref();
				}
			});
		});
	}

	/** Zeile an stdin senden (z. B. `release`) */
	write(line: string): void {
		this.child?.stdin?.write(`${line}\n`);
	}

	get running(): boolean {
		return this.child !== null;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		const child = this.child;
		if (!child) return;
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 2000);
			t.unref();
			child.once('exit', () => {
				clearTimeout(t);
				resolve();
			});
			// erst stdin schließen (Hilfsprozesse beenden sich selbst), dann beenden
			child.stdin?.end();
			const k = setTimeout(() => child.kill(), 500);
			k.unref();
			child.once('exit', () => clearTimeout(k));
		});
	}
}
