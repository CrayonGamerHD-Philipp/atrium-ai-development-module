/**
 * Einstieg des Runners (`node dist/main.js`).
 *
 *   start (Standard)     Runner starten (Vordergrund)
 *   probe                Konfiguration, Programme (git, gh, Agent-CLIs) und Konten prüfen und beenden
 *   login <konto>        Anmelde-Befehl der CLI mit der Umgebung des Kontos starten (HOME/Config-Verzeichnis)
 *   install, uninstall, stop, restart, status, handover, pause, resume, init   PC-Betrieb (siehe desktop/cli.ts)
 *   --config <datei>     Konfigurationsdatei (sonst RUNNER_CONFIG bzw. ./runner.config.json)
 *   --help, --version
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { accountEnv, collectSecrets, ConfigError, defaultCommand, loadConfig, type RunnerConfig } from './config.ts';
import { createLogger, setLogRedactor } from './log.ts';
import { defaultAdapters } from './providers/index.ts';
import { Redactor } from './redact.ts';
import { DESKTOP_COMMANDS, runDesktopCommand } from './desktop/cli.ts';
import { desktopPaths } from './desktop/paths.ts';
import { isolationHint, personalDataFindings } from './desktop/isolation.ts';
import { checkTools } from './desktop/tools.ts';
import { probeAccounts, Runner } from './runner.ts';
import { RUNNER_VERSION } from './version.ts';

const HELP = `Atrium aidev-Runner ${RUNNER_VERSION}

Verwendung: atrium-aidev-runner [befehl] [--config <datei>]

Befehle:
  start            Runner im Vordergrund starten (Standard)
  probe            Konfiguration, Programme (git, gh, Agent-CLIs) und Konten prüfen, dann beenden
  login <konto>    Anmeldung der CLI für ein Konto starten (claude auth login, codex login, gemini)
  help             Diese Hilfe

PC-Betrieb (Autostart im eigenen Benutzerkonto, ohne Administratorrechte):
  init             Konfigurationsvorlage anlegen (überschreibt nichts)
  install          Vorlage anlegen, Autostart einrichten und starten (--no-start: nur einrichten)
  uninstall        Autostart entfernen (--purge: auch Konfiguration und Arbeitsverzeichnis löschen)
  service-start    Über den Autostart starten
  stop             Geordnet beenden (laufende Läufe werden an einen Server-Runner übergeben)
  restart          Neu starten
  status           Zustand anzeigen (Autostart, Prozess, Atrium, Übergabe, letzte Rückmeldung)
  handover         Laufende Läufe jetzt an einen Server-Runner übergeben
  pause / resume   Pausieren (übergeben, keine neuen Aufträge) bzw. fortsetzen

  Standard-Konfiguration: ${desktopPaths().configFile}

Umgebungsvariablen (Vorrang vor der Konfigurationsdatei):
  ATRIUM_URL          Adresse von Atrium, z. B. https://atrium.example.org   (Pflicht)
  ATRIUM_API_KEY      API-Key eines technischen Benutzers mit aidev.runner.connect (Pflicht)
  RUNNER_NAME         Anzeigename (Standard: Rechnername)
  RUNNER_CONFIG       Konfigurationsdatei (Standard: ./runner.config.json)
  WORK_DIR            Arbeitsverzeichnis für Repos/Worktrees (Standard: ./.work)
  MAX_SLOTS           Gleichzeitige Läufe (Standard: 2)
  DRAIN_SEC           Beim Beenden so lange auf laufende Läufe warten (Standard: 0 = sofort abbrechen)
  RUNNER_KIND         server (Standard) | desktop (PC: Vorrang, Übergabe vor Standby/Herunterfahren)
  HANDOVER_SEC        Zeitbudget einer Übergabe in Sekunden (Standard: 20; das Betriebssystem begrenzt ggf.)
  WIP_CHECKPOINT_MIN  Zwischenstände laufender Läufe alle n Minuten sichern (Standard: desktop 10, sonst 0)
  POWER_EVENTS        Standby/Herunterfahren beobachten (Standard: an für desktop)
  RUNNER_ACCOUNTS     Konten als JSON-Liste (statt "accounts" in der Datei)
  GIT_AUTHOR_NAME     Commit-Autor (Standard: Atrium Agent)
  GIT_AUTHOR_EMAIL    Commit-E-Mail (Standard: agent@atrium.local)
  GIT_REMOTE_TEMPLATE Remote-URL-Vorlage (Standard: https://github.com/{owner}/{repo}.git)
  GH_TOKEN            GitHub-Token für gh/git (alternativ: gh auth login)
  LOG_LEVEL           debug | info | warn | error
`;

interface Args {
	command: string;
	rest: string[];
	configPath?: string;
}

function parseArgs(argv: string[]): Args {
	const rest: string[] = [];
	let configPath: string | undefined;
	let command = '';
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? '';
		if (a === '--help' || a === '-h') command = 'help';
		else if (a === '--version' || a === '-v') command = command || 'version';
		else if (a === '--config' || a === '-c') configPath = argv[++i];
		else if (a.startsWith('--config=')) configPath = a.slice(9);
		else if (!command) command = a;
		else rest.push(a);
	}
	return { command: command || 'start', rest, configPath };
}

/**
 * Konfigurationsdatei: `--config`, `RUNNER_CONFIG`, `./runner.config.json` – fehlt alles, die
 * Standard-Konfiguration des PC-Runners (falls vorhanden).
 */
function configPathOf(args: Args): string | undefined {
	if (args.configPath || process.env.RUNNER_CONFIG) return args.configPath;
	if (existsSync(path.resolve('runner.config.json'))) return undefined;
	const desktop = desktopPaths().configFile;
	return existsSync(desktop) ? desktop : undefined;
}

function load(args: Args): RunnerConfig {
	try {
		return loadConfig({ configPath: configPathOf(args) });
	} catch (e) {
		if (e instanceof ConfigError) {
			process.stderr.write(`${e.message}\n\nHilfe: atrium-aidev-runner --help\n`);
			process.exit(2);
		}
		throw e;
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === 'help') {
		process.stdout.write(HELP);
		return;
	}
	if (args.command === 'version') {
		process.stdout.write(`${RUNNER_VERSION}\n`);
		return;
	}
	if (DESKTOP_COMMANDS.includes(args.command)) {
		process.exitCode = await runDesktopCommand(args.command, args.rest, args.configPath);
		return;
	}
	if (!['start', 'probe', 'login'].includes(args.command)) {
		process.stderr.write(`Unbekannter Befehl „${args.command}“\n\n${HELP}`);
		process.exit(2);
	}
	const config = load(args);
	const redactor = new Redactor(collectSecrets(config));
	setLogRedactor(redactor);
	const log = createLogger('runner');

	if (args.command === 'probe') {
		log.info(`Atrium-Runner ${RUNNER_VERSION} (${config.kind === 'desktop' ? 'PC-Runner' : 'Server-Runner'}, ${process.platform}-${process.arch})`);
		const tools = await checkTools(config.accounts);
		for (const t of tools) {
			if (t.ok) log.info(`Programm ${t.name}: vorhanden (${t.version})`);
			else log[t.required ? 'error' : 'warn'](`Programm ${t.name} fehlt${t.hint ? ` – Installation: ${t.hint}` : ''}`);
		}
		const hint = config.kind === 'desktop' ? isolationHint(personalDataFindings()) : null;
		if (hint) log.warn(hint);
		const res = await probeAccounts(config, defaultAdapters, log);
		const ok = [...res.values()].every((a) => a.ok && a.loggedIn) && tools.every((t) => t.ok || !t.required);
		process.exitCode = ok ? 0 : 1;
		return;
	}

	if (args.command === 'login') {
		const key = args.rest[0];
		const acct = config.accounts.find((a) => a.key === key);
		if (!acct) {
			process.stderr.write(`Konto „${key ?? ''}“ nicht in der Konfiguration\n`);
			process.exit(2);
		}
		const cmd = acct.command ?? defaultCommand(acct.provider);
		const loginArgs =
			acct.provider === 'claude'
				? ['auth', 'login']
				: acct.provider === 'codex'
					? ['login', '--device-auth']
					: acct.provider === 'gemini'
						? []
						: null;
		if (!loginArgs) {
			process.stderr.write(`Für ${acct.provider} ist keine Anmeldung nötig (API-Key über Umgebungsvariable)\n`);
			return;
		}
		process.stderr.write(`Starte: ${cmd} ${loginArgs.join(' ')}${acct.home ? ` (HOME=${acct.home})` : ''}\n`);
		const r = spawnSync(cmd, loginArgs, {
			stdio: 'inherit',
			env: accountEnv(acct),
			shell: process.platform === 'win32'
		});
		process.exitCode = r.status ?? 1;
		return;
	}

	log.info(`Atrium aidev-Runner ${RUNNER_VERSION} startet (${config.name}, ${config.maxSlots} Slots, ${config.workDir})`);
	if (config.kind === 'desktop' && process.platform !== 'win32' && process.getuid?.() === 0 && process.env.ALLOW_ROOT !== '1') {
		log.error('Der PC-Runner darf nicht als root laufen (Agents hätten volle Rechte). Bitte als normaler Benutzer starten.');
		process.exit(2);
	}
	if (config.kind === 'desktop') {
		const hint = isolationHint(personalDataFindings());
		if (hint) log.warn(hint);
	}
	let stopRequested: (() => void) | null = null;
	const runner = new Runner({ config, redactor, log, onStopRequest: () => stopRequested?.() });
	// 1. Signal: geordnet beenden (mit DRAIN_SEC: laufende Läufe dürfen fertig werden),
	// 2. Signal: Frist abbrechen, laufende Läufe abbrechen und neu einplanen lassen, 3. Signal: sofortiges Ende
	let signals = 0;
	const skipDrain = new AbortController();
	const onSignal = (sig: NodeJS.Signals) => {
		signals++;
		if (signals > 2 || (signals === 2 && !(config.drainSec ?? 0))) {
			log.warn(`${sig} erneut – sofortiges Ende`);
			process.exit(130);
		}
		if (signals === 2) {
			log.warn(`${sig} erneut – Wartefrist abgebrochen, laufende Läufe werden abgebrochen`);
			skipDrain.abort();
			return;
		}
		log.info(`${sig} empfangen`);
		void runner.shutdown({ skipDrain: skipDrain.signal }).then(() => {
			log.info('Beendet');
			process.exit(0);
		});
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);
	// Windows: Konsole geschlossen bzw. Strg+Untbr
	if (process.platform === 'win32') {
		process.on('SIGHUP', onSignal);
		process.on('SIGBREAK', onSignal);
	}
	stopRequested = () => onSignal('SIGTERM');
	process.on('unhandledRejection', (e) => log.error('Unbehandelter Fehler', e instanceof Error ? e.message : String(e)));
	await runner.start();
}

main().catch((e: unknown) => {
	process.stderr.write(`Fataler Fehler: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
	process.exit(1);
});
