/**
 * Konfiguration des Runners: Umgebungsvariablen plus optionale JSON-Datei (`RUNNER_CONFIG`, Standard
 * `./runner.config.json`). Umgebungsvariablen haben Vorrang vor der Datei. Alles wird mit Zod geprüft.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { providerSchema, runnerAccountSchema, type Provider } from './protocol.ts';

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

const envNameSchema = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'muss ein gültiger Name einer Umgebungsvariable sein');

export const accountConfigSchema = z
	.object({
		key: runnerAccountSchema.shape.key,
		provider: providerSchema,
		label: z.string().max(120).optional(),
		/** Eigenes HOME/Config-Verzeichnis je Konto (setzt HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME) */
		home: z.string().min(1).optional(),
		/** Zusätzliche Umgebungsvariablen für den Agent-Prozess (Werte gelten als geheim) */
		env: z.record(envNameSchema, z.string()).default({}),
		/** Modelle, die Atrium für dieses Konto anbieten darf */
		models: z.array(z.string().min(1).max(120)).max(50).default([]),
		/** Pfad bzw. Name der CLI (Standard je Anbieter: claude, codex, gemini) */
		command: z.string().min(1).optional(),
		/** Nur `openai-api`: Basis-URL der OpenAI-kompatiblen API */
		baseUrl: z.string().url().optional(),
		/** Nur `openai-api`: Name der Umgebungsvariable mit dem API-Key */
		apiKeyEnv: envNameSchema.optional(),
		/** Nur `openai-api`: Standardmodell */
		model: z.string().min(1).max(120).optional(),
		/** Nur `openai-api`: Protokoll der API (Codex 0.164 unterstützt nur noch `responses`) */
		wireApi: z.enum(['responses', 'chat']).default('responses'),
		/** Codex/openai-api: `model_reasoning_effort` (z. B. low, medium, high) */
		reasoningEffort: z
			.string()
			.regex(/^[a-z]+$/)
			.optional(),
		/** Limit-Stand aktiv abfragen (überschreibt `limitProbe` des Runners; derzeit nur Claude mit OAuth-Login) */
		limitProbe: z.boolean().optional()
	})
	.strict()
	.superRefine((a, ctx) => {
		if (a.provider === 'openai-api') {
			if (!a.baseUrl)
				ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'ist für openai-api Pflicht' });
			if (!a.apiKeyEnv)
				ctx.addIssue({ code: 'custom', path: ['apiKeyEnv'], message: 'ist für openai-api Pflicht' });
		}
	});
export type AccountConfig = z.infer<typeof accountConfigSchema>;

const fileSchema = z
	.object({
		atriumUrl: z.string().optional(),
		apiKey: z.string().optional(),
		name: z.string().optional(),
		workDir: z.string().optional(),
		maxSlots: z.number().int().optional(),
		gitRemoteTemplate: z.string().optional(),
		gitAuthorName: z.string().optional(),
		gitAuthorEmail: z.string().optional(),
		limitProbe: z.boolean().optional(),
		limitProbeMin: z.number().optional(),
		drainSec: z.number().int().optional(),
		kind: z.enum(['server', 'desktop']).optional(),
		handoverSec: z.number().int().optional(),
		wipCheckpointMin: z.number().int().optional(),
		powerEvents: z.boolean().optional(),
		autoRepairRounds: z.number().int().optional(),
		research: z.boolean().optional(),
		researchMax: z.number().int().optional(),
		researchAccounts: z.array(z.string()).optional(),
		accounts: z.array(z.unknown()).optional()
	})
	.strict();

export interface RunnerConfig {
	atriumUrl: string;
	apiKey: string;
	name: string;
	workDir: string;
	maxSlots: number;
	/** Vorlage der Remote-URL; `{owner}`/`{repo}` werden ersetzt */
	gitRemoteTemplate: string;
	gitAuthorName: string;
	gitAuthorEmail: string;
	accounts: AccountConfig[];
	/**
	 * Aktive Limit-Abfrage ohne Lauf: `true`/`false` für alle Konten, nicht gesetzt = an für Claude-Konten mit
	 * OAuth-Login, sonst aus. `accounts[].limitProbe` hat Vorrang.
	 */
	limitProbe?: boolean;
	/** Abstand der aktiven Limit-Abfrage in Minuten (Standard 5) */
	limitProbeMin?: number;
	/**
	 * Beim Beenden (SIGTERM/SIGINT) so viele Sekunden auf laufende Läufe warten, bevor sie abgebrochen werden
	 * (Standard 0 = sofort abbrechen und neu einplanen lassen). Während der Frist nimmt der Runner nichts Neues an.
	 */
	drainSec?: number;
	/**
	 * Art des Runners: `server` (Standard, z. B. Docker) oder `desktop` (PC eines Nutzers: Vorrang in Atrium,
	 * Übergabe vor Standby/Herunterfahren, Lease-Prüfung nach dem Aufwachen).
	 */
	kind?: 'server' | 'desktop';
	/** Zeitbudget einer Übergabe in Sekunden (Agents stoppen, WIP pushen, melden; Standard 20) */
	handoverSec?: number;
	/** Abstand der WIP-Checkpoints laufender Läufe in Minuten (0 = aus; Standard: desktop 10, server 0) */
	wipCheckpointMin?: number;
	/** Standby/Herunterfahren des Betriebssystems beobachten (Standard: an für desktop) */
	powerEvents?: boolean;
	/**
	 * Selbstreparatur im selben Lauf (Standard 2): So viele Runden setzt der Runner die Sitzung des Agents fort, um
	 * fehlgeschlagene Tests bzw. Merge-Konflikte zu beheben, bevor der Lauf fehlschlägt. Vorübergehende Fehler des
	 * Agents (Überlastung, Netzwerk) werden zusätzlich bis zu zweimal wiederholt. 0 = aus.
	 */
	autoRepairRounds?: number;
	/** Recherche-Schnittstelle für Agents (Standard an): `.aidev/bin/research.mjs "Frage"` startet eine Recherche */
	research?: boolean;
	/** Höchstzahl an Recherchen je Lauf (Standard 3) */
	researchMax?: number;
	/** Bevorzugte Konten für Recherchen (Schlüssel, in Reihenfolge); leer = anderes freies Konto, sonst dasselbe */
	researchAccounts?: string[];
	/** Pfad der gelesenen Konfigurationsdatei (falls vorhanden) */
	configFile: string | null;
}

const finalSchema = z.object({
	atriumUrl: z
		.string({ message: 'fehlt' })
		.url('muss eine URL sein, z. B. https://atrium.example.org')
		.refine((u) => /^https?:\/\//.test(u), 'muss mit http:// oder https:// beginnen'),
	apiKey: z.string({ message: 'fehlt' }).min(8, 'ist zu kurz'),
	name: z.string().min(1).max(80),
	workDir: z.string().min(1),
	maxSlots: z.number().int().min(0).max(64),
	gitRemoteTemplate: z
		.string()
		.refine(
			(t) => t.includes('{owner}') && t.includes('{repo}'),
			'muss {owner} und {repo} enthalten'
		),
	gitAuthorName: z.string().min(1).max(200),
	gitAuthorEmail: z.string().min(3).max(200),
	limitProbe: z.boolean().optional(),
	limitProbeMin: z.number().int().min(1).max(1440),
	drainSec: z.number().int().min(0).max(86_400),
	kind: z.enum(['server', 'desktop'], { message: 'muss server oder desktop sein' }),
	handoverSec: z.number().int().min(3).max(300),
	wipCheckpointMin: z.number().int().min(0).max(1440),
	powerEvents: z.boolean(),
	autoRepairRounds: z.number().int().min(0).max(10),
	research: z.boolean(),
	researchMax: z.number().int().min(0).max(20),
	researchAccounts: z.array(z.string().min(1).max(64)).max(50),
	accounts: z.array(accountConfigSchema).max(50)
});

const LABELS: Record<string, string> = {
	atriumUrl: 'ATRIUM_URL',
	apiKey: 'ATRIUM_API_KEY',
	name: 'RUNNER_NAME',
	workDir: 'WORK_DIR',
	maxSlots: 'MAX_SLOTS',
	gitRemoteTemplate: 'GIT_REMOTE_TEMPLATE',
	gitAuthorName: 'GIT_AUTHOR_NAME',
	gitAuthorEmail: 'GIT_AUTHOR_EMAIL',
	limitProbe: 'LIMIT_PROBE',
	limitProbeMin: 'LIMIT_PROBE_MIN',
	drainSec: 'DRAIN_SEC',
	kind: 'RUNNER_KIND',
	powerEvents: 'POWER_EVENTS',
	research: 'RESEARCH',
	researchAccounts: 'RESEARCH_ACCOUNTS'
};

/** Schalter aus einer Umgebungsvariable (`1`/`true`/`on` bzw. `0`/`false`/`off`); ungültig → `invalid` */
function envBool(v: string | undefined): boolean | undefined | 'invalid' {
	if (v === undefined || v.trim() === '') return undefined;
	const s = v.trim().toLowerCase();
	if (['1', 'true', 'on', 'yes', 'ja'].includes(s)) return true;
	if (['0', 'false', 'off', 'no', 'nein'].includes(s)) return false;
	return 'invalid';
}

export interface LoadOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** Expliziter Pfad (Kommandozeile `--config`) */
	configPath?: string;
}

export function loadConfig(o: LoadOptions = {}): RunnerConfig {
	const env = o.env ?? process.env;
	const cwd = o.cwd ?? process.cwd();
	const explicit = o.configPath ?? env.RUNNER_CONFIG;
	const filePath = path.resolve(cwd, explicit ?? 'runner.config.json');
	let file: z.infer<typeof fileSchema> = {};
	let configFile: string | null = null;
	if (existsSync(filePath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(filePath, 'utf8'));
		} catch (e) {
			throw new ConfigError(
				`Konfigurationsdatei ${filePath} ist kein gültiges JSON: ${(e as Error).message}`
			);
		}
		const parsed = fileSchema.safeParse(raw);
		if (!parsed.success) {
			const lines = parsed.error.issues.map(
				(i) => `  - ${i.path.join('.') || '(Wurzel)'}: ${i.message}`
			);
			throw new ConfigError(`Konfigurationsdatei ${filePath} ist ungültig:\n${lines.join('\n')}`);
		}
		file = parsed.data;
		configFile = filePath;
	} else if (explicit) {
		throw new ConfigError(`Konfigurationsdatei ${filePath} nicht gefunden`);
	}

	let accounts: unknown = file.accounts ?? [];
	if (env.RUNNER_ACCOUNTS) {
		try {
			accounts = JSON.parse(env.RUNNER_ACCOUNTS);
		} catch (e) {
			throw new ConfigError(`RUNNER_ACCOUNTS ist kein gültiges JSON: ${(e as Error).message}`);
		}
	}
	const maxSlotsRaw = env.MAX_SLOTS ?? (file.maxSlots !== undefined ? String(file.maxSlots) : '2');
	const maxSlots = /^\d+$/.test(maxSlotsRaw.trim()) ? Number(maxSlotsRaw) : Number.NaN;
	const probeMinRaw = env.LIMIT_PROBE_MIN ?? (file.limitProbeMin !== undefined ? String(file.limitProbeMin) : '5');
	const limitProbeMin = /^\d+$/.test(probeMinRaw.trim()) ? Number(probeMinRaw) : Number.NaN;
	const drainRaw = env.DRAIN_SEC ?? (file.drainSec !== undefined ? String(file.drainSec) : '0');
	const drainSec = /^\d+$/.test(drainRaw.trim()) ? Number(drainRaw) : Number.NaN;
	const intOf = (envValue: string | undefined, fileValue: number | undefined, fallback: string) => {
		const raw = envValue ?? (fileValue !== undefined ? String(fileValue) : fallback);
		return /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
	};
	const kind = env.RUNNER_KIND?.trim().toLowerCase() || file.kind || 'server';
	const handoverSec = intOf(env.HANDOVER_SEC, file.handoverSec, '20');
	const wipCheckpointMin = intOf(env.WIP_CHECKPOINT_MIN, file.wipCheckpointMin, kind === 'desktop' ? '10' : '0');
	const powerEnv = envBool(env.POWER_EVENTS);
	if (powerEnv === 'invalid')
		throw new ConfigError('Konfiguration ungültig:\n  - POWER_EVENTS: muss true/false (bzw. 1/0) sein');
	const researchEnv = envBool(env.RESEARCH);
	if (researchEnv === 'invalid')
		throw new ConfigError('Konfiguration ungültig:\n  - RESEARCH: muss true/false (bzw. 1/0) sein');
	const autoRepairRounds = intOf(env.AUTO_REPAIR_ROUNDS, file.autoRepairRounds, '2');
	const researchMax = intOf(env.RESEARCH_MAX, file.researchMax, '3');
	const researchAccounts = env.RESEARCH_ACCOUNTS
		? env.RESEARCH_ACCOUNTS.split(',').map((k) => k.trim()).filter(Boolean)
		: (file.researchAccounts ?? []);
	const probeEnv = envBool(env.LIMIT_PROBE);
	if (probeEnv === 'invalid')
		throw new ConfigError('Konfiguration ungültig:\n  - LIMIT_PROBE: muss true/false (bzw. 1/0) sein');
	const baseDir = configFile ? path.dirname(configFile) : cwd;
	const url = env.ATRIUM_URL ?? file.atriumUrl;

	const candidate = {
		atriumUrl: url ? url.replace(/\/+$/, '') : undefined,
		apiKey: env.ATRIUM_API_KEY ?? file.apiKey,
		name: env.RUNNER_NAME ?? file.name ?? (os.hostname().slice(0, 80) || 'runner'),
		workDir: path.resolve(baseDir, env.WORK_DIR ?? file.workDir ?? './.work'),
		maxSlots,
		gitRemoteTemplate:
			env.GIT_REMOTE_TEMPLATE ?? file.gitRemoteTemplate ?? 'https://github.com/{owner}/{repo}.git',
		gitAuthorName: env.GIT_AUTHOR_NAME ?? file.gitAuthorName ?? 'Atrium Agent',
		gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? file.gitAuthorEmail ?? 'agent@atrium.local',
		limitProbe: probeEnv ?? file.limitProbe,
		limitProbeMin,
		drainSec,
		kind,
		handoverSec,
		wipCheckpointMin,
		powerEvents: powerEnv ?? file.powerEvents ?? kind === 'desktop',
		autoRepairRounds,
		research: researchEnv ?? file.research ?? true,
		researchMax,
		researchAccounts,
		accounts
	};
	const parsed = finalSchema.safeParse(candidate);
	if (!parsed.success) {
		const lines = parsed.error.issues.map((i) => {
			const [head, ...rest] = i.path;
			if (head === 'accounts') {
				const sub = rest.length > 1 ? '.' + rest.slice(1).join('.') : '';
				return `  - accounts[${String(rest[0] ?? '')}]${sub}: ${i.message}`;
			}
			if (head === 'maxSlots') return '  - MAX_SLOTS: muss eine ganze Zahl zwischen 0 und 64 sein';
			if (head === 'limitProbeMin') return '  - LIMIT_PROBE_MIN: muss eine ganze Zahl zwischen 1 und 1440 sein';
			if (head === 'drainSec') return '  - DRAIN_SEC: muss eine ganze Zahl zwischen 0 und 86400 sein';
			if (head === 'handoverSec') return '  - HANDOVER_SEC: muss eine ganze Zahl zwischen 3 und 300 sein';
			if (head === 'autoRepairRounds')
				return '  - AUTO_REPAIR_ROUNDS: muss eine ganze Zahl zwischen 0 und 10 sein';
			if (head === 'researchMax') return '  - RESEARCH_MAX: muss eine ganze Zahl zwischen 0 und 20 sein';
			if (head === 'wipCheckpointMin')
				return '  - WIP_CHECKPOINT_MIN: muss eine ganze Zahl zwischen 0 und 1440 sein';
			return `  - ${LABELS[String(head)] ?? String(head)}: ${i.message}`;
		});
		throw new ConfigError(`Konfiguration ungültig:\n${lines.join('\n')}`);
	}
	const keys = new Set<string>();
	for (const a of parsed.data.accounts) {
		if (keys.has(a.key))
			throw new ConfigError(`Konfiguration ungültig:\n  - accounts: Schlüssel „${a.key}“ doppelt`);
		keys.add(a.key);
	}
	return {
		...parsed.data,
		accounts: parsed.data.accounts.map((a) => ({
			...a,
			home: a.home ? path.resolve(baseDir, a.home) : undefined
		})),
		configFile
	};
}

/** Standard-CLI je Anbieter */
export function defaultCommand(provider: Provider): string {
	switch (provider) {
		case 'claude':
			return 'claude';
		case 'gemini':
			return 'gemini';
		case 'codex':
		case 'openai-api':
			return 'codex';
		case 'fake':
			return 'fake';
	}
}

/** Variablen, die nie an Agents, Projektbefehle oder Terminals weitergegeben werden */
export const PRIVATE_ENV = ['ATRIUM_API_KEY', 'RUNNER_ACCOUNTS'];

/** Prozessumgebung ohne die privaten Variablen des Runners */
export function publicEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const k of PRIVATE_ENV) delete env[k];
	return env;
}

/**
 * Umgebung für Agent-Prozesse eines Kontos. Der API-Key des Runners wird nie an Agents weitergegeben.
 * Mit `home` bekommt jedes Konto eigene Login-Daten (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME).
 */
export function accountEnv(
	acct: AccountConfig,
	base: NodeJS.ProcessEnv = process.env,
	extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
	const env = publicEnv(base);
	if (acct.home) {
		env.HOME = acct.home;
		if (process.platform === 'win32') env.USERPROFILE = acct.home;
		env.CLAUDE_CONFIG_DIR = path.join(acct.home, '.claude');
		env.CODEX_HOME = path.join(acct.home, '.codex');
		env.GEMINI_CLI_HOME = acct.home;
	}
	Object.assign(env, acct.env, extra);
	return env;
}

/** Alle Werte, die nie hochgeladen werden dürfen */
export function collectSecrets(cfg: RunnerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
	const out = [cfg.apiKey];
	for (const name of [
		'GH_TOKEN',
		'GITHUB_TOKEN',
		'OPENAI_API_KEY',
		'ANTHROPIC_API_KEY',
		'GEMINI_API_KEY',
		'GOOGLE_API_KEY'
	]) {
		const v = env[name];
		if (v) out.push(v);
	}
	for (const a of cfg.accounts) {
		out.push(...Object.values(a.env));
		if (a.apiKeyEnv) {
			const v = a.env[a.apiKeyEnv] ?? env[a.apiKeyEnv];
			if (v) out.push(v);
		}
	}
	return out.filter((s) => s.length >= 6);
}
