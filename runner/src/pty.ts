/**
 * Terminals für die Browser-Oberfläche über `node-pty` (optionale Abhängigkeit, dynamisch geladen). Ohne node-pty
 * meldet der Runner `capabilities.pty = false` und beantwortet `pty-open` mit einer Fehlermeldung und `exit`.
 * Ausgabe wird ~16 ms gebündelt und als UTF-8-Text (TextDecoder im Stream-Modus) gesendet.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { RunnerApi } from './client.ts';
import { publicEnv } from './config.ts';
import type { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import type { RunnerCommand } from './protocol.ts';
import type { Redactor } from './redact.ts';
import { errorMessage } from './util/async.ts';

interface IPty {
	onData(cb: (d: string | Buffer) => void): { dispose(): void };
	onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
	write(d: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}
interface NodePtyModule {
	spawn(file: string, args: string[], opts: Record<string, unknown>): IPty;
}

let ptyModule: NodePtyModule | null | undefined;

/**
 * node-pty laden (einmalig); `null` wenn nicht installiert bzw. nicht ladbar. Im Einzel-Binary (Node SEA) kann
 * `import()` keine Pakete laden – dort liegt node-pty neben dem Programm (`node_modules/node-pty`) und wird über
 * `createRequire` relativ zum Programm geladen.
 */
export async function loadNodePty(): Promise<NodePtyModule | null> {
	if (ptyModule !== undefined) return ptyModule;
	const pick = (mod: ({ default?: NodePtyModule } & NodePtyModule) | null) =>
		mod && typeof mod.spawn === 'function' ? mod : (mod?.default ?? null);
	try {
		const name = 'node-pty';
		ptyModule = pick((await import(name)) as { default?: NodePtyModule } & NodePtyModule);
	} catch {
		ptyModule = null;
	}
	if (!ptyModule) {
		try {
			const req = createRequire(path.join(path.dirname(process.execPath), 'package.json'));
			ptyModule = pick(req('node-pty') as { default?: NodePtyModule } & NodePtyModule);
		} catch {
			ptyModule = null;
		}
	}
	return ptyModule;
}

const FLUSH_MS = 16;
const MAX_CHUNK = 100_000;
const MAX_SESSIONS = 16;

interface Session {
	sid: string;
	pty: IPty;
	seq: number;
	buf: string;
	timer: NodeJS.Timeout | null;
	/** Sende-Kette (Reihenfolge der Ausgaben bleibt erhalten) */
	chain: Promise<void>;
	decoder: InstanceType<typeof TextDecoder>;
	closed: boolean;
}

export interface PtyOptions {
	api: RunnerApi;
	workspace: Workspace;
	redactor: Redactor;
	log?: Logger;
	/** Shell (Standard: $SHELL bzw. /bin/bash, unter Windows powershell.exe) */
	shell?: string;
}

export class PtyManager {
	private sessions = new Map<string, Session>();
	private readonly log: Logger;

	constructor(private readonly o: PtyOptions) {
		this.log = o.log ?? silentLogger;
	}

	async available(): Promise<boolean> {
		return (await loadNodePty()) !== null;
	}

	handle(cmd: RunnerCommand): void {
		switch (cmd.type) {
			case 'pty-open':
				void this.open(cmd).catch((e: unknown) => this.log.warn('Terminal konnte nicht geöffnet werden', errorMessage(e)));
				break;
			case 'pty-input': {
				const s = this.sessions.get(cmd.sid);
				if (s && !s.closed) s.pty.write(cmd.data);
				break;
			}
			case 'pty-resize': {
				const s = this.sessions.get(cmd.sid);
				if (s && !s.closed) {
					try {
						s.pty.resize(cmd.cols, cmd.rows);
					} catch {
						// Prozess bereits beendet
					}
				}
				break;
			}
			case 'pty-close':
				this.close(cmd.sid);
				break;
			default:
				break;
		}
	}

	private async fail(sid: string, message: string): Promise<void> {
		try {
			await this.o.api.ptyOutput(sid, 0, `\r\n\x1b[31m${message}\x1b[0m\r\n`);
			await this.o.api.ptyExit(sid, 1);
		} catch (e) {
			this.log.warn('Terminal-Fehlermeldung konnte nicht gesendet werden', errorMessage(e));
		}
	}

	private async open(cmd: Extract<RunnerCommand, { type: 'pty-open' }>): Promise<void> {
		if (this.sessions.has(cmd.sid)) return;
		const mod = await loadNodePty();
		if (!mod) return this.fail(cmd.sid, 'Terminal nicht verfügbar: node-pty ist auf diesem Runner nicht installiert.');
		if (this.sessions.size >= MAX_SESSIONS) return this.fail(cmd.sid, 'Zu viele offene Terminals auf diesem Runner.');
		let cwd: string;
		try {
			cwd =
				cmd.target === 'main'
					? await this.o.workspace.mainCopy(cmd.project)
					: await this.o.workspace.runWorktree(cmd.target.slice(4));
		} catch (e) {
			return this.fail(cmd.sid, this.o.redactor.redact(errorMessage(e)));
		}
		const isWin = process.platform === 'win32';
		const shell =
			this.o.shell ??
			(isWin ? 'powershell.exe' : process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash');
		const env = { ...publicEnv(this.o.workspace.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
		let pty: IPty;
		try {
			pty = mod.spawn(shell, [], {
				name: 'xterm-256color',
				cols: cmd.cols,
				rows: cmd.rows,
				cwd,
				env,
				// Rohbytes (POSIX), damit Mehrbyte-Zeichen über Chunk-Grenzen korrekt dekodiert werden
				...(isWin ? {} : { encoding: null })
			});
		} catch (e) {
			return this.fail(cmd.sid, `Terminal konnte nicht gestartet werden: ${errorMessage(e)}`);
		}
		const s: Session = {
			sid: cmd.sid,
			pty,
			seq: 0,
			buf: '',
			timer: null,
			chain: Promise.resolve(),
			decoder: new TextDecoder('utf-8'),
			closed: false
		};
		this.sessions.set(cmd.sid, s);
		pty.onData((d) => {
			s.buf += typeof d === 'string' ? d : s.decoder.decode(d, { stream: true });
			if (s.buf.length >= MAX_CHUNK) this.flush(s);
			else if (!s.timer) s.timer = setTimeout(() => this.flush(s), FLUSH_MS);
		});
		pty.onExit(({ exitCode }) => {
			s.buf += s.decoder.decode();
			this.flush(s);
			s.closed = true;
			this.sessions.delete(s.sid);
			s.chain = s.chain
				.then(() => this.o.api.ptyExit(s.sid, Number.isInteger(exitCode) ? exitCode : null))
				.then(
					() => undefined,
					(e: unknown) => this.log.warn('Terminal-Ende konnte nicht gemeldet werden', errorMessage(e))
				);
		});
	}

	private flush(s: Session): void {
		if (s.timer) clearTimeout(s.timer);
		s.timer = null;
		while (s.buf) {
			const data = this.o.redactor.redact(s.buf.slice(0, MAX_CHUNK));
			s.buf = s.buf.slice(MAX_CHUNK);
			const seq = s.seq++;
			s.chain = s.chain
				.then(() => this.o.api.ptyOutput(s.sid, seq, data))
				.then(
					() => undefined,
					(e: unknown) => this.log.warn('Terminal-Ausgabe konnte nicht gesendet werden', errorMessage(e))
				);
		}
	}

	close(sid: string): void {
		const s = this.sessions.get(sid);
		if (!s || s.closed) return;
		try {
			s.pty.kill();
		} catch {
			// bereits beendet
		}
	}

	closeAll(): void {
		for (const sid of [...this.sessions.keys()]) this.close(sid);
	}
}
