/** Einfaches Protokoll auf stderr (eine Zeile je Meldung, Geheimnisse entfernt). Stufe über `LOG_LEVEL`. */
import { Redactor } from './redact.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
	debug(msg: string, extra?: unknown): void;
	info(msg: string, extra?: unknown): void;
	warn(msg: string, extra?: unknown): void;
	error(msg: string, extra?: unknown): void;
	child(scope: string): Logger;
}

let redactor = new Redactor();

/** Geheimnisse, die auch im lokalen Protokoll nicht erscheinen sollen */
export function setLogRedactor(r: Redactor): void {
	redactor = r;
}

function levelFromEnv(): LogLevel {
	const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
	return v in LEVELS ? (v as LogLevel) : 'info';
}

export function createLogger(scope = 'runner', level: LogLevel = levelFromEnv()): Logger {
	const min = LEVELS[level];
	const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, extra?: unknown) => {
		if (LEVELS[lvl] < min) return;
		let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
		if (extra !== undefined) {
			const s =
				extra instanceof Error
					? extra.message
					: typeof extra === 'string'
						? extra
						: safeJson(extra);
			line += ` ${s}`;
		}
		process.stderr.write(redactor.redact(line) + '\n');
	};
	return {
		debug: (m, e) => write('debug', m, e),
		info: (m, e) => write('info', m, e),
		warn: (m, e) => write('warn', m, e),
		error: (m, e) => write('error', m, e),
		child: (s) => createLogger(`${scope}:${s}`, level)
	};
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

/** Logger ohne Ausgabe (Tests) */
export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger
};
