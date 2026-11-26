/**
 * Befehle für den PC-Betrieb: `install`, `uninstall`, `service-start` (`start --service`), `stop`, `status`,
 * `handover`, `pause`, `resume`, `init`. Die eigentliche Ausführung bleibt `start` (Vordergrund, wie im Docker-Image).
 */
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { controlDir, stateFile, type RunnerStateFile } from '../runner.ts';
import { RUNNER_VERSION } from '../version.ts';
import { isolationHint, personalDataFindings } from './isolation.ts';
import { desktopPaths } from './paths.ts';
import { serviceManager, ServiceError, type ServiceSpec } from './service.ts';
import { desktopConfigTemplate } from './template.ts';

export interface CliIo {
	out(s: string): void;
	err(s: string): void;
}

const stdio: CliIo = {
	out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
	err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`)
};

/** Läuft der Runner als Einzel-Binary (Node SEA)? */
export async function isSingleExecutable(): Promise<boolean> {
	try {
		const sea = (await import('node:sea')) as { isSea?: () => boolean };
		return sea.isSea?.() === true;
	} catch {
		return false;
	}
}

/** Programm und Argumente für den Autostart (Einzel-Binary oder `node <main.js>`) */
export async function selfCommand(): Promise<{ exe: string; baseArgs: string[] }> {
	if (await isSingleExecutable()) return { exe: process.execPath, baseArgs: [] };
	const script = process.argv[1] ? path.resolve(process.argv[1]) : '';
	return { exe: process.execPath, baseArgs: script ? [script] : [] };
}

/** Konfigurationsdatei: `--config`, `RUNNER_CONFIG`, sonst Standardpfad des PC-Runners */
export function desktopConfigPath(explicit?: string): string {
	return path.resolve(explicit ?? process.env.RUNNER_CONFIG ?? desktopPaths().configFile);
}

/** Arbeitsverzeichnis aus der Konfigurationsdatei (ohne Prüfung der übrigen Werte) */
export function workDirOf(configFile: string): string {
	try {
		const raw = JSON.parse(readFileSync(configFile, 'utf8')) as { workDir?: string };
		if (raw.workDir) return path.resolve(path.dirname(configFile), raw.workDir);
	} catch {
		// keine oder ungültige Datei
	}
	return path.resolve(process.env.WORK_DIR ?? desktopPaths().workDir);
}

/** Konfigurationsvorlage anlegen (nie überschreiben); Rechte 0600 */
export async function initConfig(configFile: string, io: CliIo = stdio): Promise<boolean> {
	if (existsSync(configFile)) {
		io.out(`Konfiguration vorhanden: ${configFile}`);
		return false;
	}
	const paths = desktopPaths();
	await mkdir(path.dirname(configFile), { recursive: true });
	await writeFile(
		configFile,
		desktopConfigTemplate({ name: `${os.hostname().slice(0, 60) || 'pc'}-pc`, workDir: paths.workDir }),
		{ mode: 0o600 }
	);
	if (process.platform !== 'win32') await chmod(configFile, 0o600).catch(() => undefined);
	io.out(`Konfigurationsvorlage angelegt: ${configFile}`);
	io.out('  → atriumUrl und apiKey eintragen, Konten anpassen, dann: atrium-runner probe');
	return true;
}

async function writeControl(workDir: string, name: 'handover' | 'pause' | 'stop'): Promise<void> {
	const dir = controlDir(workDir);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, name), new Date().toISOString());
}

export async function readState(workDir: string): Promise<RunnerStateFile | null> {
	try {
		return JSON.parse(await readFile(stateFile(workDir), 'utf8')) as RunnerStateFile;
	} catch {
		return null;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Geordnet stoppen: Steuerdatei `stop`, bis zu `timeoutMs` auf das Ende warten */
async function stopViaControl(workDir: string, timeoutMs: number): Promise<boolean> {
	const state = await readState(workDir);
	if (!state || !alive(state.pid)) return true;
	await writeControl(workDir, 'stop');
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (!alive(state.pid)) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return !alive(state.pid);
}

export async function runDesktopCommand(
	command: string,
	rest: string[],
	configPath: string | undefined,
	io: CliIo = stdio
): Promise<number> {
	const configFile = desktopConfigPath(configPath);
	const paths = desktopPaths();
	const workDir = workDirOf(configFile);
	const svc = () => serviceManager({ dataDir: paths.dataDir });
	try {
		switch (command) {
			case 'init':
				await initConfig(configFile, io);
				return 0;
			case 'install': {
				if (process.platform !== 'win32' && process.getuid?.() === 0) {
					io.err('Bitte nicht als root installieren – der PC-Runner läuft im eigenen Benutzerkonto.');
					return 2;
				}
				await initConfig(configFile, io);
				const self = await selfCommand();
				const spec: ServiceSpec = {
					...self,
					configFile,
					workDir,
					logDir: paths.logDir,
					pathEnv: process.env.PATH ?? ''
				};
				await mkdir(workDir, { recursive: true });
				const m = svc();
				await m.install(spec);
				io.out(`Autostart eingerichtet (${m.name}): ${m.location}`);
				const hint = isolationHint(personalDataFindings());
				if (hint) io.out(`
Hinweis: ${hint}
`);
				if (!rest.includes('--no-start')) {
					await m.start();
					io.out('Runner gestartet. Freigabe in Atrium: Administration → Runner & Konten');
				}
				return 0;
			}
			case 'uninstall': {
				const m = svc();
				await stopViaControl(workDir, 30_000);
				await m.uninstall();
				io.out(`Autostart entfernt (${m.name})`);
				if (rest.includes('--purge')) {
					await rm(workDir, { recursive: true, force: true });
					await rm(configFile, { force: true });
					io.out(`Arbeitsverzeichnis und Konfiguration gelöscht (${workDir}, ${configFile})`);
				} else {
					io.out(`Konfiguration und Arbeitsverzeichnis bleiben erhalten (${configFile}, ${workDir}); löschen mit --purge`);
				}
				return 0;
			}
			case 'service-start':
				await svc().start();
				io.out('Runner gestartet');
				return 0;
			case 'stop': {
				// geordnet (Übergabe laufender Läufe), danach Dienst anhalten
				const ok = await stopViaControl(workDir, 45_000);
				await svc().stop().catch(() => undefined);
				io.out(ok ? 'Runner beendet' : 'Runner reagiert nicht – Dienst wurde angehalten');
				return ok ? 0 : 1;
			}
			case 'restart':
				await stopViaControl(workDir, 45_000);
				await svc().stop().catch(() => undefined);
				await svc().start();
				io.out('Runner neu gestartet');
				return 0;
			case 'status': {
				const st = await svc().status().catch((e: unknown) => ({ installed: false, running: false, detail: String(e) }));
				const state = await readState(workDir);
				const running = !!state && alive(state.pid);
				io.out(`Atrium-Runner ${RUNNER_VERSION}`);
				io.out(`  Autostart:   ${st.installed ? 'eingerichtet' : 'nicht eingerichtet'} (${st.detail})`);
				io.out(`  Prozess:     ${running ? `läuft (PID ${state!.pid}, Version ${state!.version})` : 'läuft nicht'}`);
				if (state && running) {
					io.out(`  Atrium:      ${state.status}${state.runnerId ? ` (Runner ${state.runnerId})` : ''}`);
					io.out(`  Art:         ${state.kind === 'desktop' ? 'PC-Runner' : 'Server-Runner'}`);
					io.out(`  Übergabe:    ${state.paused ? `aktiv (${state.paused})` : '–'}`);
					io.out(`  Läufe:       ${state.runs.length}`);
					io.out(`  Heartbeat:   ${state.lastHeartbeatAt ?? 'noch keiner'}`);
					io.out(`  Energie:     ${state.power}`);
				}
				io.out(`  Konfiguration: ${configFile}`);
				io.out(`  Arbeitsverz.:  ${workDir}`);
				io.out(`  Logs:          ${paths.logDir}`);
				return running ? 0 : 3;
			}
			case 'handover':
			case 'pause':
				await writeControl(workDir, command);
				io.out(
					command === 'handover'
						? 'Übergabe angestoßen: laufende Läufe gehen an einen Server-Runner'
						: 'Pausiert: laufende Läufe werden übergeben, keine neuen Aufträge (fortsetzen: atrium-runner resume)'
				);
				return 0;
			case 'resume':
				await rm(path.join(controlDir(workDir), 'pause'), { force: true });
				io.out('Pause beendet');
				return 0;
		}
	} catch (e) {
		io.err(e instanceof ServiceError ? e.message : e instanceof Error ? e.message : String(e));
		return 1;
	}
	io.err(`Unbekannter Befehl „${command}“`);
	return 2;
}

export const DESKTOP_COMMANDS = ['init', 'install', 'uninstall', 'service-start', 'stop', 'restart', 'status', 'handover', 'pause', 'resume'];
