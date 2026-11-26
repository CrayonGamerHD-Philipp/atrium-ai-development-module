/**
 * Betriebssystem-Aufrufe der PC-Oberfläche: App-Fenster öffnen (Edge/Chrome/Chromium im App-Modus ohne Browserleiste,
 * sonst Standardbrowser), Ordner im Dateimanager öffnen und ein Terminal für `atrium-runner login <konto>` starten.
 * Alle Programme werden mit Argumentlisten gestartet; nur der Windows-Terminalstart braucht eine Kommandozeile –
 * deren Teile sind vorher geprüft (Kontoschlüssel) bzw. maskiert (Pfade).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface OpenDeps {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists(p: string): boolean;
	spawnDetached(cmd: string, args: string[], opts?: { verbatim?: boolean }): Promise<boolean>;
}

/** Programm im Hintergrund starten, ohne darauf zu warten; `false`, wenn es nicht gestartet werden konnte */
function spawnDetached(cmd: string, args: string[], opts: { verbatim?: boolean } = {}): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, {
				detached: true,
				stdio: 'ignore',
				windowsHide: false,
				windowsVerbatimArguments: opts.verbatim === true
			});
			child.once('error', () => resolve(false));
			child.once('spawn', () => {
				child.unref();
				resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}

export const realOpenDeps: OpenDeps = {
	platform: process.platform,
	env: process.env,
	exists: (p) => existsSync(p),
	spawnDetached
};

/** Chromium-artige Browser, die `--app` können (Reihenfolge = Vorzug) */
export function appBrowserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	if (platform === 'win32') {
		const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
		const pf = env.ProgramFiles || 'C:\\Program Files';
		const local = env.LOCALAPPDATA || '';
		const j = path.win32.join;
		return [
			j(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			j(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			...(local ? [j(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
			j(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			j(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')
		];
	}
	if (platform === 'darwin') {
		return [
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			'/Applications/Chromium.app/Contents/MacOS/Chromium',
			'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
		];
	}
	return [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/usr/bin/microsoft-edge',
		'/usr/bin/brave-browser',
		'/snap/bin/chromium'
	];
}

/** App-Fenster öffnen; `profileDir` = eigenes Browser-Profil (Fenstergröße bleibt, keine Erweiterungen) */
export async function openAppWindow(url: string, profileDir: string, d: OpenDeps = realOpenDeps): Promise<string> {
	for (const browser of appBrowserCandidates(d.platform, d.env)) {
		if (!d.exists(browser)) continue;
		const ok = await d.spawnDetached(browser, [
			`--app=${url}`,
			`--user-data-dir=${profileDir}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--window-size=1080,820'
		]);
		if (ok) return path.basename(browser);
	}
	// Standardbrowser (normales Tab)
	if (d.platform === 'win32' && (await d.spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url])))
		return 'Standardbrowser';
	if (d.platform === 'darwin' && (await d.spawnDetached('/usr/bin/open', [url]))) return 'Standardbrowser';
	if (d.platform === 'linux' && (await d.spawnDetached('xdg-open', [url]))) return 'Standardbrowser';
	throw new Error(`Kein Browser gefunden – Adresse manuell öffnen: ${url.split('#')[0]}`);
}

/** Ordner im Dateimanager öffnen */
export async function openFolder(dir: string, d: OpenDeps = realOpenDeps): Promise<boolean> {
	if (d.platform === 'win32') return d.spawnDetached('explorer.exe', [dir]);
	if (d.platform === 'darwin') return d.spawnDetached('/usr/bin/open', [dir]);
	return d.spawnDetached('xdg-open', [dir]);
}

/** Pfad für `cmd.exe` (in doppelten Anführungszeichen; `"` und `%` sind in Windows-Pfaden nicht erlaubt bzw. selten) */
function cmdQuote(s: string): string {
	if (/["%^&|<>]/.test(s)) throw new Error(`Pfad mit Sonderzeichen wird nicht unterstützt: ${s}`);
	return `"${s}"`;
}

/** Wert für eine POSIX-Shell (einfache Anführungszeichen) */
export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Terminal mit `<programm> login <konto> --config <datei>` öffnen (die Anmeldung der CLIs ist interaktiv).
 * `accountKey` muss vorher gegen die Konfiguration geprüft sein (nur `[A-Za-z0-9._-]`).
 */
export async function openLoginTerminal(
	cmd: { exe: string; baseArgs: string[] },
	accountKey: string,
	configFile: string,
	d: OpenDeps = realOpenDeps
): Promise<boolean> {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(accountKey)) throw new Error('Ungültiger Kontoschlüssel');
	const argv = [cmd.exe, ...cmd.baseArgs, 'login', accountKey, '--config', configFile];
	if (d.platform === 'win32') {
		// start "<Titel>" cmd /k ""<exe>" … login <konto> --config "<datei>""
		const inner = [cmdQuote(cmd.exe), ...cmd.baseArgs.map(cmdQuote), 'login', accountKey, '--config', cmdQuote(configFile)].join(' ');
		return d.spawnDetached('cmd.exe', ['/d', '/c', `start "Atrium Runner – Anmeldung" cmd /k "${inner}"`], { verbatim: true });
	}
	const line = argv.map(shQuote).join(' ');
	if (d.platform === 'darwin') {
		const script = `tell application "Terminal" to do script ${JSON.stringify(line)}`;
		const ok = await d.spawnDetached('/usr/bin/osascript', ['-e', script, '-e', 'tell application "Terminal" to activate']);
		return ok;
	}
	const hold = `${line}; echo; read -r -p "Fertig – Eingabetaste schließt das Fenster" _`;
	for (const [term, ...pre] of [
		['x-terminal-emulator', '-e'],
		['gnome-terminal', '--'],
		['konsole', '-e'],
		['xfce4-terminal', '-x'],
		['xterm', '-e']
	] as const) {
		if (await d.spawnDetached(term, [...pre, 'bash', '-c', hold])) return true;
	}
	return false;
}
