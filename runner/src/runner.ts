/**
 * Der Runner als Ganzes: Konten prüfen, bei Atrium anmelden, Heartbeat, SSE-Befehlsstrom, Befehle verteilen
 * (Angebote → Executor, RPC, Terminals), Aufräumen, geordnetes Beenden.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { accountEnv, publicEnv, type RunnerConfig } from './config.ts';
import { ApiError, AtriumClient, RunnerApi, runCommandStream, type FetchFn } from './client.ts';
import { Executor, type AccountState, type AtriumFeatures, type RunSummary } from './executor.ts';
import { LimitProber, type ProbeFetch } from './limit-probe.ts';
import { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { defaultAdapters, type AdapterRegistry } from './providers/index.ts';
import { LimitStore } from './providers/limit-snapshot.ts';
import {
	PROTOCOL_VERSION,
	type HandoffReason,
	type HeartbeatInput,
	type LimitSnapshot,
	type RegisterInput,
	type RunnerCommand
} from './protocol.ts';
import { defaultPowerMonitor, type PowerEvent, type PowerMonitor } from './power/index.ts';
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
	/**
	 * Energieüberwachung (Standby/Herunterfahren). Standard: bei `powerEvents` die der Plattform plus
	 * Zeitsprung-Erkennung, sonst keine; `null` = aus (Tests: `FakePowerMonitor`).
	 */
	powerMonitor?: PowerMonitor | null;
	/** Zustandsdatei bei Änderungen höchstens so oft schreiben (ms, Standard 3000) */
	stateWriteMs?: number;
	/** Abfrage der Steuerdateien (`handover`, `pause`, `stop`) in ms (Standard 2000) */
	controlPollMs?: number;
	/** Steuerdatei `stop` (geordnetes Beenden, z. B. `atrium-runner stop` unter Windows) */
	onStopRequest?: () => void;
}

/** Steuerdateien im Arbeitsverzeichnis (Befehle `handover`, `pause`, `resume` des laufenden Runners) */
export function controlDir(workDir: string): string {
	return path.join(workDir, 'control');
}
/** Zustandsdatei für `status` */
export function stateFile(workDir: string): string {
	return path.join(workDir, 'state.json');
}

/** Inhalt der Zustandsdatei (`atrium-runner status`) */
export interface RunnerStateFile {
	pid: number;
	name: string;
	version: string;
	kind: 'server' | 'desktop';
	status: string;
	runnerId: string | null;
	paused: HandoffReason | null;
	runs: string[];
	lastHeartbeatAt: string | null;
	startedAt: string;
	power: string;
	updatedAt: string;
	/** Ab 0.5.0 (PC-Oberfläche); ältere Runner schreiben die Felder nicht */
	/** Atrium-Adresse (ohne Zugangsdaten) */
	atriumUrl?: string;
	/** Letzter Heartbeat erfolgreich? Fehlermeldung des letzten Fehlschlags */
	atrium?: { ok: boolean; error: string | null; at: string | null };
	/** Laufende Läufe mit letzter Tätigkeit */
	details?: RunSummary[];
	/** Konten: CLI vorhanden, angemeldet */
	accounts?: { key: string; provider: string; label: string; ok: boolean; loggedIn: boolean; version: string; message: string }[];
	/** Pausiert über die Steuerdatei `pause` (statt nur Übergabe) */
	pausedByUser?: boolean;
	/** Anzahl gleichzeitiger Läufe */
	maxSlots?: number;
}

/**
 * Dauerhafte Kennung dieser Installation (Datei `instance-id` im Arbeitsverzeichnis, beim ersten Start angelegt).
 * Bleibt über Neustarts gleich; Atrium erkennt daran zwei Installationen unter demselben API-Key.
 */
export async function loadInstanceId(workDir: string): Promise<string> {
	const file = path.join(workDir, 'instance-id');
	try {
		const v = (await readFile(file, 'utf8')).trim();
		if (/^[A-Za-z0-9_-]{8,64}$/.test(v)) return v;
	} catch {
		// noch keine Kennung
	}
	const id = randomUUID();
	await writeFile(file, `${id}
`);
	return id;
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
	private capabilities = { question: true, branchDelivery: true, prUpdate: true, limitReport: true, attachments: true, handoff: true, fencing: true, wip: true, branchCleanup: false, git: false, gh: false, pty: false, os: `${process.platform}-${process.arch}` };
	/** Fähigkeiten von Atrium aus der letzten Anmeldung */
	private features: AtriumFeatures = {};
	private runnerId: string | null = null;
	private lastHeartbeatAt: string | null = null;
	private readonly startedAt = new Date().toISOString();
	private power: PowerMonitor | null = null;
	private powerName = 'aus';
	/** Laufende Übergabe (mehrfache Auslöser warten auf dieselbe) */
	private handoverRun: Promise<number> | null = null;
	/** Manuell pausiert (Steuerdatei `pause`) */
	private paused = false;
	private shutdownResumeTimer: NodeJS.Timeout | null = null;
	private needsRegister = false;
	/** Beenden mit Frist läuft: keine neuen Angebote (`heartbeat.draining`) */
	private draining = false;
	/** Dauerhafte Kennung dieser Installation (`registerInput.instanceId`, Datei `instance-id` im Arbeitsverzeichnis) */
	private instanceId: string | null = null;
	/** Frist der laufenden Übergabe (für `heartbeat.handoverGraceSec`) */
	private handoverDeadline: number | null = null;
	/** Ergebnis des letzten Heartbeats (PC-Oberfläche) */
	private atriumState: { ok: boolean; error: string | null; at: string | null } = { ok: false, error: null, at: null };
	/** Zuletzt geschriebene Zustandsdatei ohne Zeitstempel (nur bei Änderungen neu schreiben) */
	private lastStateSig = '';

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
			log: this.log.child('run'),
			features: () => this.features
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

	private registerInput(): RegisterInput {
		return {
			protocol: PROTOCOL_VERSION,
			name: this.o.config.name,
			version: RUNNER_VERSION,
			maxSlots: this.o.config.maxSlots,
			kind: this.kind,
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
			runIds: this.executor.runIds(),
			...(this.instanceId ? { instanceId: this.instanceId } : {})
		};
	}

	/** Anmelden, bis es klappt (bzw. bis zum Beenden) */
	private async register(): Promise<boolean> {
		for (let attempt = 0; !this.stop.signal.aborted; attempt++) {
			try {
				const r = await this.api.register(this.registerInput(), this.stop.signal);
				this.status = r.status;
				this.runnerId = r.runnerId;
				this.features = r.features ?? {};
				// Heartbeat deutlich unter der Lease halten (PC-Runner: kürzere Lease)
				const lease = r.leaseSec ?? 90;
				this.heartbeatSec = Math.min(300, Math.max(5, Math.min(r.heartbeatSec || 15, Math.floor(lease / 4))));
				if (r.kind && r.kind !== this.kind)
					this.log.info(`Atrium führt diesen Runner als ${r.kind === 'desktop' ? 'PC-Runner' : 'Server-Runner'}`);
				this.log.info(`Bei Atrium angemeldet (Runner ${r.runnerId}, Status ${r.status})`);
				this.atriumState = { ok: true, error: null, at: new Date().toISOString() };
				if (r.status === 'pending')
					this.log.info('Runner wartet auf Freigabe in Atrium (Administration → Runner & Konten)');
				if (r.status === 'disabled') this.log.warn('Runner ist in Atrium deaktiviert');
				return true;
			} catch (e) {
				const auth = e instanceof ApiError && (e.status === 401 || e.status === 403);
				// 409: derselbe API-Key wird von einer anderen, noch aktiven Installation benutzt
				const conflict = e instanceof ApiError && e.status === 409;
				const wait = auth || conflict ? 60_000 : backoffMs(attempt, 1000, 60_000);
				this.log.error(
					auth
						? 'Anmeldung abgelehnt – API-Key bzw. Berechtigung aidev.runner.connect prüfen'
						: conflict
							? 'Anmeldung abgelehnt – API-Key wird schon von einem anderen Runner verwendet (je Runner ein eigener API-Key)'
							: 'Anmeldung bei Atrium fehlgeschlagen',
					errorMessage(e)
				);
				this.atriumState = {
					ok: false,
					error: this.o.redactor.redact(`Anmeldung fehlgeschlagen: ${errorMessage(e)}`).slice(0, 300),
					at: new Date().toISOString()
				};
				void this.writeState({ onlyIfChanged: true });
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
			await this.sendHeartbeat();
		}
	}

	private async sendHeartbeat(opts: { timeoutMs?: number } = {}): Promise<void> {
		try {
			const handover = this.executor.handoverReason;
			// Frist bis zur Abschlussmeldung: Atrium verkürzt die Lease darauf und plant ohne Meldung sofort neu ein
			const graceSec = handover && this.handoverDeadline
				? Math.min(300, Math.max(1, Math.ceil((this.handoverDeadline - Date.now()) / 1000)))
				: null;
			const r = await this.api.heartbeat(
				{
					slotsUsed: this.executor.slotsUsed,
					runIds: this.executor.runIds(),
					...(this.draining ? { draining: true } : {}),
					...(handover ? { handover } : {}),
					...(graceSec ? { handoverGraceSec: graceSec } : {}),
					accounts: this.heartbeatAccounts()
				},
				opts
			);
			this.lastHeartbeatAt = new Date().toISOString();
			this.atriumState = { ok: true, error: null, at: this.lastHeartbeatAt };
			if (r.status !== this.status) this.log.info(`Status in Atrium: ${r.status}`);
			this.status = r.status;
			for (const id of r.cancel) {
				if (this.executor.cancel(id, 'Von Atrium abgebrochen')) this.log.info(`Lauf ${id} wird abgebrochen (Heartbeat)`);
			}
		} catch (e) {
			// Limit-Stand beim nächsten Heartbeat erneut senden
			this.sentLimits.clear();
			if (e instanceof ApiError && (e.status === 404 || e.status === 409)) this.needsRegister = true;
			this.log.warn('Heartbeat fehlgeschlagen', errorMessage(e));
			this.atriumState = { ok: false, error: this.o.redactor.redact(errorMessage(e)).slice(0, 300), at: new Date().toISOString() };
		} finally {
			void this.writeState();
		}
	}

	get kind(): 'server' | 'desktop' {
		return this.o.config.kind ?? 'server';
	}

	/**
	 * Geordnete Übergabe (Standby, Herunterfahren, „jetzt an Server übergeben“): 1. Atrium per Heartbeat mit
	 * `handover` informieren (keine neuen Angebote), 2. Agents stoppen, 3. Zwischenstände als WIP-Ref pushen,
	 * 4. Läufe als übergeben melden – alles innerhalb von `handoverSec` bzw. der Frist des Betriebssystems.
	 * Liefert die Zahl der übergebenen Läufe.
	 */
	handover(reason: HandoffReason, graceMs: number | null = null): Promise<number> {
		if (this.handoverRun) return this.handoverRun;
		const budget = Math.min((this.o.config.handoverSec ?? 20) * 1000, graceMs ?? Number.POSITIVE_INFINITY);
		const deadline = Date.now() + Math.max(1000, budget);
		this.handoverDeadline = deadline;
		const started = Date.now();
		this.handoverRun = (async () => {
			const runs = this.executor.slotsUsed;
			this.log.info(`Übergabe (${reason}) – ${runs} laufende Läufe, Frist ${Math.round((deadline - started) / 1000)} s`);
			this.pty.closeAll();
			// erst melden (kurz), dann stoppen; der Executor nimmt ab jetzt nichts mehr an
			const hb = this.executor.handover(reason, deadline);
			await Promise.race([this.sendHeartbeat({ timeoutMs: Math.min(2000, Math.max(500, deadline - Date.now())) }), sleep(2000)]);
			const n = await hb;
			this.log.info(`Übergabe abgeschlossen (${n} Läufe, ${Date.now() - started} ms)`);
			return n;
		})().finally(() => {
			this.handoverRun = null;
		});
		return this.handoverRun;
	}

	/**
	 * Nach dem Aufwachen (bzw. Ende einer Pause): zuerst die Leases prüfen – Läufe, die Atrium inzwischen einem
	 * anderen Runner gegeben hat, werden verworfen (kein Push, keine Meldung, Worktree wird später aufgeräumt) –,
	 * dann neu anmelden und den Befehlsstrom neu verbinden. Danach nimmt der Runner wieder neue Aufträge an.
	 */
	async wake(source = 'resume'): Promise<void> {
		this.log.info(`Aufgewacht (${source}) – Leases werden geprüft`);
		const runs = this.executor.leaseRuns();
		if (runs.length && this.features.fencing) {
			try {
				const res = await this.api.leases({ runs });
				for (const r of res.revoked) {
					if (this.executor.revoke(r.runId, `Lease verloren: ${r.reason}`))
						this.log.warn(`Lauf ${r.runId} wurde übernommen und wird verworfen (${r.reason})`);
				}
			} catch (e) {
				// ohne Prüfung pusht der Executor ohnehin nicht (`assertLease` vor jedem Push)
				this.log.warn('Lease-Prüfung nach dem Aufwachen fehlgeschlagen', errorMessage(e));
			}
		}
		if (!this.paused) this.executor.resume();
		if (this.shutdownResumeTimer) clearTimeout(this.shutdownResumeTimer);
		this.shutdownResumeTimer = null;
		this.needsRegister = false;
		if (await this.registerOnce()) this.stream?.reconnect();
		await this.sendHeartbeat();
	}

	private async registerOnce(): Promise<boolean> {
		try {
			const r = await this.api.register(this.registerInput(), this.stop.signal);
			this.status = r.status;
			this.runnerId = r.runnerId;
			this.features = r.features ?? {};
			return true;
		} catch (e) {
			this.needsRegister = true;
			this.log.warn('Neuanmeldung fehlgeschlagen', errorMessage(e));
			return false;
		}
	}

	/** Energie-Ereignis des Betriebssystems */
	async onPower(e: PowerEvent): Promise<void> {
		if (e.type === 'resume') {
			await this.wake(e.sleptMs ? `${e.source}, ~${Math.round(e.sleptMs / 1000)} s` : e.source);
			return;
		}
		const grace = this.power?.graceMs ?? null;
		await this.handover(e.type === 'suspend' ? 'suspend' : 'shutdown', grace);
		// Standby bzw. Herunterfahren abgebrochen (ohne Aufwach-Ereignis)? Dann nach 1 bzw. 2 min wieder Aufträge
		// annehmen. Schläft der Rechner wirklich, ist der Timer eingefroren und löst erst nach dem Aufwachen aus.
		if (this.shutdownResumeTimer) clearTimeout(this.shutdownResumeTimer);
		const label = e.type === 'suspend' ? 'Standby abgebrochen' : 'Herunterfahren abgebrochen';
		this.shutdownResumeTimer = setTimeout(() => void this.wake(label), e.type === 'suspend' ? 60_000 : 120_000);
		this.shutdownResumeTimer.unref();
	}

	/** Steuerdateien auswerten: `stop`/`handover` (einmalig), `pause` (solange vorhanden) */
	async pollControl(): Promise<void> {
		const dir = controlDir(this.o.config.workDir);
		const exists = async (name: string) => {
			try {
				await readFile(path.join(dir, name));
				return true;
			} catch {
				return false;
			}
		};
		if (await exists('stop')) {
			await rm(path.join(dir, 'stop'), { force: true });
			this.log.info('Befehl „stop“: Runner wird beendet');
			this.o.onStopRequest?.();
			return;
		}
		if (await exists('handover')) {
			await rm(path.join(dir, 'handover'), { force: true });
			this.log.info('Befehl „handover“: laufende Läufe werden an einen Server-Runner übergeben');
			await this.handover('manual');
			if (!this.paused) await this.wake('Übergabe beendet');
		}
		const pause = await exists('pause');
		if (pause && !this.paused) {
			this.paused = true;
			this.log.info('Pausiert: keine neuen Aufträge, laufende werden übergeben');
			await this.handover('manual');
		} else if (!pause && this.paused) {
			this.paused = false;
			this.log.info('Pause beendet');
			await this.wake('Pause beendet');
		}
	}

	/** Zustand für `atrium-runner status` und die PC-Oberfläche schreiben (best effort) */
	async writeState(opts: { onlyIfChanged?: boolean } = {}): Promise<void> {
		const body = {
			pid: process.pid,
			name: this.o.config.name,
			version: RUNNER_VERSION,
			kind: this.kind,
			status: this.status,
			runnerId: this.runnerId,
			paused: this.executor.handoverReason,
			pausedByUser: this.paused,
			runs: this.executor.runIds(),
			lastHeartbeatAt: this.lastHeartbeatAt,
			startedAt: this.startedAt,
			power: this.powerName,
			atriumUrl: this.o.config.atriumUrl,
			atrium: this.atriumState,
			maxSlots: this.o.config.maxSlots,
			details: this.executor.runSummaries(),
			accounts: this.o.config.accounts.map((a) => {
				const st = this.accounts.get(a.key);
				return {
					key: a.key,
					provider: a.provider,
					label: a.label ?? '',
					ok: st?.ok ?? false,
					loggedIn: st?.loggedIn ?? false,
					version: st?.version ?? '',
					message: this.o.redactor.redact(st?.message ?? '').slice(0, 300)
				};
			})
		};
		const sig = JSON.stringify(body);
		if (opts.onlyIfChanged && sig === this.lastStateSig) return;
		this.lastStateSig = sig;
		const state: RunnerStateFile = { ...body, updatedAt: new Date().toISOString() };
		try {
			await writeFile(stateFile(this.o.config.workDir), JSON.stringify(state, null, 2));
		} catch {
			// Arbeitsverzeichnis nicht beschreibbar
		}
	}

	/** Energieüberwachung starten (PC-Runner bzw. `POWER_EVENTS`) */
	private async startPower(): Promise<void> {
		const monitor =
			this.o.powerMonitor !== undefined ? this.o.powerMonitor : this.o.config.powerEvents ? defaultPowerMonitor() : null;
		if (!monitor) return;
		const ok = await monitor.start((e) => this.onPower(e));
		if (!ok) {
			this.log.warn('Standby/Herunterfahren werden nicht erkannt – Atrium übernimmt nach dem Heartbeat-Zeitlimit');
			return;
		}
		this.power = monitor;
		this.powerName = monitor.name;
		this.log.info(`Energie-Ereignisse werden beobachtet (${monitor.name})`);
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
		this.instanceId = await loadInstanceId(this.o.config.workDir).catch((e: unknown) => {
			this.log.warn('Installations-Kennung nicht lesbar', errorMessage(e));
			return null;
		});
		const [git, ghOk, ptyOk] = await Promise.all([hasCommand('git'), hasCommand('gh'), this.pty.available()]);
		this.capabilities = { question: true, branchDelivery: true, prUpdate: true, limitReport: true, attachments: true, handoff: true, fencing: true, wip: true, branchCleanup: git && ghOk, git, gh: ghOk, pty: ptyOk, os: `${os.platform()}-${os.arch()}`.slice(0, 40) };
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

		await mkdir(controlDir(this.o.config.workDir), { recursive: true });
		const control = setInterval(() => void this.pollControl().catch((e: unknown) => this.log.warn('Steuerdatei', errorMessage(e))), this.o.controlPollMs ?? 2000);
		control.unref();
		this.timers.push(control);
		await this.startPower();
		await this.writeState();
		// PC-Oberfläche: Tätigkeit der Läufe zeitnah sichtbar (nur bei Änderungen schreiben)
		const stateTimer = setInterval(() => void this.writeState({ onlyIfChanged: true }), this.o.stateWriteMs ?? 3000);
		stateTimer.unref();
		this.timers.push(stateTimer);

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

	/**
	 * Beenden: keine neuen Läufe, Terminals schließen. Mit `drainSec` (Konfiguration `DRAIN_SEC`) dürfen laufende
	 * Läufe bis dahin fertig werden; Atrium bietet dem Runner in der Zeit nichts mehr an. `skipDrain` (z. B. zweites
	 * Signal) bricht die Frist ab. Danach werden noch laufende Läufe mit `cancelled` abgeschlossen und neu eingeplant.
	 */
	async shutdown(opts: { drainSec?: number; skipDrain?: AbortSignal } = {}): Promise<void> {
		const drainSec = opts.drainSec ?? this.o.config.drainSec ?? 0;
		this.log.info('Runner wird beendet …');
		this.pty.closeAll();
		// PC-Runner (z. B. SIGTERM beim Herunterfahren): nicht warten, sondern sofort übergeben
		if (this.kind === 'desktop' && this.executor.slotsUsed > 0 && !opts.drainSec) {
			await this.handover('shutdown', this.power?.graceMs ?? null);
		}
		await this.power?.stop();
		if (drainSec > 0 && this.executor.slotsUsed > 0 && !opts.skipDrain?.aborted) {
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
		if (this.shutdownResumeTimer) clearTimeout(this.shutdownResumeTimer);
		await this.executor.shutdown();
		this.stop.abort();
	}
}

export { Redactor };
