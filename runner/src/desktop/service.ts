/**
 * Autostart des PC-Runners beim Anmelden – gemeinsame Schnittstelle, je Betriebssystem umgesetzt:
 *
 * - Linux: systemd-User-Unit `~/.config/systemd/user/atrium-runner.service` (`systemctl --user`)
 * - macOS: LaunchAgent `~/Library/LaunchAgents/de.kalypzo.atrium-runner.plist` (`launchctl bootstrap gui/<uid>`)
 * - Windows: Aufgabe „AtriumRunner“ der Aufgabenplanung bei Anmeldung (Fallback ohne Rechte:
 *   `HKCU\…\Run`), gestartet über ein unsichtbares Startskript (`launch.vbs`, startet bei Absturz neu)
 *
 * Alles im Benutzerkontext ohne Administratorrechte. Gestoppt wird geordnet über die Steuerdatei `stop`
 * (der Runner übergibt laufende Läufe und beendet sich mit Exit-Code 0); erst danach wird hart beendet.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../util/proc.ts';

export interface ServiceSpec {
	/** Programm (Einzel-Binary bzw. `node`) */
	exe: string;
	/** Argumente vor `start` (z. B. Pfad zu `dist/main.js`, wenn `exe` = node) */
	baseArgs: string[];
	configFile: string;
	workDir: string;
	logDir: string;
	/** PATH zum Zeitpunkt der Installation (Agent-CLIs, git, gh) */
	pathEnv: string;
}

export interface ServiceStatus {
	installed: boolean;
	running: boolean;
	detail: string;
}

export interface ServiceManager {
	readonly name: string;
	/** Beschreibung des Eintrags (für Ausgaben) */
	readonly location: string;
	install(spec: ServiceSpec): Promise<void>;
	uninstall(): Promise<void>;
	start(): Promise<void>;
	stop(): Promise<void>;
	status(): Promise<ServiceStatus>;
}

export const SERVICE_LABEL = 'de.kalypzo.atrium-runner';
export const SERVICE_NAME = 'atrium-runner';
export const WINDOWS_TASK = 'AtriumRunner';

export class ServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ServiceError';
	}
}

async function run(cmd: string, args: string[], allowFail = false) {
	const r = await exec(cmd, args, { timeoutMs: 60_000 });
	if (!allowFail && (r.spawnError || r.code !== 0)) {
		throw new ServiceError(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout || r.spawnError || '').toString().trim().slice(0, 500)}`);
	}
	return r;
}

/** Argument für systemd `ExecStart=` (Anführungszeichen, `%`/`$` maskiert) */
export function systemdQuote(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
	const cmd = [spec.exe, ...spec.baseArgs, 'start', '--config', spec.configFile].map(systemdQuote).join(' ');
	return [
		'[Unit]',
		'Description=Atrium aidev-Runner (PC)',
		'Wants=network-online.target',
		'After=network-online.target',
		'',
		'[Service]',
		'Type=simple',
		`ExecStart=${cmd}`,
		`Environment=${systemdQuote(`PATH=${spec.pathEnv}`)}`,
		'Environment=RUNNER_KIND=desktop',
		'Restart=on-failure',
		'RestartSec=10',
		// SIGTERM beim Abmelden/Herunterfahren → Übergabe; danach höchstens 30 s
		'KillSignal=SIGTERM',
		'TimeoutStopSec=30',
		'NoNewPrivileges=true',
		'',
		'[Install]',
		'WantedBy=default.target',
		''
	].join('\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchAgentPlist(spec: ServiceSpec): string {
	const args = [spec.exe, ...spec.baseArgs, 'start', '--config', spec.configFile];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((a) => `		<string>${xml(a)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(spec.pathEnv)}</string>
		<key>RUNNER_KIND</key>
		<string>desktop</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>30</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(path.posix.join(spec.logDir, 'runner.log'))}</string>
	<key>StandardErrorPath</key>
	<string>${xml(path.posix.join(spec.logDir, 'runner.log'))}</string>
</dict>
</plist>
`;
}

/** Unsichtbares Startskript für Windows (startet bei Absturz nach 10 s neu, endet bei Exit-Code 0) */
export function windowsLauncher(spec: ServiceSpec): string {
	const q = (s: string) => `""${s.replace(/"/g, '')}""`;
	const cmd = [spec.exe, ...spec.baseArgs].map(q).join(' ') + ` start --config ${q(spec.configFile)}`;
	const log = path.win32.join(spec.logDir, 'runner.log');
	return [
		"' Atrium aidev-Runner (PC): unsichtbar starten, bei Absturz neu starten",
		'Set sh = CreateObject("WScript.Shell")',
		'sh.Environment("PROCESS")("RUNNER_KIND") = "desktop"',
		'Do',
		`  code = sh.Run("cmd.exe /c ""${cmd} >> ${q(log)} 2>&1""", 0, True)`,
		'  If code = 0 Then Exit Do',
		'  WScript.Sleep 10000',
		'Loop',
		''
	].join('\r\n');
}

// ---------------------------------------------------------------- Linux

class SystemdUserService implements ServiceManager {
	readonly name = 'systemd (Benutzer)';
	readonly location: string;
	constructor(private readonly home: string) {
		this.location = path.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
	}
	async install(spec: ServiceSpec): Promise<void> {
		await mkdir(path.dirname(this.location), { recursive: true });
		await writeFile(this.location, systemdUnit(spec));
		try {
			await run('systemctl', ['--user', 'daemon-reload']);
			await run('systemctl', ['--user', 'enable', SERVICE_NAME]);
		} catch (e) {
			throw new ServiceError(
				`systemd-Benutzerdienst nicht verfügbar (${(e as Error).message}). Die Unit liegt unter ${this.location}; ` +
					'ohne Autostart starten: atrium-runner start'
			);
		}
	}
	async uninstall(): Promise<void> {
		await run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], true);
		await rm(this.location, { force: true });
		await run('systemctl', ['--user', 'daemon-reload'], true);
	}
	async start(): Promise<void> {
		await run('systemctl', ['--user', 'start', SERVICE_NAME]);
	}
	async stop(): Promise<void> {
		await run('systemctl', ['--user', 'stop', SERVICE_NAME]);
	}
	async status(): Promise<ServiceStatus> {
		const installed = existsSync(this.location);
		const r = await run('systemctl', ['--user', 'is-active', SERVICE_NAME], true);
		const state = r.stdout.trim() || 'unbekannt';
		return { installed, running: state === 'active', detail: `systemd: ${state}` };
	}
}

// ---------------------------------------------------------------- macOS

class LaunchAgentService implements ServiceManager {
	readonly name = 'launchd (LaunchAgent)';
	readonly location: string;
	private readonly domain = `gui/${process.getuid?.() ?? 501}`;
	constructor(home: string) {
		this.location = path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
	}
	async install(spec: ServiceSpec): Promise<void> {
		await mkdir(path.dirname(this.location), { recursive: true });
		await mkdir(spec.logDir, { recursive: true });
		await run('launchctl', ['bootout', `${this.domain}/${SERVICE_LABEL}`], true);
		await writeFile(this.location, launchAgentPlist(spec));
	}
	async uninstall(): Promise<void> {
		await run('launchctl', ['bootout', `${this.domain}/${SERVICE_LABEL}`], true);
		await rm(this.location, { force: true });
	}
	async start(): Promise<void> {
		const loaded = await run('launchctl', ['print', `${this.domain}/${SERVICE_LABEL}`], true);
		if (loaded.code !== 0) await run('launchctl', ['bootstrap', this.domain, this.location]);
		await run('launchctl', ['kickstart', `${this.domain}/${SERVICE_LABEL}`], true);
	}
	async stop(): Promise<void> {
		await run('launchctl', ['bootout', `${this.domain}/${SERVICE_LABEL}`], true);
	}
	async status(): Promise<ServiceStatus> {
		const installed = existsSync(this.location);
		const r = await run('launchctl', ['print', `${this.domain}/${SERVICE_LABEL}`], true);
		const m = /state = (\w+)/.exec(r.stdout);
		const state = r.code === 0 ? (m?.[1] ?? 'geladen') : 'nicht geladen';
		return { installed, running: state === 'running', detail: `launchd: ${state}` };
	}
}

// ---------------------------------------------------------------- Windows

class WindowsAutostart implements ServiceManager {
	readonly name = 'Windows-Aufgabenplanung';
	readonly location: string;
	private readonly runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
	constructor(private readonly dataDir: string) {
		this.location = path.win32.join(dataDir, 'launch.vbs');
	}
	private get command(): string {
		return `wscript.exe "${this.location}"`;
	}
	async install(spec: ServiceSpec): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
		await mkdir(spec.logDir, { recursive: true });
		await writeFile(this.location, windowsLauncher(spec));
		// Aufgabe bei Anmeldung des aktuellen Nutzers (eingeschränkte Rechte); ohne Berechtigung → Run-Schlüssel
		const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME ?? '');
		const task = await run(
			'schtasks',
			['/Create', '/F', '/TN', WINDOWS_TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', ...(user ? ['/RU', user, '/IT'] : []), '/TR', this.command],
			true
		);
		if (task.code !== 0) {
			await run('reg', ['add', this.runKey, '/v', WINDOWS_TASK, '/t', 'REG_SZ', '/d', this.command, '/f']);
		} else {
			await run('reg', ['delete', this.runKey, '/v', WINDOWS_TASK, '/f'], true);
		}
	}
	async uninstall(): Promise<void> {
		await run('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK], true);
		await run('reg', ['delete', this.runKey, '/v', WINDOWS_TASK, '/f'], true);
		await rm(this.location, { force: true });
	}
	async start(): Promise<void> {
		const t = await run('schtasks', ['/Run', '/TN', WINDOWS_TASK], true);
		if (t.code !== 0) await run('wscript.exe', [this.location]);
	}
	async stop(): Promise<void> {
		// geordnet über die Steuerdatei (siehe `stopViaControl`); hier nur die Aufgabe beenden
		await run('schtasks', ['/End', '/TN', WINDOWS_TASK], true);
	}
	async status(): Promise<ServiceStatus> {
		const t = await run('schtasks', ['/Query', '/TN', WINDOWS_TASK], true);
		const reg = await run('reg', ['query', this.runKey, '/v', WINDOWS_TASK], true);
		const installed = existsSync(this.location) && (t.code === 0 || reg.code === 0);
		const how = t.code === 0 ? 'Aufgabe „AtriumRunner“' : reg.code === 0 ? 'Autostart (Run-Schlüssel)' : 'kein Autostart';
		return { installed, running: false, detail: how };
	}
}

export function serviceManager(
	o: { platform?: NodeJS.Platform; home?: string; dataDir: string }
): ServiceManager {
	const platform = o.platform ?? process.platform;
	const home = o.home ?? os.homedir();
	if (platform === 'win32') return new WindowsAutostart(o.dataDir);
	if (platform === 'darwin') return new LaunchAgentService(home);
	if (platform === 'linux') return new SystemdUserService(home);
	throw new ServiceError(`Autostart wird auf ${platform} nicht unterstützt`);
}
