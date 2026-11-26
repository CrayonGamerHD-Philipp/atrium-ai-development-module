/**
 * Energie-Ereignisse des PCs (Desktop-Runner): `suspend` (Standby steht bevor), `resume` (aufgewacht) und `shutdown`
 * (Herunterfahren/Abmelden steht bevor). Ohne native Abhängigkeiten – je Plattform ein Kindprozess mit Bordmitteln:
 *
 * - **Linux (systemd-logind):** `systemd-inhibit --mode=delay` hält einen Delay-Inhibitor (logind wartet bis zu
 *   `InhibitDelayMaxSec`, Standard 5 s), `gdbus monitor` (Rückfall `dbus-monitor`) meldet `PrepareForSleep` und
 *   `PrepareForShutdown`. `ack()` gibt den Inhibitor nach erledigter Übergabe frei; nach dem Aufwachen bzw. einem
 *   abgebrochenen Herunterfahren wird er neu geholt.
 * - **Windows:** PowerShell mit einem verborgenen Fenster (`WM_POWERBROADCAST`, `WM_QUERYENDSESSION`,
 *   `WM_ENDSESSION`). Vor dem Standby bleiben ca. 2 s; beim Herunterfahren wartet das Fenster in `WM_ENDSESSION` bis
 *   `ack()` (höchstens bis zur Frist).
 * - **macOS:** `osascript` (JXA) beobachtet `NSWorkspaceWillSleep`, `NSWorkspaceDidWake` und `NSWorkspaceWillPowerOff`.
 *   Aufschieben lässt sich der Standby nicht, `ack()` hat keine Wirkung.
 *
 * Auf allen Plattformen zusätzlich: Rückfall über einen Uhrsprung (der Timer feuert nach dem Aufwachen deutlich zu
 * spät) → `resume`. Fehlende Werkzeuge führen nur zu einer Warnung; dann bleibt der Uhrsprung.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';

export type PowerEventKind = 'suspend' | 'resume' | 'shutdown';
export type PowerSource = 'logind' | 'windows' | 'macos' | 'clock' | 'test';

export interface PowerEvent {
	kind: PowerEventKind;
	source: PowerSource;
	/** Zusatz für das Protokoll, z. B. `poweroff`, `reboot` oder die Größe des Uhrsprungs */
	detail?: string;
}

/** Minimaler Kindprozess (Node-`ChildProcess` oder ein Test-Double) */
export interface PowerChild {
	readonly stdin: NodeJS.WritableStream | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: 'error', listener: (err: Error) => void): unknown;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Kindprozess-Starter (injizierbar für Tests) */
export type PowerSpawn = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => PowerChild;

export const defaultPowerSpawn: PowerSpawn = (cmd, args, env) =>
	nodeSpawn(cmd, args, {
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		env: env ?? process.env
	});

/** Schnittstelle, die der Runner nutzt (Tests ersetzen den Monitor) */
export interface PowerMonitorLike {
	onEvent(listener: (e: PowerEvent) => void): void;
	start(): void;
	stop(): void;
	ack(): void;
}

// ---------------------------------------------------------------- Zeilenparser (rein)

/** Signal von logind */
export interface LogindSignal {
	signal: 'sleep' | 'shutdown';
	start: boolean;
	/** Nur `PrepareForShutdownWithMetadata`: Art (`poweroff`, `reboot`, `kexec`, …) */
	type?: string;
}

const GDBUS_RE =
	/^\/org\/freedesktop\/login1: org\.freedesktop\.login1\.Manager\.(PrepareForSleep|PrepareForShutdown(?:WithMetadata)?) \((true|false)\b(.*)$/;

/** Eine Zeile von `gdbus monitor --system --dest org.freedesktop.login1 …` auswerten */
export function parseGdbusLine(line: string): LogindSignal | null {
	const m = GDBUS_RE.exec(line.trim());
	if (!m) return null;
	const out: LogindSignal = { signal: m[1] === 'PrepareForSleep' ? 'sleep' : 'shutdown', start: m[2] === 'true' };
	const type = /'type': <'([a-z-]+)'>/.exec(m[3] ?? '');
	if (type?.[1]) out.type = type[1];
	return out;
}

/** Zustand des `dbus-monitor`-Parsers: Signal der Kopfzeile, dessen Wert noch aussteht */
export interface DbusMonitorState {
	pending: 'sleep' | 'shutdown' | null;
}

/**
 * Eine Zeile von `dbus-monitor --system …` auswerten. Das Format ist zweizeilig (Kopfzeile mit `member=…`, dann
 * `   boolean true`); der Zustand wird als neuer Wert zurückgegeben.
 */
export function parseDbusMonitorLine(
	line: string,
	state: DbusMonitorState
): { state: DbusMonitorState; signal: LogindSignal | null } {
	const head = /^signal .*interface=org\.freedesktop\.login1\.Manager; member=(\w+)/.exec(line);
	if (head) {
		const member = head[1] ?? '';
		const pending =
			member === 'PrepareForSleep'
				? 'sleep'
				: member === 'PrepareForShutdown' || member === 'PrepareForShutdownWithMetadata'
					? 'shutdown'
					: null;
		return { state: { pending }, signal: null };
	}
	if (/^(signal|method|error) /.test(line)) return { state: { pending: null }, signal: null };
	const val = /^\s+boolean (true|false)\s*$/.exec(line);
	if (val && state.pending) return { state: { pending: null }, signal: { signal: state.pending, start: val[1] === 'true' } };
	return { state, signal: null };
}

/** Präfix der Zeilen aus den Hilfsskripten (Windows, macOS) */
export const POWER_LINE_PREFIX = 'AIDEV-POWER';

export type HelperLine =
	| { type: 'event'; kind: PowerEventKind }
	| { type: 'ready' }
	| { type: 'error'; message: string };

/** Eine Zeile der Hilfsskripte (`AIDEV-POWER suspend|resume|shutdown|ready|error <text>`) auswerten */
export function parseHelperLine(line: string): HelperLine | null {
	const m = /^AIDEV-POWER (suspend|resume|shutdown|ready|error)(?: (.*))?$/.exec(line.trim());
	if (!m) return null;
	const word = m[1] as PowerEventKind | 'ready' | 'error';
	if (word === 'ready') return { type: 'ready' };
	if (word === 'error') return { type: 'error', message: (m[2] ?? '').slice(0, 500) };
	return { type: 'event', kind: word };
}

// ---------------------------------------------------------------- Hilfsskripte

/** PowerShell (Windows PowerShell 5.1, C# 5): verborgenes Fenster für Energie- und Sitzungsnachrichten */
export function windowsScript(waitMs: number): string {
	const ms = Math.max(0, Math.min(60_000, Math.floor(waitMs)));
	return `$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Threading;
using System.Windows.Forms;
public class AidevPowerWindow : Form {
	public static readonly ManualResetEvent Acked = new ManualResetEvent(false);
	public static int WaitMs = 8000;
	const int WM_POWERBROADCAST = 0x0218, WM_QUERYENDSESSION = 0x0011, WM_ENDSESSION = 0x0016;
	const int PBT_APMSUSPEND = 0x0004, PBT_APMRESUMESUSPEND = 0x0007, PBT_APMRESUMEAUTOMATIC = 0x0012;
	public AidevPowerWindow() { ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None; Opacity = 0; }
	protected override void SetVisibleCore(bool value) {
		if (!IsHandleCreated) CreateHandle();
		base.SetVisibleCore(false);
	}
	public static void Emit(string kind) {
		Acked.Reset();
		Console.Out.WriteLine("${POWER_LINE_PREFIX} " + kind);
		Console.Out.Flush();
	}
	protected override void WndProc(ref Message m) {
		if (m.Msg == WM_POWERBROADCAST) {
			int ev = m.WParam.ToInt32();
			if (ev == PBT_APMSUSPEND) { Emit("suspend"); Acked.WaitOne(Math.Min(WaitMs, 1800)); }
			else if (ev == PBT_APMRESUMESUSPEND || ev == PBT_APMRESUMEAUTOMATIC) Emit("resume");
		} else if (m.Msg == WM_QUERYENDSESSION) {
			Emit("shutdown");
			m.Result = (IntPtr)1;
			return;
		} else if (m.Msg == WM_ENDSESSION && m.WParam != IntPtr.Zero) {
			Acked.WaitOne(WaitMs);
		}
		base.WndProc(ref m);
	}
	static void ReadStdin() {
		string line;
		while ((line = Console.In.ReadLine()) != null) { if (line.Trim() == "ack") Acked.Set(); }
		Environment.Exit(0);
	}
	public static void Run(int waitMs) {
		WaitMs = waitMs;
		Thread t = new Thread(ReadStdin);
		t.IsBackground = true;
		t.Start();
		AidevPowerWindow w = new AidevPowerWindow();
		Emit("ready");
		Application.Run(w);
	}
}
'@
[AidevPowerWindow]::Run(${ms})
} catch {
	[Console]::Out.WriteLine('${POWER_LINE_PREFIX} error ' + $_.Exception.Message)
	exit 1
}
`;
}

/** JXA für `osascript -l JavaScript`: NSWorkspace-Benachrichtigungen; endet, sobald stdin schließt */
export function macScript(): string {
	return `ObjC.import('AppKit');
ObjC.import('Foundation');
var running = true;
function out(s) {
	var d = $.NSString.alloc.initWithUTF8String('${POWER_LINE_PREFIX} ' + s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding);
	$.NSFileHandle.fileHandleWithStandardOutput.writeData(d);
}
ObjC.registerSubclass({
	name: 'AidevPowerObserver',
	methods: {
		'willSleep:': { types: ['void', ['id']], implementation: function (n) { out('suspend'); } },
		'didWake:': { types: ['void', ['id']], implementation: function (n) { out('resume'); } },
		'willPowerOff:': { types: ['void', ['id']], implementation: function (n) { out('shutdown'); } },
		'stdinRead:': {
			types: ['void', ['id']],
			implementation: function (n) {
				var d = n.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
				if (!d || d.isNil() || d.length == 0) { running = false; return; }
				n.object.readInBackgroundAndNotify;
			}
		}
	}
});
var obs = $.AidevPowerObserver.alloc.init;
var nc = $.NSWorkspace.sharedWorkspace.notificationCenter;
nc.addObserverSelectorNameObject(obs, 'willSleep:', $.NSWorkspaceWillSleepNotification, $());
nc.addObserverSelectorNameObject(obs, 'didWake:', $.NSWorkspaceDidWakeNotification, $());
nc.addObserverSelectorNameObject(obs, 'willPowerOff:', $.NSWorkspaceWillPowerOffNotification, $());
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(obs, 'stdinRead:', $.NSFileHandleReadCompletionNotification, stdin);
stdin.readInBackgroundAndNotify;
out('ready');
while (running) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1));
`;
}

// ---------------------------------------------------------------- Monitor

export interface PowerMonitorOptions {
	platform?: NodeJS.Platform;
	spawn?: PowerSpawn;
	log?: Logger;
	/** Höchstwartezeit des Windows-Fensters auf `ack()` beim Herunterfahren (Standard 8 s) */
	waitMs?: number;
	/** Plattform-Beobachtung abschalten (nur Uhrsprung) */
	platformEvents?: boolean;
	/** Abstand der Uhrprüfung (Standard 5 s) */
	clockTickMs?: number;
	/** Ab dieser Verspätung des Timers gilt ein Uhrsprung als Aufwachen (Standard 30 s) */
	clockJumpMs?: number;
	/** Zweites `resume` innerhalb dieser Zeit ohne `suspend` dazwischen wird verworfen (Standard 20 s) */
	resumeDedupMs?: number;
	now?: () => number;
}

interface Proc {
	child: PowerChild;
	/** Absichtlich beendet (kein Fehler im Log) */
	closing: boolean;
}

const INHIBIT_ARGS = [
	'--what=sleep:shutdown',
	'--mode=delay',
	'--no-ask-password',
	'--who=Atrium aidev-Runner',
	'--why=Übergabe laufender Läufe an den Server',
	'cat'
];
const GDBUS_ARGS = [
	'monitor',
	'--system',
	'--dest',
	'org.freedesktop.login1',
	'--object-path',
	'/org/freedesktop/login1'
];
const DBUS_MONITOR_ARGS = [
	'--system',
	"type='signal',sender='org.freedesktop.login1',interface='org.freedesktop.login1.Manager',path='/org/freedesktop/login1'"
];
/** Unerwartete Abbrüche des Beobachters, nach denen nur noch der Uhrsprung bleibt */
const MAX_RESTARTS = 3;

export class PowerMonitor implements PowerMonitorLike {
	private readonly listeners: ((e: PowerEvent) => void)[] = [];
	private readonly platform: NodeJS.Platform;
	private readonly spawn: PowerSpawn;
	private readonly log: Logger;
	private readonly now: () => number;
	private running = false;
	private clock: NodeJS.Timeout | null = null;
	private lastTick = 0;
	private watcher: Proc | null = null;
	private inhibitor: Proc | null = null;
	private restarts = 0;
	private inhibitWarned = false;
	/** Standby gemeldet, Aufwachen noch nicht */
	private suspended = false;
	/** Herunterfahren gemeldet (Doppelmeldungen von logind zusammenfassen) */
	private shuttingDown = false;
	private lastResumeAt = Number.NEGATIVE_INFINITY;
	/** Aktive Methoden (für Protokoll und Tests) */
	readonly methods: string[] = [];

	constructor(private readonly o: PowerMonitorOptions = {}) {
		this.platform = o.platform ?? process.platform;
		this.spawn = o.spawn ?? defaultPowerSpawn;
		this.log = o.log ?? silentLogger;
		this.now = o.now ?? Date.now;
	}

	onEvent(listener: (e: PowerEvent) => void): void {
		this.listeners.push(listener);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.startClock();
		if (this.o.platformEvents === false) return;
		if (this.platform === 'linux') {
			this.acquireInhibitor();
			this.startWatcher('gdbus');
		} else if (this.platform === 'win32') {
			this.startWatcher('windows');
		} else if (this.platform === 'darwin') {
			this.startWatcher('macos');
		} else {
			this.log.warn(`Energie-Ereignisse auf ${this.platform} nicht unterstützt – nur Erkennung über Uhrsprung`);
		}
	}

	stop(): void {
		this.running = false;
		if (this.clock) clearInterval(this.clock);
		this.clock = null;
		this.closeProc(this.watcher);
		this.watcher = null;
		this.releaseInhibitor();
	}

	/**
	 * Übergabe erledigt: Linux gibt den Delay-Inhibitor frei (logind fährt sofort fort), Windows lässt das Fenster
	 * weiterlaufen (`WM_ENDSESSION`/`PBT_APMSUSPEND` warten nicht länger). Ohne anstehendes Ereignis wirkungslos.
	 */
	ack(): void {
		if (this.platform === 'linux') {
			if (this.suspended || this.shuttingDown) this.releaseInhibitor();
		} else if (this.platform === 'win32') {
			this.write(this.watcher, 'ack\n');
		}
	}

	// ---------------------------------------------------------------- Ereignisse

	private emit(e: PowerEvent): void {
		if (!this.running) return;
		this.log.info(`Energie-Ereignis: ${e.kind} (${e.source}${e.detail ? `, ${e.detail}` : ''})`);
		for (const l of this.listeners) {
			try {
				l(e);
			} catch (err) {
				this.log.error('Fehler beim Verarbeiten eines Energie-Ereignisses', (err as Error).message);
			}
		}
	}

	private suspend(source: PowerSource): void {
		if (this.suspended) return;
		this.suspended = true;
		this.emit({ kind: 'suspend', source });
	}

	private resume(source: PowerSource, detail?: string): void {
		const now = this.now();
		// Plattform und Uhrsprung melden dasselbe Aufwachen: nur einmal weitergeben
		if (!this.suspended && now - this.lastResumeAt < (this.o.resumeDedupMs ?? 20_000)) return;
		this.suspended = false;
		this.lastResumeAt = now;
		if (this.platform === 'linux' && this.running && this.o.platformEvents !== false) this.acquireInhibitor();
		this.emit({ kind: 'resume', source, detail });
	}

	private shutdown(source: PowerSource, detail?: string): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.emit({ kind: 'shutdown', source, detail });
	}

	/** Signal von logind verarbeiten */
	private logind(s: LogindSignal): void {
		if (s.signal === 'sleep') {
			if (s.start) this.suspend('logind');
			else this.resume('logind');
		} else if (s.start) {
			this.shutdown('logind', s.type);
		} else {
			// Herunterfahren abgebrochen: Inhibitor neu holen
			this.shuttingDown = false;
			this.log.info('Herunterfahren abgebrochen');
			this.acquireInhibitor();
		}
	}

	// ---------------------------------------------------------------- Uhrsprung

	private startClock(): void {
		const tick = this.o.clockTickMs ?? 5_000;
		const jump = this.o.clockJumpMs ?? 30_000;
		this.lastTick = this.now();
		this.clock = setInterval(() => {
			const now = this.now();
			const late = now - this.lastTick - tick;
			this.lastTick = now;
			if (late >= jump) this.resume('clock', `Uhrsprung ${Math.round(late / 1000)} s`);
		}, tick);
		this.clock.unref();
		this.methods.push('clock');
	}

	// ---------------------------------------------------------------- Kindprozesse

	private startProc(cmd: string, args: string[], onLine: (line: string) => void, onGone: (err: Error | null) => void): Proc | null {
		let child: PowerChild;
		try {
			child = this.spawn(cmd, args);
		} catch (e) {
			onGone(e as Error);
			return null;
		}
		const proc: Proc = { child, closing: false };
		let gone = false;
		const finish = (err: Error | null) => {
			if (gone) return;
			gone = true;
			onGone(proc.closing ? null : err);
		};
		child.on('error', (err) => finish(err));
		child.on('exit', (code, signal) => finish(new Error(`beendet (${signal ?? `Code ${String(code)}`})`)));
		// Schreibfehler (Prozess bereits weg) nicht als unbehandelten Fehler werfen
		(child.stdin as (NodeJS.WritableStream & { on?: (e: string, l: () => void) => void }) | null)?.on?.('error', () => undefined);
		for (const stream of [child.stdout, child.stderr]) {
			if (!stream) continue;
			const rl = createInterface({ input: stream, crlfDelay: Infinity });
			rl.on('line', (line) => {
				try {
					onLine(line);
				} catch (e) {
					this.log.warn('Energie-Ereignis: Zeile nicht verarbeitet', (e as Error).message);
				}
			});
		}
		return proc;
	}

	private closeProc(p: Proc | null): void {
		if (!p) return;
		p.closing = true;
		try {
			p.child.stdin?.end();
		} catch {
			// bereits geschlossen
		}
		try {
			p.child.kill('SIGTERM');
		} catch {
			// bereits beendet
		}
	}

	private write(p: Proc | null, data: string): void {
		try {
			p?.child.stdin?.write(data);
		} catch {
			// Prozess bereits weg
		}
	}

	private startWatcher(kind: 'gdbus' | 'dbus-monitor' | 'windows' | 'macos'): void {
		if (!this.running) return;
		const label =
			kind === 'windows' ? 'PowerShell-Fenster' : kind === 'macos' ? 'osascript (NSWorkspace)' : kind;
		let cmd: string;
		let args: string[];
		let onLine: (line: string) => void;
		if (kind === 'gdbus') {
			cmd = 'gdbus';
			args = GDBUS_ARGS;
			onLine = (line) => {
				const s = parseGdbusLine(line);
				if (s) this.logind(s);
			};
		} else if (kind === 'dbus-monitor') {
			cmd = 'dbus-monitor';
			args = DBUS_MONITOR_ARGS;
			let state: DbusMonitorState = { pending: null };
			onLine = (line) => {
				const r = parseDbusMonitorLine(line, state);
				state = r.state;
				if (r.signal) this.logind(r.signal);
			};
		} else {
			const source: PowerSource = kind;
			if (kind === 'windows') {
				cmd = 'powershell.exe';
				const encoded = Buffer.from(windowsScript(this.o.waitMs ?? 8_000), 'utf16le').toString('base64');
				args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
			} else {
				cmd = 'osascript';
				args = ['-l', 'JavaScript', '-e', macScript()];
			}
			onLine = (line) => {
				const h = parseHelperLine(line);
				if (!h) return;
				if (h.type === 'ready') this.log.info(`Energie-Ereignisse: ${label} bereit`);
				else if (h.type === 'error') this.log.warn(`Energie-Ereignisse: ${label} meldet einen Fehler`, h.message);
				else if (h.kind === 'suspend') this.suspend(source);
				else if (h.kind === 'resume') this.resume(source);
				else this.shutdown(source);
			};
		}
		const started = this.now();
		// `let` vorab: schlägt der Start sofort fehl, ruft `startProc` den Rückruf noch vor der Zuweisung auf
		let proc: Proc | null = null;
		proc = this.startProc(cmd, args, onLine, (err) => {
			if (this.watcher === proc) this.watcher = null;
			if (!err || !this.running) return;
			const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
			if (missing && kind === 'gdbus') {
				this.log.info('gdbus nicht gefunden – versuche dbus-monitor');
				this.dropMethod(label);
				this.startWatcher('dbus-monitor');
				return;
			}
			this.dropMethod(label);
			if (!missing && this.restarts < MAX_RESTARTS && this.now() - started > 1_000) {
				this.restarts++;
				this.log.warn(`Energie-Ereignisse: ${label} ${err.message} – starte neu`);
				const t = setTimeout(() => this.startWatcher(kind), 2_000);
				t.unref();
				return;
			}
			this.log.warn(
				`Energie-Ereignisse: ${label} nicht verfügbar (${missing ? 'nicht gefunden' : err.message}) – nur Erkennung über Uhrsprung`
			);
		});
		if (!proc) return;
		this.watcher = proc;
		this.methods.push(label);
	}

	private dropMethod(label: string): void {
		const i = this.methods.indexOf(label);
		if (i >= 0) this.methods.splice(i, 1);
	}

	private acquireInhibitor(): void {
		if (this.inhibitor || !this.running) return;
		let proc: Proc | null = null;
		proc = this.startProc('systemd-inhibit', INHIBIT_ARGS, () => undefined, (err) => {
			if (this.inhibitor === proc) this.inhibitor = null;
			if (!err || !this.running || this.inhibitWarned) return;
			this.inhibitWarned = true;
			this.log.warn(
				'Delay-Inhibitor von logind nicht verfügbar – Standby und Herunterfahren warten nicht auf die Übergabe',
				(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'systemd-inhibit nicht gefunden' : err.message
			);
		});
		this.inhibitor = proc;
	}

	private releaseInhibitor(): void {
		const p = this.inhibitor;
		this.inhibitor = null;
		if (!p) return;
		p.closing = true;
		// stdin schließen → `cat` endet → Lock frei; Rückfall SIGTERM
		try {
			p.child.stdin?.end();
		} catch {
			// bereits geschlossen
		}
		const t = setTimeout(() => {
			try {
				p.child.kill('SIGTERM');
			} catch {
				// bereits beendet
			}
		}, 1_000);
		t.unref();
	}
}
