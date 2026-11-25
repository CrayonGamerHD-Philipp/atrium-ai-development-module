/**
 * Aktive Abfrage des Limit-Stands ohne Lauf (optional, Standard: Claude-Konten mit OAuth-Login).
 *
 * Claude: `GET https://api.anthropic.com/api/oauth/usage` mit dem OAuth-Access-Token des Kontos (undokumentierter
 * Endpunkt, Antwortform kann sich ändern). Das Token wird nur lokal gelesen (`CLAUDE_CODE_OAUTH_TOKEN` bzw.
 * `<CLAUDE_CONFIG_DIR>/.credentials.json`), nie erneuert, nie protokolliert und nie an Atrium gesendet. Bei
 * `ANTHROPIC_API_KEY` ohne OAuth-Login gibt es keine Abo-Fenster – dann keine Abfrage.
 *
 * Schutz vor Abfrage-Stürmen: Konten nacheinander, Zeitlimit höchstens 10 s, kein sofortiger Wiederholversuch,
 * nach Fehlern wachsender Abstand (bis 60 min), keine Abfrage, solange ein Lauf frische Werte geliefert hat.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountConfig, RunnerConfig } from './config.ts';
import { accountEnv } from './config.ts';
import type { AccountState } from './executor.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { claudeUsageWindows, type LimitStore } from './providers/limit-snapshot.ts';
import type { LimitWindow } from './protocol.ts';
import { errorMessage } from './util/async.ts';
import { RUNNER_VERSION } from './version.ts';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Höchstes Zeitlimit je Abfrage */
export const MAX_PROBE_TIMEOUT_MS = 10_000;
/** Größter Abstand nach wiederholten Fehlern */
export const MAX_BACKOFF_MS = 60 * 60_000;

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Soll für dieses Konto aktiv abgefragt werden? (Konto vor Runner; Standard: an für Claude) */
export function limitProbeEnabled(acct: AccountConfig, cfg: Pick<RunnerConfig, 'limitProbe'>): boolean {
	// Derzeit gibt es nur für Claude eine Abfrage
	if (acct.provider !== 'claude') return false;
	return acct.limitProbe ?? cfg.limitProbe ?? true;
}

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
	if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
	return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.claude');
}

/**
 * OAuth-Access-Token eines Claude-Kontos (nur lokal: Umgebung bzw. Anmeldedatei); `null`, wenn keins vorhanden
 * oder abgelaufen ist. Abgelaufene Tokens werden bewusst nicht erneuert (das ist Sache der CLI).
 */
export async function readClaudeOAuthToken(env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<string | null> {
	const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	let raw: string;
	try {
		raw = await readFile(path.join(claudeConfigDir(env), '.credentials.json'), 'utf8');
	} catch {
		return null;
	}
	try {
		const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
		const o = j.claudeAiOauth;
		if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
		if (typeof o.expiresAt === 'number' && o.expiresAt > 0) {
			const exp = o.expiresAt > 1e12 ? o.expiresAt : o.expiresAt * 1000;
			if (exp <= now.getTime()) return null;
		}
		return o.accessToken;
	} catch {
		return null;
	}
}

export type UsageResult =
	| { ok: true; windows: LimitWindow[] }
	| { ok: false; status: number | null; error: string };

/** Claude-OAuth-Abfrage; wirft nie, Fehlermeldungen enthalten nie das Token */
export async function fetchClaudeUsage(
	token: string,
	fetchFn: ProbeFetch,
	timeoutMs = MAX_PROBE_TIMEOUT_MS,
	signal?: AbortSignal
): Promise<UsageResult> {
	const timeout = AbortSignal.timeout(Math.max(100, Math.min(MAX_PROBE_TIMEOUT_MS, timeoutMs)));
	const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const res = await fetchFn(CLAUDE_USAGE_URL, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				'anthropic-beta': 'oauth-2025-04-20',
				Accept: 'application/json',
				'User-Agent': `atrium-aidev-runner/${RUNNER_VERSION}`
			},
			signal: s,
			redirect: 'error'
		});
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined);
			return { ok: false, status: res.status, error: `HTTP ${res.status}` };
		}
		let body: unknown;
		try {
			body = JSON.parse(await res.text());
		} catch {
			return { ok: false, status: res.status, error: 'Antwort ist kein JSON' };
		}
		const windows = claudeUsageWindows(body);
		if (!windows) return { ok: false, status: res.status, error: 'Antwort ohne bekannte Limit-Fenster' };
		return { ok: true, windows };
	} catch (e) {
		if (timeout.aborted) return { ok: false, status: null, error: 'Zeitüberschreitung' };
		const msg = errorMessage(e);
		// Sicherheitshalber: Token nie in Fehlermeldungen weitergeben
		return { ok: false, status: null, error: msg.split(token).join('[entfernt]').slice(0, 200) };
	}
}

export interface LimitProberOptions {
	config: Pick<RunnerConfig, 'accounts' | 'limitProbe' | 'limitProbeMin'>;
	store: LimitStore;
	accounts: () => Map<string, AccountState>;
	fetch?: ProbeFetch;
	log?: Logger;
	now?: () => Date;
	timeoutMs?: number;
	/** Umgebung je Konto (Tests); Standard: `accountEnv` */
	env?: (acct: AccountConfig) => NodeJS.ProcessEnv;
}

interface ProbeState {
	nextAt: number;
	failures: number;
}

export class LimitProber {
	private readonly state = new Map<string, ProbeState>();
	private busy = false;
	private readonly log: Logger;
	private readonly now: () => Date;
	private readonly fetchFn: ProbeFetch;

	constructor(private readonly o: LimitProberOptions) {
		this.log = o.log ?? silentLogger;
		this.now = o.now ?? (() => new Date());
		this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
	}

	get intervalMs(): number {
		return Math.max(1, this.o.config.limitProbeMin ?? 5) * 60_000;
	}

	/** Gibt es überhaupt Konten mit aktiver Abfrage? */
	get enabled(): boolean {
		return this.o.config.accounts.some((a) => limitProbeEnabled(a, this.o.config));
	}

	/** Alle fälligen Konten nacheinander abfragen; überlappende Aufrufe werden übersprungen. Wirft nie. */
	async tick(signal?: AbortSignal): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			for (const acct of this.o.config.accounts) {
				if (signal?.aborted) return;
				if (!limitProbeEnabled(acct, this.o.config)) continue;
				try {
					await this.probeAccount(acct, signal);
				} catch (e) {
					// darf nie durchschlagen
					this.fail(acct.key, null, errorMessage(e));
				}
			}
		} finally {
			this.busy = false;
		}
	}

	private async probeAccount(acct: AccountConfig, signal?: AbortSignal): Promise<void> {
		const now = this.now().getTime();
		const st = this.state.get(acct.key) ?? { nextAt: 0, failures: 0 };
		this.state.set(acct.key, st);
		if (now < st.nextAt) return;
		const interval = this.intervalMs;
		// Ein Lauf hat gerade frische Werte geliefert → keine Abfrage nötig
		const streamed = this.o.store.lastObserved(acct.key, 'stream');
		if (streamed !== null && now - streamed < interval) {
			st.nextAt = streamed + interval;
			return;
		}
		const s = this.o.accounts().get(acct.key);
		if (!s?.ok || !s.loggedIn) {
			st.nextAt = now + interval;
			return;
		}
		const env = this.o.env ? this.o.env(acct) : accountEnv(acct);
		const token = await readClaudeOAuthToken(env, this.now());
		if (!token) {
			// Kein OAuth-Login (z. B. nur ANTHROPIC_API_KEY) – später erneut nachsehen, ohne Netzwerk
			st.nextAt = now + interval;
			return;
		}
		const r = await fetchClaudeUsage(token, this.fetchFn, this.o.timeoutMs, signal);
		if (r.ok) {
			if (st.failures) this.log.info(`Limit-Abfrage ${acct.key}: wieder erfolgreich`);
			st.failures = 0;
			st.nextAt = now + interval;
			this.o.store.update(acct.key, r.windows, 'probe', this.now());
			this.log.debug(`Limit-Abfrage ${acct.key}: ${r.windows.length} Fenster`);
			return;
		}
		this.fail(acct.key, r.status, r.error);
	}

	private fail(key: string, status: number | null, error: string): void {
		const st = this.state.get(key) ?? { nextAt: 0, failures: 0 };
		this.state.set(key, st);
		st.failures++;
		// Anmeldung/Berechtigung bzw. Drosselung: lange warten; sonst exponentiell wachsend
		const hard = status === 401 || status === 403 || status === 429;
		const wait = hard ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(st.failures, 6));
		st.nextAt = this.now().getTime() + wait;
		const msg = `Limit-Abfrage ${key} fehlgeschlagen (${error}), nächster Versuch in ${Math.round(wait / 60_000)} min`;
		if (st.failures === 1) this.log.warn(msg);
		else this.log.debug(msg);
	}
}
