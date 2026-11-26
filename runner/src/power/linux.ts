/**
 * Linux: logind über D-Bus (`gdbus monitor`, sonst `dbus-monitor`) auf `PrepareForSleep`/`PrepareForShutdown`
 * beobachten. Ein Delay-Inhibitor (`systemd-inhibit --mode=delay … cat`) verschiebt Standby und
 * Herunterfahren, bis die Übergabe fertig ist (höchstens `InhibitDelayMaxSec` aus `logind.conf`, Standard 5 s).
 * Danach wird er gelöst und nach dem Aufwachen neu gesetzt. `SIGTERM` beim Herunterfahren behandelt `main.ts`.
 */
import { LineProcess } from './line-process.ts';
import type { PowerEventType, PowerHandler, PowerMonitor } from './types.ts';

const LOGIND = 'org.freedesktop.login1';

/**
 * Zeilenparser für `gdbus monitor` und `dbus-monitor`. `gdbus`: eine Zeile je Signal
 * (`…Manager.PrepareForSleep (true,)`), `dbus-monitor`: Kopfzeile mit `member=PrepareForSleep`, Wert in der
 * nächsten Zeile (`boolean true`). Liefert das Ereignis oder `null`.
 */
export class LogindSignalParser {
	private pending: 'sleep' | 'shutdown' | null = null;

	push(line: string): PowerEventType | null {
		const gd = /\.PrepareFor(Sleep|Shutdown)\s*\((true|false)/.exec(line);
		if (gd) return toEvent(gd[1] === 'Sleep' ? 'sleep' : 'shutdown', gd[2] === 'true');
		const head = /member=PrepareFor(Sleep|Shutdown)\b/.exec(line);
		if (head) {
			this.pending = head[1] === 'Sleep' ? 'sleep' : 'shutdown';
			return null;
		}
		if (this.pending) {
			const v = /boolean\s+(true|false)/.exec(line);
			const kind = this.pending;
			this.pending = null;
			if (v) return toEvent(kind, v[1] === 'true');
		}
		return null;
	}
}

function toEvent(kind: 'sleep' | 'shutdown', start: boolean): PowerEventType | null {
	if (kind === 'sleep') return start ? 'suspend' : 'resume';
	return start ? 'shutdown' : null;
}

export class LinuxPowerMonitor implements PowerMonitor {
	readonly name = 'logind';
	readonly graceMs = 4_500;
	private monitor: LineProcess | null = null;
	private inhibitor: LineProcess | null = null;
	private readonly parser = new LogindSignalParser();
	private chain: Promise<void> = Promise.resolve();

	async start(handler: PowerHandler): Promise<boolean> {
		const onLine = (line: string) => {
			const type = this.parser.push(line);
			if (!type) return;
			this.chain = this.chain.then(async () => {
				if (type === 'resume') {
					await this.inhibit();
					await handler({ type, source: this.name });
					return;
				}
				try {
					await handler({ type, source: this.name });
				} finally {
					// Betriebssystem fortfahren lassen
					await this.releaseInhibitor();
				}
			});
		};
		const gdbus = new LineProcess({
			command: 'gdbus',
			args: ['monitor', '--system', '--dest', LOGIND, '--object-path', '/org/freedesktop/login1'],
			onLine
		});
		if (await gdbus.start()) this.monitor = gdbus;
		else {
			const dm = new LineProcess({
				command: 'dbus-monitor',
				args: ['--system', `type='signal',sender='${LOGIND}',interface='${LOGIND}.Manager'`],
				onLine
			});
			if (!(await dm.start())) return false;
			this.monitor = dm;
		}
		await this.inhibit();
		return true;
	}

	/** Delay-Inhibitor setzen (falls nicht schon aktiv) */
	private async inhibit(): Promise<void> {
		if (this.inhibitor?.running) return;
		const p = new LineProcess({
			command: 'systemd-inhibit',
			args: [
				'--what=sleep:shutdown',
				'--who=Atrium-Runner',
				'--why=Laufende Aufträge an einen Server-Runner übergeben',
				'--mode=delay',
				// hält die Sperre, bis stdin geschlossen wird (kein verwaister Kindprozess wie bei `sleep infinity`)
				'cat'
			],
			onLine: () => undefined,
			restartMs: 0
		});
		this.inhibitor = (await p.start()) ? p : null;
	}

	private async releaseInhibitor(): Promise<void> {
		const p = this.inhibitor;
		this.inhibitor = null;
		await p?.stop();
	}

	async stop(): Promise<void> {
		await this.monitor?.stop();
		await this.releaseInhibitor();
		this.monitor = null;
	}
}
