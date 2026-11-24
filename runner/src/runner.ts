/**
 * Der Runner als Ganzes: Konten prüfen, bei Atrium anmelden, Heartbeat, SSE-Befehlsstrom, Befehle verteilen
 * (Angebote → Executor, RPC, Terminals), Aufräumen, geordnetes Beenden.
 */
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import { accountEnv, publicEnv, type RunnerConfig } from './config.ts';
import { ApiError, AtriumClient, RunnerApi, runCommandStream, type FetchFn } from './client.ts';
import { Executor, type AccountState } from './executor.ts';
import { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { defaultAdapters, type AdapterRegistry } from './providers/index.ts';
import { PROTOCOL_VERSION, type RegisterInput, type RunnerCommand } from './protocol.ts';
import { PtyManager } from './pty.ts';
import { Redactor } from './redact.ts';
import { handleRpc } from './rpc.ts';
import { backoffMs, errorMessage, sleep } from './util/async.ts';
import { exec } from './util/proc.ts';
import { RUNNER_VERSION } from './version.ts';

export interface RunnerOptions {
	config: RunnerConfig;
	redactor: Redactor;
	log?: Logger;
	adapters?: AdapterRegistry;
	fetch?: FetchFn;
	/** Abstände (Tests verkürzen) */
	reprobeMs?: number;
	cleanupMs?: number;
	backoffBaseMs?: number;
}

/** Konten prüfen (CLI vorhanden, angemeldet) */
export async function probeAccounts(
	config: RunnerConfig,
	adapters: AdapterRegistry,
	log: Logger = silentLogger
): Promise<Map<string, AccountState>> {
	const out = new Map<string, AccountState>();
	await Promise.all(
		config.accounts.map(async (acct) => {
			try {
				const r = await adapters[acct.provider].probe(acct, accountEnv(acct));
				out.set(acct.key, { config: acct, ok: r.ok, loggedIn: r.ok && r.loggedIn, version: r.version, message: r.message });
			} catch (e) {
				out.set(acct.key, { config: acct, ok: false, loggedIn: false, version: '', message: errorMessage(e) });
			}
		})
	);
	for (const a of config.accounts) {
		const s = out.get(a.key);
		if (!s) continue;
		const state = !s.ok ? 'CLI fehlt' : s.loggedIn ? 'angemeldet' : 'NICHT angemeldet';
		log.info(`Konto ${a.key} (${a.provider}): ${state}${s.version ? `, Version ${s.version}` : ''}${s.message ? ` – ${s.message}` : ''}`);
	}
	return out;
}

async function hasCommand(cmd: string, args = ['--version']): Promise<boolean> {
	const r = await exec(cmd, args, { timeoutMs: 15_000 });
	return r.code === 0 && !r.spawnError;
}

export class Runner {
	readonly api: RunnerApi;
	readonly client: AtriumClient;
	readonly workspace: Workspace;
	readonly executor: Executor;
	readonly pty: PtyManager;
	private accounts = new Map<string, AccountState>();
	private readonly log: Logger;
	private readonly adapters: AdapterRegistry;
	private readonly stop = new AbortController();
	private status: 'pending' | 'approved' | 'disabled' = 'pending';
	private heartbeatSec = 15;
	private stream: ReturnType<typeof runCommandStream> | null = null;
	private timers: NodeJS.Timeout[] = [];
	private capabilities = { git: false, gh: false, pty: false, os: `${process.platform}-${process.arch}` };
	private needsRegister = false;

	constructor(private readonly o: RunnerOptions) {
		this.log = o.log ?? silentLogger;
		this.adapters = o.adapters ?? defaultAdapters;
		this.client = new AtriumClient({
			atriumUrl: o.config.atriumUrl,
			apiKey: o.config.apiKey,
			fetch: o.fetch,
			log: this.log.child('http'),
			backoffBaseMs: o.backoffBaseMs
		});
		this.api = new RunnerApi(this.client);
		this.workspace = new Workspace({
			workDir: o.config.workDir,
			remoteTemplate: o.config.gitRemoteTemplate,
			author: { name: o.config.gitAuthorName, email: o.config.gitAuthorEmail },
			env: publicEnv(process.env),
			useGhCredentials: true,
			log: this.log.child('git')
		});
		this.executor = new Executor({
			config: o.config,
			api: this.api,
			workspace: this.workspace,
			adapters: this.adapters,
			redactor: o.redactor,
			accounts: () => this.accounts,
			log: this.log.child('run')
		});
		this.pty = new PtyManager({ api: this.api, workspace: this.workspace, redactor: o.redactor, log: this.log.child('pty') });
	}

	get signal(): AbortSignal {
		return this.stop.signal;
	}

	private registerInput(): RegisterInput {
		return {
			protocol: PROTOCOL_VERSION,
			name: this.o.config.name,
			version: RUNNER_VERSION,
			maxSlots: this.o.config.maxSlots,
			capabilities: this.capabilities,
			accounts: this.o.config.accounts.map((a) => {
				const s = this.accounts.get(a.key);
				return {
					key: a.key,
					provider: a.provider,
					label: (a.label ?? '').slice(0, 120),
					loggedIn: s?.loggedIn ?? false,
					models: a.models.length ? a.models : a.model ? [a.model] : []
				};
			})
		};
	}

	/** Anmelden, bis es klappt (bzw. bis zum Beenden) */
	private async register(): Promise<boolean> {
		for (let attempt = 0; !this.stop.signal.aborted; attempt++) {
			try {
				const r = await this.api.register(this.registerInput(), this.stop.signal);
				this.status = r.status;
				this.heartbeatSec = Math.min(300, Math.max(5, r.heartbeatSec || 15));
				this.log.info(`Bei Atrium angemeldet (Runner ${r.runnerId}, Status ${r.status})`);
				if (r.status === 'pending')
					this.log.info('Runner wartet auf Freigabe in Atrium (Administration → Runner & Konten)');
				if (r.status === 'disabled') this.log.warn('Runner ist in Atrium deaktiviert');
				return true;
			} catch (e) {
				const auth = e instanceof ApiError && (e.status === 401 || e.status === 403);
				const wait = auth ? 60_000 : backoffMs(attempt, 1000, 60_000);
				this.log.error(
					auth
						? 'Anmeldung abgelehnt – API-Key bzw. Berechtigung aidev.runner.connect prüfen'
						: 'Anmeldung bei Atrium fehlgeschlagen',
					errorMessage(e)
				);
				await sleep(wait, this.stop.signal);
			}
		}
		return false;
	}

	private async heartbeatLoop(): Promise<void> {
		while (!this.stop.signal.aborted) {
			await sleep(this.heartbeatSec * 1000, this.stop.signal);
			if (this.stop.signal.aborted) break;
			if (this.needsRegister) {
				this.needsRegister = false;
				await this.register();
			}
			try {
				const r = await this.api.heartbeat({
					slotsUsed: this.executor.slotsUsed,
					runIds: this.executor.runIds(),
					accounts: [...this.accounts.values()].map((a) => ({ key: a.config.key, loggedIn: a.loggedIn }))
				});
				if (r.status !== this.status) this.log.info(`Status in Atrium: ${r.status}`);
				this.status = r.status;
				for (const id of r.cancel) {
					if (this.executor.cancel(id, 'Von Atrium abgebrochen')) this.log.info(`Lauf ${id} wird abgebrochen (Heartbeat)`);
				}
			} catch (e) {
				if (e instanceof ApiError && (e.status === 404 || e.status === 409)) this.needsRegister = true;
				this.log.warn('Heartbeat fehlgeschlagen', errorMessage(e));
			}
		}
	}

	/** Befehl verteilen */
	dispatch(cmd: RunnerCommand): void {
		switch (cmd.type) {
			case 'hello':
				this.status = cmd.status;
				this.log.info(`Atrium begrüßt Runner ${cmd.runnerId} (Status ${cmd.status})`);
				break;
			case 'offer':
				void this.executor
					.handleOffer(cmd.offer)
					.catch((e: unknown) => this.log.error('Angebot konnte nicht bearbeitet werden', errorMessage(e)));
				break;
			case 'cancel':
				if (this.executor.cancel(cmd.runId, cmd.reason || 'Von Atrium abgebrochen'))
					this.log.info(`Lauf ${cmd.runId} wird abgebrochen`);
				break;
			case 'rpc':
				void handleRpc(
					{ workspace: this.workspace, api: this.api, redactor: this.o.redactor, log: this.log.child('rpc') },
					cmd
				);
				break;
			case 'pty-open':
			case 'pty-input':
			case 'pty-resize':
			case 'pty-close':
				this.pty.handle(cmd);
				break;
			case 'revoked':
				this.log.warn('Atrium hat die Verbindung widerrufen – neue Anmeldung');
				void this.register().then(() => this.stream?.reconnect());
				break;
		}
	}

	private async fetchPending(): Promise<void> {
		const cmds = await this.api.pending();
		for (const c of cmds) this.dispatch(c);
	}

	/** Start: Fähigkeiten prüfen, anmelden, Strom und Heartbeat starten. Löst sich beim Beenden auf. */
	async start(): Promise<void> {
		await mkdir(this.o.config.workDir, { recursive: true });
		const [git, ghOk, ptyOk] = await Promise.all([hasCommand('git'), hasCommand('gh'), this.pty.available()]);
		this.capabilities = { git, gh: ghOk, pty: ptyOk, os: `${os.platform()}-${os.arch()}`.slice(0, 40) };
		if (!git) this.log.error('git wurde nicht gefunden – Läufe sind nicht möglich');
		if (!ghOk) this.log.warn('gh wurde nicht gefunden – PRs und PR-Übersicht sind nicht möglich');
		if (!ptyOk) this.log.info('node-pty nicht verfügbar – Terminals sind deaktiviert');
		this.accounts = await probeAccounts(this.o.config, this.adapters, this.log.child('konto'));

		await this.cleanup();
		this.timers.push(setInterval(() => void this.cleanup(), this.o.cleanupMs ?? 3_600_000));
		this.timers.push(
			setInterval(() => {
				void probeAccounts(this.o.config, this.adapters).then((m) => {
					this.accounts = m;
				});
			}, this.o.reprobeMs ?? 300_000)
		);

		if (!(await this.register())) return;
		this.stream = runCommandStream(
			this.client,
			{
				onCommand: (c) => this.dispatch(c),
				onConnected: () => this.fetchPending(),
				onAuthError: (e) => this.log.error('Befehlsstrom: Zugriff verweigert', e.message)
			},
			this.stop.signal,
			{ log: this.log.child('sse') }
		);
		await Promise.all([this.stream.done, this.heartbeatLoop()]);
	}

	private async cleanup(): Promise<void> {
		try {
			const n = await this.workspace.cleanup(new Set(this.executor.runIds()));
			if (n) this.log.info(`${n} alte Worktrees entfernt`);
		} catch (e) {
			this.log.warn('Aufräumen fehlgeschlagen', errorMessage(e));
		}
	}

	/** Beenden: keine neuen Läufe, laufende mit `cancelled` abschließen, Terminals schließen */
	async shutdown(): Promise<void> {
		this.log.info('Runner wird beendet …');
		for (const t of this.timers) clearInterval(t);
		this.pty.closeAll();
		await this.executor.shutdown();
		this.stop.abort();
	}
}

export { Redactor };
