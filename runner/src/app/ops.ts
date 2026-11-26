/**
 * Steuerlogik der PC-Oberfläche (`AppOps`): Zustand lesen, Runner starten/stoppen/pausieren/übergeben, Autostart,
 * Konfiguration lesen/speichern (API-Key maskiert), Protokoll, Prüfung (`probe`), CLI-Anmeldung im Terminal.
 *
 * Gesteuert wird wie bei den Befehlen auf der Kommandozeile: über die Steuerdateien im Arbeitsverzeichnis und den
 * Autostart (`runDesktopCommand`). Die Oberfläche ist ein eigener Prozess – schließt man sie, läuft der Runner weiter.
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config.ts';
import {
	alive,
	readState,
	runDesktopCommand,
	selfCommand,
	workDirOf,
	type CliIo
} from '../desktop/cli.ts';
import { personalDataFindings, type IsolationFinding } from '../desktop/isolation.ts';
import type { DesktopPaths } from '../desktop/paths.ts';
import { serviceManager, type ServiceManager } from '../desktop/service.ts';
import type { RunnerStateFile } from '../runner.ts';
import { RUNNER_VERSION } from '../version.ts';
import { openFolder, openLoginTerminal } from './desktop-open.ts';
import type { ActionResult, AppAction, AppOps } from './server.ts';

/** Platzhalter für den API-Key in der angezeigten Konfiguration */
export const API_KEY_MASK = '********';
/** Werte der Vorlage, die noch ersetzt werden müssen */
const PLACEHOLDER_URL = /example\.(org|com)/i;
const PLACEHOLDER_KEY = 'API-KEY-EINTRAGEN';
/** So viel vom Ende des Protokolls beim ersten Abruf */
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // eslint-disable-line no-control-regex

/** `"apiKey": "…"` (ein JSON-String ohne Escapes) – Gruppen: Präfix, Wert, Suffix */
const API_KEY_RE = /("apiKey"\s*:\s*")((?:[^"\\]|\\.)*)(")/;

export interface AppState {
	version: string;
	platform: string;
	process: { running: boolean; pid: number | null };
	runner: RunnerStateFile | null;
	autostart: { installed: boolean; detail: string; name: string; error: string | null };
	config: {
		path: string;
		exists: boolean;
		ok: boolean;
		complete: boolean;
		error: string | null;
		atriumUrl: string;
		name: string;
		kind: string;
		maxSlots: number | null;
		accounts: { key: string; provider: string; label: string }[];
	};
	paths: { config: string; work: string; logs: string };
	isolation: IsolationFinding[];
	busy: string | null;
}

/** API-Key in der Konfiguration verdecken (Formatierung bleibt) */
export function maskApiKey(text: string): string {
	return text.replace(API_KEY_RE, (m, a: string, v: string, c: string) =>
		v && v !== PLACEHOLDER_KEY ? `${a}${API_KEY_MASK}${c}` : m
	);
}

/** Beim Speichern: unveränderter Platzhalter → bisheriger API-Key */
export function unmaskApiKey(next: string, previous: string): string {
	const prev = API_KEY_RE.exec(previous)?.[2];
	return next.replace(API_KEY_RE, (m, a: string, v: string, c: string) =>
		v === API_KEY_MASK && prev !== undefined ? `${a}${prev}${c}` : m
	);
}

export interface OpsOptions {
	configFile: string;
	paths: DesktopPaths;
	platform?: NodeJS.Platform;
	/** Autostart (Tests: Fake) */
	service?: ServiceManager;
	/** Befehle wie auf der Kommandozeile (Tests: Fake) */
	command?: (command: string, rest: string[], io: CliIo) => Promise<number>;
	/** Runner ohne Autostart im Hintergrund starten (Tests: Fake) */
	spawnRunner?: () => Promise<void>;
	onQuit(): void;
}

export class RunnerOps implements AppOps {
	private busy: string | null = null;
	private readonly platform: NodeJS.Platform;

	constructor(private readonly o: OpsOptions) {
		this.platform = o.platform ?? process.platform;
	}

	private get workDir(): string {
		return workDirOf(this.o.configFile);
	}

	private get logFile(): string {
		return path.join(this.o.paths.logDir, 'runner.log');
	}

	private svc(): ServiceManager {
		return this.o.service ?? serviceManager({ dataDir: this.o.paths.dataDir });
	}

	private async command(command: string, rest: string[] = []): Promise<ActionResult> {
		const lines: string[] = [];
		const io: CliIo = { out: (s) => lines.push(s.trim()), err: (s) => lines.push(s.trim()) };
		const run = this.o.command ?? ((c, r, i) => runDesktopCommand(c, r, this.o.configFile, i));
		const code = await run(command, rest, io);
		return { ok: code === 0, message: lines.filter(Boolean).join('\n') || (code === 0 ? 'Erledigt' : `Fehler (${code})`) };
	}

	private async processState(): Promise<{ state: RunnerStateFile | null; running: boolean }> {
		const state = await readState(this.workDir);
		return { state, running: !!state && alive(state.pid) };
	}

	async state(): Promise<AppState> {
		const { state, running } = await this.processState();
		const svc = this.svc();
		const autostart = await svc
			.status()
			.then((s) => ({ installed: s.installed, detail: s.detail, name: svc.name, error: null }))
			.catch((e: unknown) => ({ installed: false, detail: '', name: svc.name, error: String((e as Error).message ?? e) }));
		return {
			version: RUNNER_VERSION,
			platform: `${this.platform}-${process.arch}`,
			process: { running, pid: running ? state!.pid : null },
			runner: running ? state : null,
			autostart,
			config: await this.configSummary(),
			paths: { config: this.o.configFile, work: this.workDir, logs: this.o.paths.logDir },
			isolation: personalDataFindings(),
			busy: this.busy
		};
	}

	private async configSummary(): Promise<AppState['config']> {
		const base: AppState['config'] = {
			path: this.o.configFile,
			exists: existsSync(this.o.configFile),
			ok: false,
			complete: false,
			error: null,
			atriumUrl: '',
			name: '',
			kind: 'desktop',
			maxSlots: null,
			accounts: []
		};
		if (!base.exists) return { ...base, error: 'Noch keine Konfiguration – „Starten“ legt eine Vorlage an.' };
		try {
			const c = loadConfig({ configPath: this.o.configFile, env: { RUNNER_KIND: 'desktop' } });
			const complete = !PLACEHOLDER_URL.test(c.atriumUrl) && c.apiKey !== PLACEHOLDER_KEY;
			return {
				...base,
				ok: true,
				complete,
				error: complete ? null : 'Atrium-Adresse und API-Key der Vorlage noch ersetzen (Reiter „Konfiguration“).',
				atriumUrl: c.atriumUrl,
				name: c.name,
				kind: c.kind ?? 'desktop',
				maxSlots: c.maxSlots,
				accounts: c.accounts.map((a) => ({ key: a.key, provider: a.provider, label: a.label ?? '' }))
			};
		} catch (e) {
			const msg = e instanceof ConfigError ? e.message : String((e as Error).message ?? e);
			const placeholder = /API-KEY-EINTRAGEN|example\.org/.test(await readFile(this.o.configFile, 'utf8').catch(() => ''));
			return { ...base, complete: !placeholder, error: msg };
		}
	}

	async action(name: AppAction): Promise<ActionResult> {
		if (this.busy) return { ok: false, message: `Bitte warten: ${this.busy}` };
		const labels: Record<AppAction, string> = {
			start: 'Runner wird gestartet',
			stop: 'Runner wird beendet (laufende Aufträge werden übergeben)',
			restart: 'Runner wird neu gestartet',
			pause: 'Wird pausiert',
			resume: 'Wird fortgesetzt',
			handover: 'Laufende Aufträge werden übergeben',
			'autostart-on': 'Autostart wird eingerichtet',
			'autostart-off': 'Autostart wird entfernt'
		};
		this.busy = labels[name];
		try {
			return await this.doAction(name);
		} catch (e) {
			return { ok: false, message: String((e as Error).message ?? e) };
		} finally {
			this.busy = null;
		}
	}

	private async doAction(name: AppAction): Promise<ActionResult> {
		switch (name) {
			case 'pause':
			case 'resume':
			case 'handover':
				if (!(await this.processState()).running) return { ok: false, message: 'Der Runner läuft nicht' };
				return this.command(name);
			case 'stop':
				return this.command('stop');
			case 'start': {
				if ((await this.processState()).running) return { ok: true, message: 'Der Runner läuft bereits' };
				const cfg = await this.configSummary();
				if (!cfg.exists) {
					await this.command('init');
					return { ok: false, message: 'Konfigurationsvorlage angelegt – Atrium-Adresse und API-Key eintragen, dann starten.' };
				}
				if (!cfg.ok || !cfg.complete) return { ok: false, message: cfg.error ?? 'Konfiguration unvollständig' };
				return this.startRunner();
			}
			case 'restart': {
				if ((await this.processState()).running) {
					const stopped = await this.command('stop');
					if (!stopped.ok) return stopped;
				}
				return this.startRunner();
			}
			case 'autostart-on':
				return this.command('install', ['--no-start']);
			case 'autostart-off': {
				await this.svc().uninstall();
				const running = (await this.processState()).running;
				return {
					ok: true,
					message: running ? 'Autostart entfernt – der Runner läuft bis zum Beenden weiter' : 'Autostart entfernt'
				};
			}
		}
	}

	/** Über den Autostart starten; ohne Autostart als Hintergrundprozess (Protokoll in `runner.log`) */
	private async startRunner(): Promise<ActionResult> {
		const st = await this.svc().status().catch(() => ({ installed: false }));
		if (st.installed) {
			const r = await this.command('service-start');
			if (r.ok) return this.waitStarted('Runner gestartet');
		}
		await (this.o.spawnRunner ?? (() => this.spawnDetached()))();
		return this.waitStarted('Runner gestartet (ohne Autostart)');
	}

	private async waitStarted(message: string): Promise<ActionResult> {
		for (let i = 0; i < 40; i++) {
			if ((await this.processState()).running) return { ok: true, message };
			await new Promise((r) => setTimeout(r, 250));
		}
		return { ok: false, message: 'Der Runner ist nicht gestartet – siehe Protokoll' };
	}

	private async spawnDetached(): Promise<void> {
		const self = await selfCommand();
		await mkdir(this.o.paths.logDir, { recursive: true });
		const fd = openSync(this.logFile, 'a');
		try {
			const child = spawn(self.exe, [...self.baseArgs, 'start', '--config', this.o.configFile], {
				detached: true,
				stdio: ['ignore', fd, fd],
				windowsHide: true,
				env: { ...process.env, RUNNER_KIND: 'desktop' }
			});
			child.unref();
		} finally {
			closeSync(fd);
		}
	}

	async logs(offset: number): Promise<{ offset: number; text: string; reset: boolean }> {
		let size: number;
		try {
			size = (await stat(this.logFile)).size;
		} catch {
			return { offset: 0, text: offset < 0 ? `Noch kein Protokoll (${this.logFile})\n` : '', reset: offset < 0 };
		}
		let reset = false;
		let from = offset;
		if (from < 0 || from > size) {
			reset = true;
			from = Math.max(0, size - LOG_TAIL_BYTES);
		}
		const len = Math.min(size - from, LOG_CHUNK_BYTES);
		if (len <= 0) return { offset: from, text: '', reset };
		const fh = await open(this.logFile, 'r');
		try {
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, from);
			let text = buf.toString('utf8');
			// erster Abruf mitten in einer Zeile: angefangene Zeile weglassen
			if (reset && from > 0) text = text.slice(text.indexOf('\n') + 1);
			return { offset: from + len, text: text.replace(ANSI, ''), reset };
		} finally {
			await fh.close();
		}
	}

	async readConfig(): Promise<{ path: string; exists: boolean; text: string }> {
		const exists = existsSync(this.o.configFile);
		const text = exists ? await readFile(this.o.configFile, 'utf8') : '';
		return { path: this.o.configFile, exists, text: maskApiKey(text) };
	}

	async writeConfig(text: string): Promise<ActionResult> {
		const previous = existsSync(this.o.configFile) ? await readFile(this.o.configFile, 'utf8') : '';
		const next = unmaskApiKey(text, previous);
		try {
			JSON.parse(next);
		} catch (e) {
			return { ok: false, message: `Kein gültiges JSON: ${(e as Error).message}` };
		}
		await mkdir(path.dirname(this.o.configFile), { recursive: true });
		const tmp = `${this.o.configFile}.${process.pid}.tmp`;
		await writeFile(tmp, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
		try {
			// gleiche Prüfung wie beim Start (relative Pfade gelten relativ zur Datei – gleiches Verzeichnis)
			loadConfig({ configPath: tmp, env: { RUNNER_KIND: 'desktop' } });
		} catch (e) {
			await rm(tmp, { force: true });
			return { ok: false, message: e instanceof ConfigError ? e.message : String((e as Error).message ?? e) };
		}
		await rename(tmp, this.o.configFile);
		if (this.platform !== 'win32') await chmod(this.o.configFile, 0o600).catch(() => undefined);
		const running = (await this.processState()).running;
		return { ok: true, message: running ? 'Gespeichert – gilt nach einem Neustart des Runners' : 'Gespeichert' };
	}

	async probe(): Promise<{ ok: boolean; output: string }> {
		const self = await selfCommand();
		return new Promise((resolve) => {
			const child = spawn(self.exe, [...self.baseArgs, 'probe', '--config', this.o.configFile], {
				windowsHide: true,
				env: { ...process.env, RUNNER_KIND: 'desktop' }
			});
			let out = '';
			const add = (b: Buffer) => {
				if (out.length < 200_000) out += b.toString('utf8');
			};
			child.stdout?.on('data', add);
			child.stderr?.on('data', add);
			const timer = setTimeout(() => child.kill(), 120_000);
			child.once('error', (e) => {
				clearTimeout(timer);
				resolve({ ok: false, output: e.message });
			});
			child.once('close', (code) => {
				clearTimeout(timer);
				resolve({ ok: code === 0, output: out.replace(ANSI, '').trim() });
			});
		});
	}

	async login(accountKey: string): Promise<ActionResult> {
		const cfg = await this.configSummary();
		const acct = cfg.accounts.find((a) => a.key === accountKey);
		if (!acct) return { ok: false, message: `Konto „${accountKey}“ steht nicht in der Konfiguration` };
		const ok = await openLoginTerminal(await selfCommand(), acct.key, this.o.configFile);
		return ok
			? { ok: true, message: 'Anmeldung im Terminal geöffnet – danach „Jetzt prüfen“ bzw. den Runner neu starten' }
			: { ok: false, message: `Kein Terminal gefunden – manuell: atrium-runner login ${acct.key}` };
	}

	async openPath(which: 'config' | 'logs' | 'work'): Promise<ActionResult> {
		const dir = which === 'config' ? path.dirname(this.o.configFile) : which === 'logs' ? this.o.paths.logDir : this.workDir;
		await mkdir(dir, { recursive: true });
		const ok = await openFolder(dir);
		return { ok, message: ok ? dir : `Ordner: ${dir}` };
	}

	quit(): void {
		this.o.onQuit();
	}
}
