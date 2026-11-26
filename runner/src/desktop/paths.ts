/**
 * Standardpfade des PC-Runners je Betriebssystem (nur Nutzerverzeichnisse, keine Administratorrechte nötig):
 *
 * | | Konfiguration | Daten (Repos, Worktrees, Logs) |
 * |---|---|---|
 * | Linux | `$XDG_CONFIG_HOME/atrium-runner` (`~/.config/…`) | `$XDG_DATA_HOME/atrium-runner` (`~/.local/share/…`) |
 * | macOS | `~/Library/Application Support/AtriumRunner` | dito, Logs unter `~/Library/Logs/AtriumRunner` |
 * | Windows | `%APPDATA%\AtriumRunner` | `%LOCALAPPDATA%\AtriumRunner` |
 */
import os from 'node:os';
import path from 'node:path';

export interface DesktopPaths {
	configDir: string;
	configFile: string;
	dataDir: string;
	workDir: string;
	logDir: string;
}

export function desktopPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir()
): DesktopPaths {
	const p = platform === 'win32' ? path.win32 : path.posix;
	let configDir: string;
	let dataDir: string;
	let logDir: string;
	if (platform === 'win32') {
		configDir = p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'AtriumRunner');
		dataDir = p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'AtriumRunner');
		logDir = p.join(dataDir, 'logs');
	} else if (platform === 'darwin') {
		configDir = p.join(home, 'Library', 'Application Support', 'AtriumRunner');
		dataDir = configDir;
		logDir = p.join(home, 'Library', 'Logs', 'AtriumRunner');
	} else {
		configDir = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'atrium-runner');
		dataDir = p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'atrium-runner');
		logDir = p.join(dataDir, 'logs');
	}
	return {
		configDir,
		configFile: p.join(configDir, 'runner.config.json'),
		dataDir,
		workDir: p.join(dataDir, 'work'),
		logDir
	};
}
