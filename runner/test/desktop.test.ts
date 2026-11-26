/** PC-Betrieb: Erkennung von Energie-Ereignissen (Parser, Zeitsprung, Fake), Pfade, Autostart-Dateien, Konfiguration. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { desktopPaths } from '../src/desktop/paths.ts';
import { launchAgentPlist, systemdQuote, systemdUnit, windowsLauncher, type ServiceSpec } from '../src/desktop/service.ts';
import { desktopConfigTemplate } from '../src/desktop/template.ts';
import { isolationHint, personalDataFindings } from '../src/desktop/isolation.ts';
import { installHint } from '../src/desktop/tools.ts';
import { ClockDriftMonitor, FakePowerMonitor } from '../src/power/index.ts';
import { CombinedPowerMonitor } from '../src/power/index.ts';
import { LogindSignalParser } from '../src/power/linux.ts';
import type { PowerEvent } from '../src/power/types.ts';
import { encodePowerShell, windowsHelperScript } from '../src/power/windows.ts';

describe('logind-Signale', () => {
	it('gdbus monitor: eine Zeile je Signal', () => {
		const p = new LogindSignalParser();
		expect(p.push('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)')).toBe('suspend');
		expect(p.push('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)')).toBe('resume');
		expect(p.push('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (true,)')).toBe('shutdown');
		expect(p.push('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (false,)')).toBeNull();
		expect(p.push('/org/freedesktop/login1: org.freedesktop.login1.Manager.SessionNew (\'3\', ...)')).toBeNull();
	});
	it('dbus-monitor: Kopfzeile, Wert in der nächsten Zeile', () => {
		const p = new LogindSignalParser();
		expect(p.push('signal time=1.2 sender=:1.3 -> destination=(null destination) serial=9 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep')).toBeNull();
		expect(p.push('   boolean true')).toBe('suspend');
		p.push('signal … member=PrepareForSleep');
		expect(p.push('   boolean false')).toBe('resume');
	});
});

describe('Zeitsprung-Erkennung (Aufwachen ohne Ereignis)', () => {
	it('meldet resume nur bei großem Sprung der Wanduhr', async () => {
		let now = 1_000_000;
		const m = new ClockDriftMonitor({ intervalMs: 5_000, thresholdMs: 30_000, now: () => now });
		const seen: PowerEvent[] = [];
		const handler = async (e: PowerEvent) => {
			seen.push(e);
		};
		await m.start(handler);
		now += 5_100;
		await m.tick(handler);
		expect(seen).toEqual([]);
		now += 5_000 + 600_000;
		await m.tick(handler);
		expect(seen).toEqual([{ type: 'resume', source: 'clock', sleptMs: 600_000 }]);
		await m.stop();
	});
	it('kombinierte Überwachung: verfügbar, wenn ein Teil startet; Frist = kürzeste', async () => {
		const fake = new FakePowerMonitor(1_700);
		const c = new CombinedPowerMonitor([fake, new ClockDriftMonitor()]);
		expect(c.graceMs).toBe(1_700);
		expect(await c.start(async () => undefined)).toBe(true);
		expect(c.started).toEqual(['fake', 'clock']);
		await c.stop();
	});
});

describe('Windows-Hilfsprozess', () => {
	it('Skript enthält Fenster-Nachrichten und ist für -EncodedCommand kodiert', () => {
		const script = windowsHelperScript();
		expect(script).toContain('WM_POWERBROADCAST');
		expect(script).toContain('ShutdownBlockReasonCreate');
		expect(script).toContain("Add-Type -ReferencedAssemblies System.Windows.Forms");
		expect(Buffer.from(encodePowerShell(script), 'base64').toString('utf16le')).toBe(script);
	});
});

const spec: ServiceSpec = {
	exe: '/opt/atrium runner/atrium-runner',
	baseArgs: [],
	configFile: '/home/max/.config/atrium-runner/runner.config.json',
	workDir: '/home/max/.local/share/atrium-runner/work',
	logDir: '/home/max/.local/share/atrium-runner/logs',
	pathEnv: '/usr/local/bin:/usr/bin:/bin'
};

describe('Autostart-Dateien', () => {
	it('systemd-User-Unit: ExecStart maskiert, PATH, SIGTERM-Übergabe, kein Root', () => {
		const unit = systemdUnit(spec);
		expect(unit).toContain('ExecStart="/opt/atrium runner/atrium-runner" "start" "--config" "/home/max/.config/atrium-runner/runner.config.json"');
		expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
		expect(unit).toContain('KillSignal=SIGTERM');
		expect(unit).toContain('WantedBy=default.target');
		expect(systemdQuote('50%$HOME')).toBe('"50%%$$HOME"');
	});
	it('LaunchAgent: Programm, RunAtLoad, Logs, XML maskiert', () => {
		const plist = launchAgentPlist({ ...spec, exe: '/Applications/A&B/atrium-runner' });
		expect(plist).toContain('<string>/Applications/A&amp;B/atrium-runner</string>');
		expect(plist).toContain('<key>RunAtLoad</key>');
		expect(plist).toContain('runner.log');
	});
	it('Windows: unsichtbares Startskript mit Neustart bei Absturz', () => {
		const vbs = windowsLauncher({
			...spec,
			exe: 'C:\\Users\\max\\AppData\\Local\\Programs\\AtriumRunner\\atrium-runner.exe',
			configFile: 'C:\\Users\\max\\AppData\\Roaming\\AtriumRunner\\runner.config.json',
			logDir: 'C:\\Users\\max\\AppData\\Local\\AtriumRunner\\logs'
		});
		expect(vbs).toContain('sh.Run(');
		expect(vbs).toContain(', 0, True)');
		expect(vbs).toContain('If code = 0 Then Exit Do');
		expect(vbs).toContain('atrium-runner.exe');
	});
});

describe('Pfade und Vorlage', () => {
	it('Standardpfade je Betriebssystem', () => {
		expect(desktopPaths('linux', {}, '/home/max').configFile).toBe('/home/max/.config/atrium-runner/runner.config.json');
		expect(desktopPaths('linux', { XDG_DATA_HOME: '/data' }, '/home/max').workDir).toBe('/data/atrium-runner/work');
		expect(desktopPaths('darwin', {}, '/Users/max').configDir).toBe('/Users/max/Library/Application Support/AtriumRunner');
		const win = desktopPaths('win32', { APPDATA: 'C:\\U\\R', LOCALAPPDATA: 'C:\\U\\L' }, 'C:\\U');
		expect(win.configFile).toBe('C:\\U\\R\\AtriumRunner\\runner.config.json');
		expect(win.workDir).toBe('C:\\U\\L\\AtriumRunner\\work');
	});
	it('Vorlage ist eine gültige Konfiguration (desktop, Checkpoints, Übergabefrist)', () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'aidev-tpl-'));
		const file = path.join(dir, 'runner.config.json');
		writeFileSync(file, desktopConfigTemplate({ name: 'pc', workDir: path.join(dir, 'work') }));
		const cfg = loadConfig({ env: {}, configPath: file });
		expect(cfg).toMatchObject({ kind: 'desktop', handoverSec: 20, wipCheckpointMin: 10, powerEvents: true, maxSlots: 2 });
		expect(cfg.accounts.map((a) => a.provider)).toEqual(['claude', 'codex']);
	});
	it('Umgebung: RUNNER_KIND, HANDOVER_SEC, WIP_CHECKPOINT_MIN, POWER_EVENTS; Standard Server ohne Checkpoints', () => {
		const base = { ATRIUM_URL: 'http://x', ATRIUM_API_KEY: 'secret-key-1' };
		expect(loadConfig({ env: base, cwd: os.tmpdir() })).toMatchObject({ kind: 'server', wipCheckpointMin: 0, powerEvents: false, handoverSec: 20 });
		expect(
			loadConfig({ env: { ...base, RUNNER_KIND: 'desktop', HANDOVER_SEC: '8', POWER_EVENTS: '0' }, cwd: os.tmpdir() })
		).toMatchObject({ kind: 'desktop', handoverSec: 8, wipCheckpointMin: 10, powerEvents: false });
		expect(() => loadConfig({ env: { ...base, RUNNER_KIND: 'laptop' }, cwd: os.tmpdir() })).toThrow(/RUNNER_KIND/);
		expect(() => loadConfig({ env: { ...base, HANDOVER_SEC: '1' }, cwd: os.tmpdir() })).toThrow(/HANDOVER_SEC/);
	});
	it('Installationshinweise für fehlende Programme', () => {
		expect(installHint('git', 'win32')).toContain('winget');
		expect(installHint('gh', 'darwin')).toContain('brew');
		expect(installHint('claude', 'linux')).toContain('@anthropic-ai/claude-code');
	});
});

describe('Isolation ohne Docker (persönliche Daten im Home)', () => {
	const fakeFs = (files: string[], dirs: Record<string, string[]> = {}) => ({
		exists: (p: string) => files.includes(p.replace(/\\/g, '/')),
		list: (p: string) => dirs[p.replace(/\\/g, '/')] ?? []
	});

	it('findet private SSH-Schlüssel, aber nicht known_hosts/config allein', () => {
		const only = fakeFs([], { '/home/a/.ssh': ['known_hosts', 'config'] });
		expect(personalDataFindings('/home/a', 'linux', only)).toEqual([]);
		const keys = fakeFs([], { '/home/a/.ssh': ['known_hosts', 'id_ed25519', 'id_ed25519.pub'] });
		expect(personalDataFindings('/home/a', 'linux', keys)).toEqual([{ label: 'SSH-Schlüssel', path: '~/.ssh/id_ed25519' }]);
	});

	it('prüft Browser-Profile nur für das jeweilige System', () => {
		const files = ['/home/a/.mozilla/firefox', 'C:/Users/a/AppData/Local/Google/Chrome/User Data'];
		expect(personalDataFindings('/home/a', 'linux', fakeFs(files)).map((f) => f.label)).toEqual(['Browser-Profil (Firefox)']);
		const win = personalDataFindings('C:\\Users\\a', 'win32', fakeFs(files));
		expect(win).toEqual([
			{ label: 'Browser-Profil (Chrome)', path: '%USERPROFILE%\\AppData\\Local\\Google\\Chrome\\User Data' }
		]);
	});

	it('Hinweis nur bei Funden, mit Benutzer und Empfehlung', () => {
		expect(isolationHint([], 'a')).toBeNull();
		const hint = isolationHint([{ label: 'GnuPG-Schlüssel', path: '~/.gnupg' }], 'a')!;
		expect(hint).toContain('„a“');
		expect(hint).toContain('GnuPG-Schlüssel: ~/.gnupg');
		expect(hint).toContain('eigenen Benutzerkonto');
	});
});
