/**
 * Der Runner als Ganzes: Konten prüfen, bei Atrium anmelden, Heartbeat, SSE-Befehlsstrom, Befehle verteilen
 * (Angebote → Executor, RPC, Terminals), Aufräumen, geordnetes Beenden.
 */
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import { accountEnv, publicEnv, type RunnerConfig } from './config.ts';
import { ApiError, AtriumClient, RunnerApi, runCommandStream, type FetchFn } from './client.ts';
import { Executor, type AccountState } from './executor.ts';
import { LimitProber, type ProbeFetch } from './limit-probe.ts';
import { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { defaultAdapters, type AdapterRegistry } from './providers/index.ts';
import { LimitStore } from './providers/limit-snapshot.ts';
import { PowerMonitor, type PowerEvent, type PowerMonitorLike } from './power.ts';
import {
	PROTOCOL_VERSION,
	type HeartbeatInput,
	type LimitSnapshot,
	type RegisterInput,
	type RunnerCommand
} from './protocol.ts';
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
	/** fetch für die aktive Limit-Abfrage (Tests) */
	probeFetch?: ProbeFetch;
	/** Abstände (Tests verkürzen) */
	limitProbeTickMs?: number;
	reprobeMs?: number;
	cleanupMs?: number;
	backoffBaseMs?: number;
	/** Energie-Ereignisse im Modus desktop (Tests ersetzen den Monitor; Standard: `PowerMonitor`) */
	powerMonitor?: PowerMonitorLike;
	/** Nach einem Herunterfahren aus einem Energie-Ereignis aufrufen (`main.ts`: Prozess beenden) */
	onPowerShutdown?: () => void;
}

/** Wartet auf `p`, höchstens `ms` (bzw. bis `signal` auslöst); Fehler werden verschluckt */
async function within(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
	let t: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<void>((resolve) => {
		t = setTimeout(resolve, Math.max(0, ms));
		t.unref();
		onAbort = () => resolve();
		if (signal?.aborted) resolve();
		signal?.addEventListener('abort', onAbort, { once: true });
	});
	try {
		await Promise.race([p.then(() => undefined, () => undefined), stop]);
	} finally {
		clearTimeout(t);
		if (onAbort) signal?.removeEventListener('abort', onAbort);
	}
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

/** Limit-Stände, die jünger sind, werden in jedem Heartbeat mitgesendet */
const LIMIT_FRESH_MS = 30 * 60_000;

export class Runner {
	readonly api: RunnerApi;
	readonly client: AtriumClient;
	readonly workspace: Workspace;
	readonly executor: Executor;
	readonly pty: PtyManager;
	readonly limits = new LimitStore();
	readonly limitProber: LimitProber;
	/** Zuletzt im Heartbeat gesendeter Limit-Stand je Konto (Vergleich als JSON) */
	private readonly sentLimits = new Map<string, string>();
	private accounts = new Map<string, AccountState>();
	private readonly log: Logger;
	private readonly adapters: AdapterRegistry;
	private readonly stop = new AbortController();
	private status: 'pending' | 'approved' | 'disabled' = 'pending';
	private heartbeatSec = 15;
	private stream: ReturnType<typeof runCommandStream> | null = null;
	private timers: NodeJS.Timeout[] = [];
	private capabilities = { question: true, branchDelivery: true, prUpdate: true, limitReport: true, attachments: true, branchCleanup: false, handoff: true, git: false, gh: false, pty: false, os: `${process.platform}-${process.arch}` };
	private needsRegister = false;
	/** Beenden mit Frist läuft: keine neuen Angebote (`heartbeat.draining`) */
	private draining = false;
	/** Atrium versteht `finishInput.handoff` (`registerResult.features.handoff`) – nur dann WIP pushen */
	private featureHandoff = false;
	/** Von Atrium gemeldete Lease laufender Läufe (`registerResult.leaseSec`) */
	private leaseSec: number | null = null;
	/** Energie-Ereignisse (nur Modus desktop) */
	private power: PowerMonitorLike | null = null;
	/** Energie-Ereignisse nacheinander verarbeiten */
	private powerQueue: Promise<void> = Promise.resolve();
	/** Löst aus, sobald ein neueres Energie-Ereignis eintrifft (beendet z. B. die Heartbeat-Wiederholung nach `resume`) */
	private powerInterrupt = new AbortController();
	private shutdownPromise: Promise<void> | null = null;

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
			limits: this.limits,
			log: this.log.child('run')
		});
		this.limitProber = new LimitProber({
			config: o.config,
			store: this.limits,
			accounts: () => this.accounts,
			fetch: o.probeFetch,
			log: this.log.child('limits')
		});
		this.pty = new PtyManager({ api: this.api, workspace: this.workspace, redactor: o.redactor, log: this.log.child('pty') });
	}

	get signal(): AbortSignal {
		return this.stop.signal;
	}

	/** Modus aus der Konfiguration (Standard `server`) */
	get mode(): 'server' | 'desktop' {
		return this.o.config.mode ?? 'server';
	}

	/** Meldet Atrium `features.handoff` (WIP-Push bei der Übergabe)? */
	get handoffSupported(): boolean {
		return this.featureHandoff;
	}

	/** Frist der Übergabe in Millisekunden */
	private get handoffMs(): number {
		return (this.o.config.handoffSec ?? 8) * 1000;
	}

	private registerInput(): RegisterInput {
		return {
			protocol: PROTOCOL_VERSION,
			name: this.o.config.name,
			version: RUNNER_VERSION,
			maxSlots: this.o.config.maxSlots,
			kind: this.mode,
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
			}),
			// Nach einem Neustart leer: Atrium gibt verwaiste Läufe sofort frei
			runIds: this.executor.runIds()
		};
	}

	/** Anmelden, bis es klappt (bzw. bis zum Beenden oder bis `signal` auslöst) */
	private async register(signal: AbortSignal = this.stop.signal): Promise<boolean> {
		for (let attempt = 0; !signal.aborted; attempt++) {
			try {
				const r = await this.api.register(this.registerInput(), signal);
				this.status = r.status;
				this.heartbeatSec = Math.min(300, Math.max(5, r.heartbeatSec || 15));
				this.featureHandoff = r.features?.handoff === true;
				this.leaseSec = r.leaseSec && r.leaseSec > 0 ? r.leaseSec : null;
				// Kurze Lease (z. B. Desktop-Runner): mindestens drei Heartbeats je Lease
				if (this.leaseSec) this.heartbeatSec = Math.min(this.heartbeatSec, Math.max(5, Math.floor(this.leaseSec / 3)));
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
				await sleep(wait, signal);
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
			await this.sendHeartbeat();
		}
	}

	/** Heartbeat senden; true, wenn Atrium geantwortet hat und dessen `cancel`-Liste verarbeitet ist */
	private async sendHeartbeat(): Promise<boolean> {
		try {
			const r = await this.api.heartbeat({
				slotsUsed: this.executor.slotsUsed,
				runIds: this.executor.runIds(),
				...(this.draining ? { draining: true } : {}),
				accounts: this.heartbeatAccounts()
			});
			if (r.status !== this.status) this.log.info(`Status in Atrium: ${r.status}`);
			this.status = r.status;
			for (const id of r.cancel) {
				if (this.executor.cancel(id, 'Von Atrium abgebrochen')) this.log.info(`Lauf ${id} wird abgebrochen (Heartbeat)`);
			}
			return true;
		} catch (e) {
			// Limit-Stand beim nächsten Heartbeat erneut senden
			this.sentLimits.clear();
			if (e instanceof ApiError && (e.status === 404 || e.status === 409)) this.needsRegister = true;
			this.log.warn('Heartbeat fehlgeschlagen', errorMessage(e));
			return false;
		}
	}

	/**
	 * Konten für den Heartbeat. `limits` nur, wenn sich der Stand seit dem letzten Heartbeat geändert hat oder
	 * jünger als 30 min ist (ältere, unveränderte Stände muss Atrium nicht erneut erhalten).
	 */
	heartbeatAccounts(now: Date = new Date()): HeartbeatInput['accounts'] {
		return [...this.accounts.values()].map((a) => {
			const key = a.config.key;
			const snap: LimitSnapshot | null = this.limits.snapshot(key);
			if (!snap) return { key, loggedIn: a.loggedIn };
			const sig = JSON.stringify(snap);
			const fresh = now.getTime() - Date.parse(snap.observedAt) < LIMIT_FRESH_MS;
			if (!fresh && this.sentLimits.get(key) === sig) return { key, loggedIn: a.loggedIn };
			this.sentLimits.set(key, sig);
			return { key, loggedIn: a.loggedIn, limits: snap };
		});
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
					{
						workspace: this.workspace,
						api: this.api,
						redactor: this.o.redactor,
						log: this.log.child('rpc'),
						activeRuns: () => this.executor.runIds()
					},
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
		this.capabilities = { question: true, branchDelivery: true, prUpdate: true, limitReport: true, attachments: true, branchCleanup: git && ghOk, handoff: true, git, gh: ghOk, pty: ptyOk, os: `${os.platform()}-${os.arch()}`.slice(0, 40) };
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
		if (this.limitProber.enabled) {
			const tick = () => void this.limitProber.tick(this.stop.signal);
			const first = setTimeout(tick, 5_000);
			first.unref();
			const every = setInterval(tick, this.o.limitProbeTickMs ?? 60_000);
			every.unref();
			this.timers.push(first, every);
			this.log.info(`Aktive Limit-Abfrage an (alle ${this.o.config.limitProbeMin ?? 5} min)`);
		}

		if (!(await this.register())) return;
		this.startPower();
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

	/** Im Modus desktop Energie-Ereignisse beobachten (`powerEvents`, Standard an) */
	private startPower(): void {
		if (this.mode !== 'desktop') {
			if (this.o.config.powerEvents) this.log.info('POWER_EVENTS wirkt nur im Modus desktop');
			return;
		}
		if (this.o.config.powerEvents === false && !this.o.powerMonitor) {
			this.log.info('Desktop-Modus ohne Energie-Ereignisse (POWER_EVENTS=false) – Übergabe nur beim Beenden');
			return;
		}
		const monitor =
			this.o.powerMonitor ?? new PowerMonitor({ log: this.log.child('power'), waitMs: this.handoffMs });
		monitor.onEvent((e) => void this.handlePowerEvent(e));
		this.power = monitor;
		monitor.start();
		if (monitor instanceof PowerMonitor) this.log.info(`Energie-Ereignisse: ${monitor.methods.join(', ')}`);
	}

	/**
	 * Energie-Ereignis verarbeiten (nacheinander; `resume` sperrt die Auslieferung sofort). Löst sich auf, wenn
	 * das Ereignis fertig verarbeitet ist.
	 */
	handlePowerEvent(e: PowerEvent): Promise<void> {
		if (this.stop.signal.aborted || this.shutdownPromise) return Promise.resolve();
		// Nach dem Aufwachen gehören laufende Läufe womöglich schon einem anderen Runner: sofort sperren
		if (e.kind === 'resume') this.executor.holdDelivery();
		// Ein noch wartendes `resume` (Heartbeat-Wiederholung) gibt die Warteschlange für dieses Ereignis frei
		this.powerInterrupt.abort();
		const interrupt = (this.powerInterrupt = new AbortController()).signal;
		const job = async () => {
			try {
				if (e.kind === 'suspend') await this.onSuspend();
				else if (e.kind === 'resume') await this.onResume(e, interrupt);
				else await this.onPowerShutdown();
			} catch (err) {
				this.log.error(`Energie-Ereignis ${e.kind} fehlgeschlagen`, errorMessage(err));
			}
		};
		const p = this.powerQueue.then(job);
		this.powerQueue = p;
		return p;
	}

	/** Standby: Atrium „draining“ melden, Läufe übergeben, dann den Standby freigeben */
	private async onSuspend(): Promise<void> {
		const started = Date.now();
		const n = this.executor.slotsUsed;
		this.log.info(`PC geht in den Standby – ${n ? `übergebe ${n} laufende Läufe` : 'keine laufenden Läufe'}`);
		this.draining = true;
		// Zuerst die kurze Meldung an Atrium (keine neuen Angebote), begrenzt, damit die Übergabe Zeit behält
		await within(this.sendHeartbeat(), Math.min(1_500, this.handoffMs / 3));
		const left = Math.max(1_000, this.handoffMs - (Date.now() - started));
		const handed = await this.executor.handoff('suspend', { deadlineMs: left, pushWip: this.featureHandoff });
		if (handed) this.log.info(`${handed} Läufe an Atrium übergeben`);
		this.power?.ack();
	}

	/**
	 * Aufgewacht (bzw. Uhrsprung): Auslieferung gesperrt halten, sofort neu anmelden (Atrium gibt Läufe frei, die
	 * hier fehlen), den Befehlsstrom neu verbinden und einen Heartbeat senden (`cancel` bricht inzwischen übernommene
	 * Läufe ab). Erst nach einem erfolgreichen Heartbeat wieder ausliefern und Angebote annehmen; schlägt er fehl,
	 * bleibt die Auslieferung gesperrt und der Heartbeat wird mit Backoff wiederholt – bis er klappt, der Runner
	 * beendet wird oder ein neueres Energie-Ereignis eintrifft (`interrupt`, die Sperre bleibt dann bestehen).
	 */
	private async onResume(e: PowerEvent, interrupt: AbortSignal): Promise<void> {
		this.log.info(`Aufgewacht (${e.source}${e.detail ? `, ${e.detail}` : ''}) – melde mich neu an`);
		this.executor.holdDelivery();
		const wait = AbortSignal.any([this.stop.signal, interrupt]);
		if (!(await this.register(wait))) return;
		this.stream?.reconnect();
		for (let attempt = 0; !wait.aborted; attempt++) {
			if (await this.sendHeartbeat()) {
				this.executor.releaseDelivery();
				this.executor.resumeOffers();
				this.draining = false;
				return;
			}
			this.log.warn('Heartbeat nach dem Aufwachen fehlgeschlagen – Auslieferung bleibt gesperrt, neuer Versuch');
			await sleep(backoffMs(attempt, this.o.backoffBaseMs ?? 1000, 30_000), wait);
			if (this.needsRegister && !wait.aborted) {
				this.needsRegister = false;
				await this.register(wait);
			}
		}
	}

	/** Herunterfahren aus einem Energie-Ereignis: übergeben und beenden */
	private async onPowerShutdown(): Promise<void> {
		this.log.info('PC wird heruntergefahren');
		await this.shutdown();
		this.o.onPowerShutdown?.();
	}

	private async cleanup(): Promise<void> {
		try {
			const n = await this.workspace.cleanup(new Set(this.executor.runIds()));
			if (n) this.log.info(`${n} alte Worktrees entfernt`);
		} catch (e) {
			this.log.warn('Aufräumen fehlgeschlagen', errorMessage(e));
		}
	}

	/**
	 * Beenden: keine neuen Läufe, Terminals schließen. Mit `drainSec` (Konfiguration `DRAIN_SEC`) dürfen laufende
	 * Läufe bis dahin fertig werden; Atrium bietet dem Runner in der Zeit nichts mehr an. `skipDrain` (z. B. zweites
	 * Signal) bricht die Frist ab. Danach werden noch laufende Läufe mit `cancelled` abgeschlossen und neu eingeplant.
	 */
	shutdown(opts: { drainSec?: number; skipDrain?: AbortSignal } = {}): Promise<void> {
		this.shutdownPromise ??= this.doShutdown(opts);
		return this.shutdownPromise;
	}

	private async doShutdown(opts: { drainSec?: number; skipDrain?: AbortSignal }): Promise<void> {
		const drainSec = opts.drainSec ?? this.o.config.drainSec ?? 0;
		this.log.info('Runner wird beendet …');
		this.pty.closeAll();
		if (this.mode === 'desktop') {
			// Desktop: statt auf Läufe zu warten, sofort an Atrium übergeben (ein Server-Runner übernimmt)
			const n = this.executor.slotsUsed;
			if (n > 0 && !opts.skipDrain?.aborted) {
				const started = Date.now();
				this.draining = true;
				this.log.info(`Übergebe ${n} laufende Läufe an Atrium (Frist ${this.handoffMs / 1000} s, erneutes Signal bricht ab)`);
				await within(this.sendHeartbeat(), Math.min(1_500, this.handoffMs / 3), opts.skipDrain);
				const left = Math.max(1_000, this.handoffMs - (Date.now() - started));
				await within(
					this.executor.handoff('shutdown', { deadlineMs: left, pushWip: this.featureHandoff }),
					left + 1_000,
					opts.skipDrain
				);
			}
			this.power?.ack();
		} else if (drainSec > 0 && this.executor.slotsUsed > 0 && !opts.skipDrain?.aborted) {
			this.draining = true;
			this.log.info(
				`Warte bis zu ${drainSec} s auf ${this.executor.slotsUsed} laufende Läufe (erneutes Signal bricht sie sofort ab)`
			);
			const drained = this.executor.drain(drainSec * 1000, opts.skipDrain);
			// Atrium sofort informieren, damit keine neuen Angebote kommen
			await this.sendHeartbeat();
			const left = await drained;
			if (left) this.log.warn(`${left} Läufe nicht rechtzeitig fertig – sie werden abgebrochen und neu eingeplant`);
			else this.log.info('Alle laufenden Läufe sind fertig');
		}
		for (const t of this.timers) clearInterval(t);
		await this.executor.shutdown();
		this.power?.stop();
		this.stop.abort();
	}
}

export { Redactor };
