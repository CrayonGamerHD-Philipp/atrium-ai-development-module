/**
 * Einstieg des Runners (`node dist/main.js`).
 *
 *   start (Standard)     Runner starten
 *   probe                Konfiguration und Konten prüfen (CLI vorhanden, angemeldet) und beenden
 *   login <konto>        Anmelde-Befehl der CLI mit der Umgebung des Kontos starten (HOME/Config-Verzeichnis)
 *   --config <datei>     Konfigurationsdatei (sonst RUNNER_CONFIG bzw. ./runner.config.json)
 *   --help, --version
 */
import { spawnSync } from 'node:child_process';
import { accountEnv, collectSecrets, ConfigError, defaultCommand, loadConfig, type RunnerConfig } from './config.ts';
import { createLogger, setLogRedactor } from './log.ts';
import { defaultAdapters } from './providers/index.ts';
import { Redactor } from './redact.ts';
import { probeAccounts, Runner } from './runner.ts';
import { RUNNER_VERSION } from './version.ts';

const HELP = `Atrium aidev-Runner ${RUNNER_VERSION}

Verwendung: atrium-aidev-runner [befehl] [--config <datei>]

Befehle:
  start            Runner starten (Standard)
  probe            Konfiguration und Konten prüfen, dann beenden
  login <konto>    Anmeldung der CLI für ein Konto starten (claude auth login, codex login, gemini)
  help             Diese Hilfe

Umgebungsvariablen (Vorrang vor der Konfigurationsdatei):
  ATRIUM_URL          Adresse von Atrium, z. B. https://atrium.example.org   (Pflicht)
  ATRIUM_API_KEY      API-Key eines technischen Benutzers mit aidev.runner.connect (Pflicht)
  RUNNER_NAME         Anzeigename (Standard: Rechnername)
  RUNNER_CONFIG       Konfigurationsdatei (Standard: ./runner.config.json)
  WORK_DIR            Arbeitsverzeichnis für Repos/Worktrees (Standard: ./.work)
  MAX_SLOTS           Gleichzeitige Läufe (Standard: 2)
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

function load(args: Args): RunnerConfig {
	try {
		return loadConfig({ configPath: args.configPath });
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
	if (!['start', 'probe', 'login'].includes(args.command)) {
		process.stderr.write(`Unbekannter Befehl „${args.command}“\n\n${HELP}`);
		process.exit(2);
	}
	const config = load(args);
	const redactor = new Redactor(collectSecrets(config));
	setLogRedactor(redactor);
	const log = createLogger('runner');

	if (args.command === 'probe') {
		const res = await probeAccounts(config, defaultAdapters, log);
		const ok = [...res.values()].every((a) => a.ok && a.loggedIn);
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
	const runner = new Runner({ config, redactor, log });
	let stopping = false;
	const onSignal = (sig: NodeJS.Signals) => {
		if (stopping) {
			log.warn(`${sig} erneut – sofortiges Ende`);
			process.exit(130);
		}
		stopping = true;
		log.info(`${sig} empfangen`);
		void runner.shutdown().then(() => {
			log.info('Beendet');
			process.exit(0);
		});
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);
	process.on('unhandledRejection', (e) => log.error('Unbehandelter Fehler', e instanceof Error ? e.message : String(e)));
	await runner.start();
}

main().catch((e: unknown) => {
	process.stderr.write(`Fataler Fehler: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
	process.exit(1);
});
