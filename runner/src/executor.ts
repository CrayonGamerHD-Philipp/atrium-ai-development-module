/**
 * Ausführung der Läufe: Slots, Annahme/Ablehnung von Angeboten, Ablauf je Lauf (Worktree → setupCmd → Agent →
 * Commit/Tests/Auslieferung → finish), Abbruch, Zeitlimit, Heartbeat-Daten.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
	assertAttachmentsUntracked,
	ATTACHMENTS_DIR,
	attachmentPromptHint,
	excludeAidevDir,
	storeAttachments
} from './attachments.ts';
import { accountEnv, publicEnv, type AccountConfig, type RunnerConfig } from './config.ts';
import { ApiError, EventBatcher, type RunnerApi } from './client.ts';
import {
	assertPullUpdatable,
	commentOnPull,
	commitAll,
	commitInfos,
	countCommits,
	DeliveryError,
	deliverDirect,
	deliverIntegrate,
	discardChanges,
	enableAutoMerge,
	ensurePullRequest,
	fetchPullContext,
	headSha,
	pullCommentBody,
	pullUrl,
	pushBranch,
	syncPullBranch,
	type PullContext
} from './git/delivery.ts';
import { abortMerge, concludeMerge, mergeInProgress, startMerge, unresolvedFiles } from './git/conflicts.ts';
import { assertRefName, GitError } from './git/git.ts';
import { deleteWip, fetchWip, pushWip, restoreWip, snapshotWip, wipUsable } from './git/wip.ts';
import type { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { extractPlan } from './plan.ts';
import type { AdapterRegistry } from './providers/index.ts';
import {
	ResearchBridge,
	RESEARCH_DIR,
	researchPromptSection,
	researchSystemPrompt,
	researchTaskPrompt,
	TOOLS_DIR,
	type ResearchRequest
} from './research.ts';
import { ResearchCache } from './research.ts';
import { repoMap, repoMapSection } from './repomap.ts';
import {
	addUsage,
	conflictRepairPrompt,
	isTransientAgentError,
	resumeAfterErrorPrompt,
	tailText,
	testRepairPrompt,
	TRANSIENT_RETRIES,
	unresolvedPrompt
} from './selfheal.ts';
import { LimitStore, limitHitWindow } from './providers/limit-snapshot.ts';
import type { AgentLimit, AgentResult, AgentUsage } from './providers/types.ts';
import type { FinishInput, HandoffReason, RunEventKind, RunOffer } from './protocol.ts';
import type { Redactor } from './redact.ts';
import { backoffMs, errorMessage, sleep } from './util/async.ts';
import { exec } from './util/proc.ts';

type ErrorKind = NonNullable<FinishInput['errorKind']>;

/** Fehler mit Fehlerart für `finish` */
export class RunError extends Error {
	constructor(
		readonly kind: ErrorKind,
		message: string,
		readonly conflictFiles: string[] = []
	) {
		super(message);
		this.name = 'RunError';
	}
}

/**
 * `handover`: Übergabe vor Standby/Herunterfahren (Zwischenstand sichern, als übergeben melden),
 * `revoked`: Lease verloren (z. B. nach dem Aufwachen) – nichts mehr pushen und nichts mehr melden
 */
type AbortReason = 'cancel' | 'timeout' | 'shutdown' | 'limit' | 'handover' | 'revoked';

interface ActiveRun {
	offer: RunOffer;
	ctrl: AbortController;
	reason: AbortReason | null;
	cancelMessage: string;
	done: Promise<void>;
	/** Übergabe: Anlass und Frist (ms seit Epoch) */
	handover?: { reason: HandoffReason; deadline: number };
	/** Pfade, die nie committet werden (Anhänge, Recherche-Dateien) */
	exclude?: string[];
	/** Annahme (ms seit Epoch) */
	startedAt: number;
	/** Letzte Tätigkeit (bereinigt, eine Zeile) für die PC-Oberfläche */
	activity: { kind: RunEventKind; text: string; at: number } | null;
}

/** Limit des Anbieters im Agent-Aufruf erreicht (kein Fehler des Laufs: `finish.status = limited`) */
class LimitStop extends Error {
	constructor(
		readonly limit: AgentLimit,
		readonly lastText: string
	) {
		super(`Limit erreicht (${limit.limitKind})`);
		this.name = 'LimitStop';
	}
}

/** Laufender Lauf für Zustandsdatei und PC-Oberfläche (keine Geheimnisse, Texte bereinigt) */
export interface RunSummary {
	runId: string;
	taskId: string;
	title: string;
	role: string;
	repo: string;
	branch: string;
	account: string;
	provider: string;
	model: string | null;
	startedAt: string;
	handover: HandoffReason | null;
	activity: { kind: string; text: string; at: string } | null;
}

/** Ein Ereignis als kurze Tätigkeitszeile (Text, Werkzeug, git-Schritt); `null` = nicht anzeigen */
export function activityText(kind: RunEventKind, payload: Record<string, unknown>): string | null {
	const pick = (...keys: string[]) => {
		for (const k of keys) {
			const v = payload[k];
			if (typeof v === 'string' && v.trim()) return v;
		}
		return null;
	};
	let text: string | null;
	if (kind === 'tool') {
		const name = pick('name', 'tool');
		const detail = pick('summary', 'input', 'detail', 'text');
		text = name ? `${name}${detail ? `: ${detail}` : ''}` : detail;
	} else if (kind === 'git') {
		const action = pick('action');
		const detail = pick('detail', 'text');
		text = action ? `git ${action}${detail ? `: ${detail}` : ''}` : detail;
	} else {
		text = pick('text', 'detail', 'message');
	}
	if (!text) return null;
	const line = text.replace(/\s+/g, ' ').trim();
	return line ? line.slice(0, 200) : null;
}

/** Lease des Laufs verloren (Fencing): nichts pushen, nichts mehr melden */
export class LeaseLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LeaseLostError';
	}
}

/** Fähigkeiten von Atrium aus der Anmeldung (`registerResult.features`) */
export interface AtriumFeatures {
	handoff?: boolean;
	fencing?: boolean;
	checkpoints?: boolean;
}

export interface AccountState {
	config: AccountConfig;
	loggedIn: boolean;
	ok: boolean;
	version: string;
	message?: string;
}

export interface ExecutorOptions {
	config: RunnerConfig;
	api: RunnerApi;
	workspace: Workspace;
	adapters: AdapterRegistry;
	redactor: Redactor;
	accounts: () => Map<string, AccountState>;
	log?: Logger;
	/** Gemeinsamer Limit-Stand je Konto (Heartbeat); Standard: eigener Speicher */
	limits?: LimitStore;
	/** Gnadenfrist für Batcher in Tests */
	batcherFlushMs?: number;
	/** Fähigkeiten von Atrium (Standard: keine Erweiterung bekannt) */
	features?: () => AtriumFeatures;
	/** Grundwartezeit vor einem neuen Versuch nach vorübergehenden Agent-Fehlern (ms, Standard 5000; Tests kürzer) */
	retryBaseMs?: number;
	/** Abfrageintervall der Recherche-Schnittstelle (ms, Standard 500) */
	researchPollMs?: number;
}

/** Ausgabe eines Projektbefehls (Exit-Code und Ende der Ausgabe für Reparaturaufträge) */
interface ShellResult {
	code: number | null;
	output: string;
}

const NO_CHANGES = 'Keine Änderungen – der Agent hat nichts geändert, daher kein Commit und kein PR.';

export class Executor {
	private readonly running = new Map<string, ActiveRun>();
	/** Kürzlich bearbeitete Läufe (doppelte Angebote über `/pending` ignorieren) */
	private readonly seen = new Map<string, number>();
	private stopping = false;
	/** Übergabe läuft bzw. pausiert: keine neuen Läufe */
	private pausedFor: HandoffReason | null = null;
	private readonly log: Logger;
	/** Zuletzt beobachteter Limit-Stand je Konto und Fenster */
	readonly limits: LimitStore;

	constructor(private readonly o: ExecutorOptions) {
		this.log = o.log ?? silentLogger;
		this.limits = o.limits ?? new LimitStore();
	}

	get slotsUsed(): number {
		return this.running.size;
	}

	runIds(): string[] {
		return [...this.running.keys()];
	}

	/** Laufende Läufe für Zustandsdatei und PC-Oberfläche */
	runSummaries(): RunSummary[] {
		return [...this.running.values()].map((r) => ({
			runId: r.offer.runId,
			taskId: r.offer.taskId,
			title: r.offer.title,
			role: r.offer.role,
			repo: `${r.offer.project.repoOwner}/${r.offer.project.repoName}`,
			branch: r.offer.branch,
			account: r.offer.account.key,
			provider: r.offer.account.provider,
			model: r.offer.model,
			startedAt: new Date(r.startedAt).toISOString(),
			handover: r.handover?.reason ?? null,
			activity: r.activity
				? { kind: r.activity.kind, text: r.activity.text, at: new Date(r.activity.at).toISOString() }
				: null
		}));
	}

	isRunning(runId: string): boolean {
		return this.running.has(runId);
	}

	/** Angebot annehmen oder ablehnen; startet den Lauf im Hintergrund */
	async handleOffer(offer: RunOffer): Promise<'accepted' | 'rejected' | 'ignored'> {
		const now = Date.now();
		for (const [id, t] of this.seen) if (now - t > 3_600_000) this.seen.delete(id);
		if (this.running.has(offer.runId) || this.seen.has(offer.runId)) return 'ignored';
		this.seen.set(offer.runId, now);

		const reject = async (reason: string) => {
			this.log.info(`Angebot ${offer.runId} abgelehnt: ${reason}`);
			try {
				await this.o.api.reject(offer.runId, reason);
			} catch (e) {
				this.log.warn('Ablehnen fehlgeschlagen', errorMessage(e));
			}
			return 'rejected' as const;
		};

		if (this.stopping) return reject('Runner wird beendet');
		if (this.pausedFor) return reject('Runner übergibt bzw. ist pausiert');
		if (this.running.size >= this.o.config.maxSlots) return reject('Keine freien Slots');
		const acct = this.o.accounts().get(offer.account.key);
		if (!acct || acct.config.provider !== offer.account.provider)
			return reject(`Unbekanntes Konto „${offer.account.key}“`);
		if (!acct.ok) return reject(`CLI für Konto „${offer.account.key}“ nicht verfügbar`);
		if (!acct.loggedIn) return reject(`Konto „${offer.account.key}“ ist nicht angemeldet`);
		if ((offer.delivery.mode === 'branch' || offer.delivery.mode === 'pr-update') && offer.branch === offer.project.defaultBranch)
			return reject('Der Ergebnis-Branch darf nicht der Haupt-Branch sein');
		try {
			assertRefName(offer.branch);
			assertRefName(offer.baseRef, 'Basis');
			assertRefName(offer.project.defaultBranch, 'Haupt-Branch');
			if (offer.delivery.mode === 'integrate') assertRefName(offer.delivery.integrationBranch, 'Integrations-Branch');
		} catch (e) {
			return reject(errorMessage(e));
		}

		// Slot vor dem (asynchronen) accept reservieren
		const ctrl = new AbortController();
		const run: ActiveRun = { offer, ctrl, reason: null, cancelMessage: '', done: Promise.resolve(), startedAt: Date.now(), activity: null };
		this.running.set(offer.runId, run);
		try {
			await this.o.api.accept(offer.runId);
		} catch (e) {
			this.running.delete(offer.runId);
			this.log.warn(`Annahme von ${offer.runId} fehlgeschlagen`, errorMessage(e));
			return 'ignored';
		}
		// Ein während der Annahme eingetroffener Abbruch wird im Ablauf über `checkAbort` behandelt
		this.log.info(`Lauf ${offer.runId} angenommen (${offer.role}, ${offer.account.key})`);
		run.done = this.execute(run, acct.config)
			.catch((e: unknown) => this.log.error(`Lauf ${offer.runId}: interner Fehler`, errorMessage(e)))
			.finally(() => this.running.delete(offer.runId));
		return 'accepted';
	}

	/** Lauf abbrechen (Befehl `cancel` bzw. Heartbeat-Antwort) */
	cancel(runId: string, message = 'Abgebrochen'): boolean {
		const run = this.running.get(runId);
		if (!run) return false;
		if (!run.reason) {
			run.reason = 'cancel';
			run.cancelMessage = message;
		}
		run.ctrl.abort();
		return true;
	}

	/**
	 * Übergabe aller laufenden Läufe (Standby, Herunterfahren, „jetzt übergeben“): Agents stoppen, Zwischenstand
	 * als WIP-Commit auf `refs/aidev/wip/<runId>` pushen (sofern Atrium Übergaben kennt und die Zeit reicht) und
	 * als übergeben melden. Wartet höchstens bis `deadline`; liefert die Zahl der übergebenen Läufe. Danach nimmt der
	 * Executor bis `resume()` nichts Neues an.
	 */
	async handover(reason: HandoffReason, deadline: number): Promise<number> {
		this.pausedFor = reason;
		const runs = [...this.running.values()];
		for (const run of runs) {
			if (run.reason) continue;
			run.reason = 'handover';
			run.cancelMessage = 'Übergabe an einen anderen Runner';
			run.handover = { reason, deadline };
			run.ctrl.abort();
		}
		const all = Promise.all(runs.map((r) => r.done));
		await Promise.race([all, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())).unref())]);
		return runs.length;
	}

	/** Nach Übergabe bzw. Aufwachen wieder Angebote annehmen */
	resume(): void {
		this.pausedFor = null;
	}

	/** Übergabe läuft bzw. Runner pausiert (keine neuen Läufe) */
	get handoverReason(): HandoffReason | null {
		return this.pausedFor;
	}

	/**
	 * Lauf verwerfen, dessen Lease nicht mehr gilt (Fencing, z. B. nach dem Aufwachen): Agent stoppen, nichts
	 * pushen, nichts melden. Der Worktree bleibt und wird später aufgeräumt.
	 */
	revoke(runId: string, message: string): boolean {
		const run = this.running.get(runId);
		if (!run) return false;
		run.reason = 'revoked';
		run.cancelMessage = message;
		run.ctrl.abort();
		return true;
	}

	/** Laufende Läufe mit Fencing-Token (Lease-Prüfung) */
	leaseRuns(): { runId: string; fence?: number }[] {
		return [...this.running.values()].map((r) =>
			r.offer.fence === undefined ? { runId: r.offer.runId } : { runId: r.offer.runId, fence: r.offer.fence }
		);
	}

	/**
	 * Lease eines Laufs vor einem Push prüfen (nur wenn Atrium Fencing kennt). Ungültig → `LeaseLostError`.
	 * Ist Atrium nicht erreichbar, wird ebenfalls nicht gepusht (der Lauf gilt dann als abgebrochen).
	 */
	async assertLease(offer: RunOffer): Promise<void> {
		if (!this.o.features?.().fencing) return;
		let res;
		try {
			res = await this.o.api.leases({ runs: [offer.fence === undefined ? { runId: offer.runId } : { runId: offer.runId, fence: offer.fence }] });
		} catch (e) {
			throw new RunError('cancelled', `Lease konnte nicht geprüft werden – nichts gepusht (${errorMessage(e)})`);
		}
		if (!res.valid.includes(offer.runId)) {
			const why = res.revoked.find((r) => r.runId === offer.runId)?.reason ?? 'Lease ungültig';
			const run = this.running.get(offer.runId);
			if (run) run.reason = 'revoked';
			throw new LeaseLostError(`${why} – nichts gepusht`);
		}
	}

	/** Wird der Runner beendet (keine neuen Läufe)? */
	get isStopping(): boolean {
		return this.stopping;
	}

	/**
	 * Keine neuen Läufe annehmen und bis zu `timeoutMs` warten, bis die laufenden fertig sind (bzw. `signal`
	 * auslöst). Liefert die Zahl der danach noch laufenden Läufe.
	 */
	async drain(timeoutMs: number, signal?: AbortSignal): Promise<number> {
		this.stopping = true;
		const deadline = Date.now() + Math.max(0, timeoutMs);
		const aborted = new Promise<void>((resolve) => {
			if (signal?.aborted) resolve();
			signal?.addEventListener('abort', () => resolve(), { once: true });
		});
		// Abfrage statt `run.done`: während der Annahme ist `done` noch ein erfüllter Platzhalter
		while (this.running.size && Date.now() < deadline && !signal?.aborted) {
			const tick = new Promise<void>((resolve) =>
				setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))).unref()
			);
			await Promise.race([tick, aborted]);
		}
		return this.running.size;
	}

	/** Keine neuen Läufe; laufende abbrechen (finish `cancelled`), Worktrees bleiben */
	async shutdown(timeoutMs = 30_000): Promise<void> {
		this.stopping = true;
		for (const run of this.running.values()) {
			if (!run.reason) {
				run.reason = 'shutdown';
				run.cancelMessage = 'Runner wird beendet';
			}
			run.ctrl.abort();
		}
		const all = Promise.all([...this.running.values()].map((r) => r.done));
		await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
	}

	/** Wartet, bis alle laufenden Läufe beendet sind (Tests) */
	async idle(): Promise<void> {
		while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.done));
	}

	// ---------------------------------------------------------------- Ablauf eines Laufs

	private async execute(run: ActiveRun, acct: AccountConfig): Promise<void> {
		const { offer } = run;
		const { api, workspace: ws, redactor } = this.o;
		const log = this.log.child(offer.runId.slice(0, 8));
		const batcher = new EventBatcher({
			runId: offer.runId,
			api,
			redactor,
			log,
			flushMs: this.o.batcherFlushMs,
			fence: offer.fence
		});
		const emit = (kind: RunEventKind, payload: Record<string, unknown>) => {
			batcher.push(kind, payload);
			const text = activityText(kind, payload);
			if (text) run.activity = { kind, text: redactor.redact(text), at: Date.now() };
		};
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		const tmpDir = path.join(ws.tmpRoot, offer.runId);

		let sessionId: string | null = offer.resumeSessionId;
		let usage: AgentUsage | null = null;
		let limitPosted = false;
		/** Hat der Agent in diesem Lauf einen Limit-Stand gemeldet? */
		let streamLimits = false;
		const finish: FinishInput = {
			status: 'failed',
			sessionId: null,
			headSha: null,
			branch: null,
			commits: [],
			pr: null,
			merged: false,
			branchPushed: false,
			summary: null,
			errorKind: null,
			errorMessage: null,
			conflictFiles: []
		};
		if (offer.fence !== undefined) finish.fence = offer.fence;

		const timeoutMs = Math.max(1, offer.timeoutSec) * 1000;
		const timer = setTimeout(() => {
			if (!run.reason) run.reason = 'timeout';
			run.ctrl.abort();
		}, timeoutMs);
		timer.unref();
		const signal = run.ctrl.signal;
		const checkAbort = () => {
			if (signal.aborted) throw new RunError(run.reason === 'timeout' ? 'timeout' : 'cancelled', '');
		};

		const postLimit = async (l: AgentLimit) => {
			if (limitPosted) return;
			limitPosted = true;
			// Ohne Stand aus dem Stream: Fenster aus der Fehlermeldung ableiten (nur 5h/Woche)
			if (!streamLimits) {
				const w = limitHitWindow(l.limitKind, l.resetsAt);
				if (w) this.limits.update(acct.key, [w], 'error');
			}
			const windows = this.limits.snapshot(acct.key)?.windows;
			try {
				await api.limit(offer.runId, {
					kind: l.limitKind,
					resetsAt: l.resetsAt,
					raw: redactor.redact(l.raw).slice(0, 2000),
					...(windows?.length ? { windows } : {})
				});
			} catch (e) {
				log.warn('Limit-Meldung fehlgeschlagen', errorMessage(e));
			}
		};

		let wtDir: string | null = null;
		let pull: PullContext | null = null;
		let research: ResearchBridge | null = null;
		let stopCheckpoints = () => undefined as void;
		try {
			emit('status', { text: 'Repository wird vorbereitet' });
			// 0. Bestehender PR (pr-update): prüfen, bevor etwas geändert wird; Kontext für den Agent.
			// Teilauftrag einer PR-Orchestrierung: nur prüfen (Integrations-Branch = Head-Branch des PR).
			if (offer.delivery.mode === 'pr-update')
				pull = await this.loadPull(offer, offer.delivery.number, offer.branch, emit);
			else if (offer.delivery.mode === 'integrate' && offer.delivery.pullNumber !== undefined)
				await this.loadPull(offer, offer.delivery.pullNumber, offer.delivery.integrationBranch, emit);
			// 1. Worktree
			const prepared = await this.prepareWorktree(offer, emit);
			wtDir = prepared.dir;
			checkAbort();
			stopCheckpoints = this.startCheckpoints(run, wtDir, emit);

			const baseEnv = accountEnv(acct, process.env, {
				GIT_AUTHOR_NAME: this.o.config.gitAuthorName,
				GIT_AUTHOR_EMAIL: this.o.config.gitAuthorEmail,
				GIT_COMMITTER_NAME: this.o.config.gitAuthorName,
				GIT_COMMITTER_EMAIL: this.o.config.gitAuthorEmail,
				AIDEV_RUN_ID: offer.runId,
				AIDEV_TASK_ID: offer.taskId
			});

			// 2. setupCmd
			if (!offer.question && offer.project.setupCmd.trim()) {
				emit('status', { text: 'Projekt wird eingerichtet (setupCmd)' });
				const r = await this.shell(offer.project.setupCmd, wtDir, publicEnv(baseEnv), signal, timeoutMs, emit);
				checkAbort();
				if (r.code !== 0) throw new RunError('setup', `setupCmd fehlgeschlagen (Exit-Code ${r.code ?? 'unbekannt'})`);
			}

			// 2b. Anhänge nach `.aidev/attachments/` (nie committet, siehe `excludeAidevDir`)
			const hint = await this.prepareAttachments(offer, wtDir, signal, emit);
			checkAbort();

			// 2c. Recherche-Schnittstelle (`.aidev/bin/research.mjs`, nie committet)
			const dir = wtDir;
			const researchMax = this.o.config.researchMax ?? 3;
			if (this.o.config.research !== false && researchMax > 0 && !offer.question && offer.role !== 'research') {
				try {
					await ws.withRepo(repo, () => excludeAidevDir(ws, dir));
					const bridge = new ResearchBridge({
						worktree: dir,
						max: researchMax,
						pollMs: this.o.researchPollMs,
						handle: (req, s) =>
							this.research(offer, acct, dir, req, AbortSignal.any([signal, s]), emit, (u) => {
								usage = addUsage(usage, u);
							}),
						onError: (m) => emit('error', { text: `Recherche fehlgeschlagen: ${m}` })
					});
					await bridge.start();
					research = bridge;
				} catch (e) {
					log.warn('Recherche-Schnittstelle nicht verfügbar', errorMessage(e));
				}
			}
			const exclude = [
				...(offer.attachments?.length ? [ATTACHMENTS_DIR] : []),
				...(research ? [RESEARCH_DIR, TOOLS_DIR] : [])
			];
			run.exclude = exclude;

			// 3. Agent
			emit('status', { text: `Agent startet (${offer.account.provider}${offer.model ? `, ${offer.model}` : ''})` });
			await mkdir(tmpDir, { recursive: true });
			const adapter = this.o.adapters[acct.provider];
			// Repository-Übersicht (aus git, zwischengespeichert je Stand) – nicht bei fortgesetzter Sitzung, die kennt sie
			const map =
				this.o.config.repoMap !== false && !offer.resumeSessionId ? await repoMap(ws, repo, dir) : null;
			const prompt = [offer.prompt, hint, pull?.markdown, map ? repoMapSection(map) : null]
				.filter((p): p is string => !!p)
				.join('\n\n');
			const systemPrompt = research
				? `${offer.systemPrompt}\n${researchPromptSection({ max: researchMax })}`
				: offer.systemPrompt;
			const model = offer.model ?? (acct.provider === 'openai-api' ? (acct.model ?? null) : null);
			const repairRounds = this.o.config.autoRepairRounds ?? 2;
			const repairNotes: string[] = [];
			let turnNo = 0;

			/** Ein Aufruf des Agents; Limit → `LimitStop`, Abbruch/Zeitlimit → `RunError` */
			const turn = async (text: string, resume: string | null): Promise<AgentResult> => {
				turnNo++;
				const proc = adapter.start({
					cwd: dir,
					prompt: text,
					systemPrompt,
					model,
					resumeSessionId: resume,
					env: baseEnv,
					readOnly: offer.readOnly,
					question: offer.question === true,
					signal,
					account: acct,
					tmpDir: turnNo === 1 ? tmpDir : path.join(tmpDir, `turn-${turnNo}`)
				});
				let limit: AgentLimit | null = null;
				let turnUsage: AgentUsage | null = null;
				for await (const ev of proc.events) {
					if (ev.kind === 'usage') turnUsage = ev.usage;
					else if (ev.kind === 'session') sessionId = ev.id;
					else if (ev.kind === 'limits') {
						streamLimits = true;
						this.limits.update(acct.key, ev.windows, 'stream');
					} else if (ev.kind === 'limit') {
						if (!limit) {
							limit = { limitKind: ev.limitKind, resetsAt: ev.resetsAt, raw: ev.raw };
							emit('error', { text: `Limit erreicht (${ev.limitKind})${ev.resetsAt ? `, zurückgesetzt ${ev.resetsAt}` : ''}` });
							await postLimit(limit);
							if (!run.reason) run.reason = 'limit';
							proc.kill();
						}
					} else emit(ev.kind, ev.payload);
				}
				const result: AgentResult = await proc.done;
				usage = addUsage(usage, result.usage ?? turnUsage);
				if (result.sessionId) sessionId = result.sessionId;
				limit = limit ?? result.limit;
				if (limit) {
					await postLimit(limit);
					if (limit.limitKind === 'auth') throw new RunError('auth', 'Konto nicht (mehr) angemeldet');
					throw new LimitStop(limit, result.lastText);
				}
				if (run.reason === 'timeout') throw new RunError('timeout', `Zeitlimit von ${offer.timeoutSec} s überschritten`);
				if (run.reason) throw new RunError('cancelled', run.cancelMessage || 'Abgebrochen');
				return result;
			};
			const canResume = () => adapter.resumable === true && !!sessionId;

			/** Agent-Aufruf mit Wiederholung bei vorübergehenden Fehlern (Überlastung, 5xx, Netzwerk) */
			const agentTurn = async (text: string, resume: string | null): Promise<AgentResult> => {
				let r = await turn(text, resume);
				for (let retry = 1; r.exitCode !== 0 && retry <= TRANSIENT_RETRIES && repairRounds > 0; retry++) {
					if (!isTransientAgentError(`${r.error ?? ''}\n${r.lastText}`)) break;
					emit('status', { text: `Vorübergehender Fehler des Agents – neuer Versuch ${retry}/${TRANSIENT_RETRIES}` });
					await sleep(backoffMs(retry, this.o.retryBaseMs ?? 5000, 60_000), signal);
					checkAbort();
					r = canResume()
						? await turn(resumeAfterErrorPrompt(r.error ?? r.lastText), sessionId)
						: await turn(text, resume);
					if (r.exitCode === 0)
						repairNotes.push(`Vorübergehender Fehler des Agents nach ${retry} Wiederholung(en) überbrückt.`);
				}
				if (r.exitCode !== 0)
					throw new RunError('agent', r.error ?? `Agent beendet mit Exit-Code ${r.exitCode ?? 'unbekannt'}`);
				return r;
			};
			/** Reparaturauftrag im selben Worktree: Sitzung fortsetzen (sonst ursprünglicher Auftrag + Reparatur) */
			const repairTurn = (text: string): Promise<AgentResult> =>
				canResume() ? agentTurn(text, sessionId) : agentTurn(`${prompt}\n\n${text}`, null);

			const d = offer.delivery;
			const mergeBase = d.mode === 'integrate' ? d.integrationBranch : offer.project.defaultBranch;
			const mergeMessage = (label: string) => `Merge ${label} (Konfliktlösung)\n\nAidev-Task: ${offer.taskId}`;
			const resolveDone = async (label: string, files: string[], round: number, text: string) => {
				await concludeMerge(ws, dir, mergeMessage(label), exclude);
				emit('git', { action: 'merge', detail: `Konflikt mit ${label} vom Agent gelöst (Runde ${round})` });
				repairNotes.push(
					`Merge-Konflikt mit ${label} eigenständig gelöst (${files.join(', ')})` +
						(text ? `:\n  ${tailText(text, 1500).replace(/\n/g, '\n  ')}` : '')
				);
			};
			/**
			 * `target` (SHA) in den Worktree mergen und Konflikte vom Agent lösen lassen (bis zu `repairRounds`
			 * Aufrufe). Mit `pending` läuft der Merge schon (der Agent hat einen Versuch hinter sich). Ungelöst →
			 * `RunError('conflict')` (Atrium plant dann eine Konfliktlösung bzw. fragt nach).
			 */
			const resolveConflicts = async (target: string, label: string, pending?: { files: string[]; text: string }): Promise<void> => {
				let files: string[];
				if (pending) {
					files = await unresolvedFiles(ws, dir, pending.files);
					if (!files.length) {
						if (await mergeInProgress(ws, dir)) await resolveDone(label, pending.files, 0, pending.text);
						return;
					}
				} else {
					const started = await startMerge(ws, dir, target, mergeMessage(label));
					if (started.clean) {
						emit('git', { action: 'merge', detail: `${label} ohne Konflikt hineingemergt` });
						return;
					}
					files = started.files;
					emit('git', {
						action: 'conflict',
						detail: `Konflikt mit ${label} in ${files.length} Datei(en) – Agent löst ihn: ${files.slice(0, 10).join(', ')}`
					});
				}
				const all = pending?.files ?? files;
				for (let round = 1; round <= repairRounds; round++) {
					const text =
						round === 1 && !pending
							? conflictRepairPrompt({ files, target: label, round, rounds: repairRounds, testCmd: offer.project.testCmd })
							: unresolvedPrompt(files);
					const r = await repairTurn(text);
					checkAbort();
					const left = await unresolvedFiles(ws, dir, all);
					if (!left.length) {
						await resolveDone(label, all, round, r.lastText);
						return;
					}
					files = left;
				}
				await abortMerge(ws, dir);
				throw new RunError('conflict', `Konflikt mit ${label} konnte im Lauf nicht gelöst werden`, files);
			};

			// 3a. Konfliktlösung (Rolle `resolve`): Ziel vor dem ersten Aufruf hineinmergen, damit die Konflikte
			// wirklich im Worktree stehen und der Agent sie gleich im ersten Durchgang löst
			let resolvePending: { target: string; label: string; files: string[] } | null = null;
			let firstPrompt = prompt;
			if (offer.role === 'resolve' && !offer.readOnly && repairRounds > 0) {
				await ws.ensureCache(repo, signal);
				const sha = await ws.revParse(dir, `refs/remotes/origin/${mergeBase}`);
				const label = `origin/${mergeBase}`;
				if (sha) {
					const started = await startMerge(ws, dir, sha, mergeMessage(label));
					if (started.clean) emit('git', { action: 'merge', detail: `${label} ohne Konflikt hineingemergt` });
					else {
						resolvePending = { target: sha, label, files: started.files };
						emit('git', {
							action: 'conflict',
							detail: `Konflikt mit ${label} in ${started.files.length} Datei(en): ${started.files.slice(0, 10).join(', ')}`
						});
						firstPrompt = `${prompt}\n\n${conflictRepairPrompt({ files: started.files, target: label, round: 1, rounds: repairRounds, testCmd: offer.project.testCmd })}`;
					}
				}
			}

			const first = await agentTurn(firstPrompt, offer.resumeSessionId);
			const summary = first.lastText || null;
			finish.summary = summary;

			// 4. Nur lesen
			if (offer.readOnly) {
				await discardChanges(ws, wtDir);
				if (offer.expectPlan) {
					const plan = extractPlan(summary ?? '');
					if (plan) finish.plan = plan;
					else emit('error', { text: 'Kein gültiger Plan in der Antwort gefunden' });
				}
				finish.status = 'succeeded';
				finish.headSha = await headSha(ws, wtDir);
				return;
			}

			// 4b. Konfliktlösung: Ergebnis des ersten Durchgangs prüfen, ggf. nachbessern lassen
			if (resolvePending)
				await resolveConflicts(resolvePending.target, resolvePending.label, {
					files: resolvePending.files,
					text: first.lastText
				});

			// 5. Schreibend: Commit
			// Anhangsablage und Recherche-Dateien nie in den Index aufnehmen (zusätzlich zu `info/exclude`)
			const committed = await commitAll(ws, wtDir, offer.title, offer.taskId, exclude);
			if (committed) emit('git', { action: 'commit', detail: 'Änderungen committet' });
			const newCommits = await countCommits(ws, wtDir, prepared.startSha);
			finish.branch = offer.branch;
			finish.headSha = await headSha(ws, wtDir);
			// Ein wiederaufgenommener oder zusammengeführter Branch kann bereits auszuliefernde Commits enthalten –
			// außer beim Head-Branch eines PR: dessen Stand liegt schon auf dem Remote.
			const pendingCommits =
				newCommits ||
				(offer.delivery.mode === 'pr-update' ? 0 : await countCommits(ws, wtDir, `origin/${offer.baseRef}`));
			// Abschluss einer PR-Orchestrierung: Die Teilaufträge haben schon in den PR-Branch gemergt
			const integratedOnly =
				pendingCommits === 0 && offer.delivery.mode === 'pr-update' && offer.delivery.integrated === true;
			if (pendingCommits === 0 && !integratedOnly) {
				emit('status', { text: NO_CHANGES });
				finish.status = 'succeeded';
				finish.summary = summary ? `${summary}\n\n(${NO_CHANGES})` : NO_CHANGES;
				return;
			}
			checkAbort();

			// Tests vor dem Push; schlagen sie fehl, bessert der Agent im selben Lauf nach (bis zu `repairRounds`)
			let testRounds = 0;
			const runTests = async (label: string, failure: string): Promise<void> => {
				if (!offer.project.testCmd.trim()) return;
				for (;;) {
					emit('status', { text: label });
					const r = await this.shell(offer.project.testCmd, dir, publicEnv(baseEnv), signal, timeoutMs, emit);
					checkAbort();
					if (r.code === 0) {
						if (testRounds) repairNotes.push(`Fehlgeschlagene Tests nach ${testRounds} Nachbesserung(en) behoben.`);
						return;
					}
					if (testRounds >= repairRounds) {
						finish.commits = await commitInfos(ws, dir, prepared.startSha);
						throw new RunError(
							'tests',
							`${failure} (Exit-Code ${r.code ?? 'unbekannt'})${testRounds ? ` – auch nach ${testRounds} Nachbesserung(en)` : ''} – nichts gepusht`
						);
					}
					testRounds++;
					emit('status', { text: `Tests fehlgeschlagen – Agent bessert nach (Runde ${testRounds}/${repairRounds})` });
					await repairTurn(
						testRepairPrompt({
							testCmd: offer.project.testCmd.trim(),
							exitCode: r.code,
							output: r.output,
							round: testRounds,
							rounds: repairRounds
						})
					);
					checkAbort();
					if (await commitAll(ws, dir, `${offer.title} (Nachbesserung Tests)`, offer.taskId, exclude))
						emit('git', { action: 'commit', detail: 'Nachbesserung committet' });
				}
			};
			await runTests('Tests laufen (testCmd)', 'Tests fehlgeschlagen');

			// PR/Branch: Konflikte mit dem Haupt-Branch vorab lösen, damit der PR mergebar bleibt
			if ((d.mode === 'pr' || d.mode === 'branch') && repairRounds > 0) {
				await ws.ensureCache(repo, signal);
				const sha = await ws.revParse(dir, `refs/remotes/origin/${mergeBase}`);
				if (sha && (await wouldConflict(ws, dir, sha))) {
					// Best effort: Gelingt es nicht, wird wie bisher ausgeliefert (PR zeigt den Konflikt)
					try {
						await resolveConflicts(sha, `origin/${mergeBase}`);
						await runTests('Tests laufen erneut (testCmd, nach Konfliktlösung)', 'Tests nach Konfliktlösung fehlgeschlagen');
					} catch (e) {
						if (!(e instanceof RunError) || e.kind !== 'conflict') throw e;
						emit('error', { text: `${e.message} – ${d.mode === 'pr' ? 'PR' : 'Branch'} wird trotzdem ausgeliefert` });
					}
				}
			}
			/** Endgültiger Konflikt bei „direkt“: Arbeitsstand auf dem Auftrags-Branch sichern (für die Konfliktlösung) */
			const keepWork = async () => {
				if (d.mode !== 'direct' || offer.branch === offer.project.defaultBranch) return;
				try {
					await abortMerge(ws, dir);
					await pushBranch(ws, repo, dir, offer.branch, prepared.remoteSha, emit);
					emit('git', { action: 'push', detail: `Arbeitsstand für die Konfliktlösung auf ${offer.branch} gesichert` });
				} catch (e) {
					log.warn('Arbeitsstand konnte nicht gesichert werden', errorMessage(e));
				}
			};

			// Auslieferung – nur mit gültiger Lease (Fencing: ein aufgewachter PC pusht nie einen übernommenen Lauf).
			// Konflikte beim Ausliefern löst der Agent im selben Lauf; danach wird erneut getestet und ausgeliefert.
			stopCheckpoints();
			let commitBase = prepared.startSha;
			for (let conflictRound = 0; ; conflictRound++) {
				await this.assertLease(offer);
				checkAbort();
				try {
					commitBase = await this.deliver(offer, dir, prepared, { summary, integratedOnly, pull, finish, runTests, emit });
					break;
				} catch (e) {
					if (!(e instanceof DeliveryError) || e.kind !== 'conflict' || !e.target) throw e;
					if (conflictRound >= repairRounds) {
						await keepWork();
						throw e;
					}
					emit('status', {
						text: `Konflikt beim Ausliefern – Agent löst ihn (Runde ${conflictRound + 1}/${repairRounds})`
					});
					const label = d.mode === 'pr-update' ? `origin/${offer.branch}` : `origin/${mergeBase}`;
					try {
						await resolveConflicts(e.target, label);
					} catch (re) {
						if (re instanceof RunError && re.kind === 'conflict') await keepWork();
						throw re;
					}
					await runTests('Tests laufen erneut (testCmd, nach Konfliktlösung)', 'Tests nach Konfliktlösung fehlgeschlagen');
				}
			}
			finish.headSha = await headSha(ws, wtDir);
			finish.commits = await commitInfos(ws, wtDir, commitBase);
			finish.status = 'succeeded';
			if (repairNotes.length)
				finish.summary = `${finish.summary ?? ''}\n\n---\n**Automatisch im selben Lauf nachgebessert:**\n${repairNotes.map((n) => `- ${n}`).join('\n')}`.trim();
			// fortgesetzten Zwischenstand aufräumen (best effort; der eigene Ref wird nicht mehr gebraucht)
			if (prepared.resumedWip) await deleteWip(ws, repo, wtDir, prepared.resumedWip).catch(() => false);
		} catch (e) {
			if (e instanceof LimitStop) {
				finish.status = 'limited';
				finish.errorKind = 'limit';
				finish.errorMessage = e.message;
				finish.summary = finish.summary ?? (e.lastText || null);
				return;
			}
			const err = toRunError(e, run);
			finish.status = err.kind === 'cancelled' ? 'cancelled' : 'failed';
			finish.errorKind = err.kind;
			finish.errorMessage = redactor.redact(err.message || (err.kind === 'cancelled' ? run.cancelMessage || 'Abgebrochen' : 'Fehler')).slice(0, 4000);
			finish.conflictFiles = err.conflictFiles.slice(0, 200);
			if (err.kind === 'internal') log.error('Interner Fehler', e instanceof Error ? (e.stack ?? e.message) : e);
			emit('error', { text: finish.errorMessage });
			if (wtDir && !finish.headSha) finish.headSha = await headSha(ws, wtDir).catch(() => null);
			if (run.reason === 'handover' && run.handover) {
				finish.status = 'cancelled';
				finish.errorKind = 'cancelled';
				finish.handoff = await this.saveHandover(run, wtDir, emit);
				finish.errorMessage = finish.handoff.wipPushed
					? 'Übergabe: Zwischenstand gesichert'
					: 'Übergabe ohne gesicherten Zwischenstand';
			}
		} finally {
			clearTimeout(timer);
			stopCheckpoints();
			await research?.stop().catch(() => undefined);
			await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
			finish.sessionId = sessionId ? sessionId.slice(0, 200) : null;
			if (finish.summary) finish.summary = redactor.redact(finish.summary).slice(0, 40_000);
			if (finish.headSha && !/^[0-9a-f]{7,40}$/.test(finish.headSha)) finish.headSha = null;
			if (finish.pr && !/^https?:\/\//.test(finish.pr.url)) finish.pr = null;
			finish.commits = finish.commits.slice(-200);
			if (run.reason === 'revoked') {
				// Lease verloren: Atrium lehnt Meldungen ohnehin ab (409) – nichts mehr senden, Worktree bleibt
				log.warn(`Lauf verworfen: ${run.cancelMessage || 'Lease verloren'}`);
				await batcher.close();
			} else {
				await this.report(run, finish, usage, batcher, log);
			}
		}
	}

	/** Abschluss melden: Status-Ereignis, Ereignisse leeren, Verbrauch, `finish` */
	private async report(
		run: ActiveRun,
		finish: FinishInput,
		usage: AgentUsage | null,
		batcher: EventBatcher,
		log: Logger
	): Promise<void> {
		const { offer } = run;
		const api = this.o.api;
		batcher.push('status', { text: statusText(finish) });
		await batcher.close();
		// Übergabe: Abschluss zuerst (kurze Frist), Verbrauch danach, falls noch Zeit bleibt
		if (run.handover) await this.sendFinish(run, finish, log);
		if (usage) {
			try {
				await api.usage(offer.runId, {
					model: (usage.model || offer.model || '').slice(0, 120),
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					costUsd: usage.costUsd
				});
			} catch (e) {
				log.warn('Verbrauchsmeldung fehlgeschlagen', errorMessage(e));
			}
		}
		if (!run.handover) await this.sendFinish(run, finish, log);
	}

	private async sendFinish(run: ActiveRun, finish: FinishInput, log: Logger): Promise<void> {
		try {
			// Übergabe: kurze Frist (das Betriebssystem wartet nur wenige Sekunden)
			const left = run.handover ? Math.max(1000, run.handover.deadline - Date.now()) : undefined;
			await this.o.api.finish(run.offer.runId, finish, left ? { attempts: 2, timeoutMs: left } : {});
			log.info(`Lauf beendet: ${finish.status}${finish.errorKind ? ` (${finish.errorKind})` : ''}`);
		} catch (e) {
			log.error('Abschlussmeldung fehlgeschlagen', errorMessage(e));
		}
	}

	/**
	 * Übergabe: Zwischenstand des Worktrees als WIP-Commit auf `refs/aidev/wip/<runId>` pushen, solange die Frist
	 * reicht (nur schreibende Läufe und nur, wenn Atrium Übergaben kennt). Fehlschläge sind kein Fehler des Laufs –
	 * der Nachfolger startet dann vom letzten gepushten Stand.
	 */
	private async saveHandover(
		run: ActiveRun,
		dir: string | null,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<NonNullable<FinishInput['handoff']>> {
		const { offer } = run;
		const reason = run.handover!.reason;
		const out: NonNullable<FinishInput['handoff']> = { reason, wipPushed: false, headSha: null, wipRef: null, note: null };
		if (!dir || offer.readOnly || offer.question || !this.o.features?.().handoff) return out;
		// etwas Zeit für die Abschlussmeldung lassen
		const budget = run.handover!.deadline - Date.now() - 1500;
		if (budget < 1000) {
			out.note = 'Keine Zeit für einen Zwischenstand';
			return out;
		}
		const ws = this.o.workspace;
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), budget);
		timer.unref();
		try {
			const exclude = run.exclude ?? (offer.attachments?.length ? [ATTACHMENTS_DIR] : []);
			const snap = await snapshotWip(ws, dir, { runId: offer.runId, taskId: offer.taskId, reason, exclude, signal: ctrl.signal });
			await pushWip(ws, repo, dir, snap, { timeoutMs: Math.max(1000, budget), signal: ctrl.signal });
			out.wipPushed = true;
			out.headSha = snap.sha;
			out.wipRef = snap.ref;
			emit('git', { action: 'wip', detail: `Zwischenstand gesichert (${snap.ref}, ${snap.sha.slice(0, 10)})` });
		} catch (e) {
			out.note = `Zwischenstand nicht gesichert: ${errorMessage(e)}`.slice(0, 4000);
			emit('error', { text: out.note });
		} finally {
			clearTimeout(timer);
		}
		return out;
	}

	/**
	 * Regelmäßige WIP-Checkpoints während eines laufenden Laufs (`wipCheckpointMin`, nur schreibende Läufe und nur,
	 * wenn Atrium Checkpoints kennt): Bei einem harten Ausfall setzt ein anderer Runner am letzten Checkpoint fort.
	 * Vor jedem Push wird die Lease geprüft. Liefert eine Funktion zum Beenden.
	 */
	private startCheckpoints(
		run: ActiveRun,
		dir: string,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): () => void {
		const min = this.o.config.wipCheckpointMin ?? 0;
		const { offer } = run;
		if (!(min > 0) || offer.readOnly || offer.question || !this.o.features?.().checkpoints) return () => undefined;
		const ws = this.o.workspace;
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		let last = '';
		let busy = false;
		const tick = async () => {
			if (busy || run.reason) return;
			busy = true;
			try {
				const exclude = run.exclude ?? (offer.attachments?.length ? [ATTACHMENTS_DIR] : []);
				const snap = await snapshotWip(ws, dir, { runId: offer.runId, taskId: offer.taskId, reason: 'checkpoint', exclude });
				const tree = (await ws.run(dir, ['rev-parse', `${snap.sha}^{tree}`])).stdout.trim() + snap.parent;
				if (tree === last || run.reason) return;
				await this.assertLease(offer);
				await pushWip(ws, repo, dir, snap);
				await this.o.api.checkpoint(offer.runId, {
					ref: snap.ref,
					sha: snap.sha,
					...(offer.fence === undefined ? {} : { fence: offer.fence })
				});
				last = tree;
				emit('git', { action: 'wip', detail: `Checkpoint gesichert (${snap.sha.slice(0, 10)})` });
			} catch (e) {
				if (e instanceof LeaseLostError) {
					this.revoke(offer.runId, e.message);
					return;
				}
				this.log.warn(`Checkpoint für ${offer.runId} fehlgeschlagen`, errorMessage(e));
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(() => void tick(), min * 60_000);
		timer.unref();
		return () => clearInterval(timer);
	}

	/**
	 * Schritt 2b: Anhänge des Angebots laden und unter `.aidev/attachments/` ablegen; `.aidev/` wird in
	 * `info/exclude` eingetragen. Liefert den Prompt-Hinweis (oder `null`, z. B. wenn das Backend ihn schon setzt).
	 */
	private async prepareAttachments(
		offer: RunOffer,
		dir: string,
		signal: AbortSignal,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<string | null> {
		const list = offer.attachments ?? [];
		if (!list.length) return null;
		const ws = this.o.workspace;
		emit('status', { text: list.length === 1 ? 'Anhang wird geladen' : `Anhänge werden geladen (${list.length})` });
		try {
			await ws.withRepo({ repoOwner: offer.project.repoOwner, repoName: offer.project.repoName }, () =>
				excludeAidevDir(ws, dir)
			);
			// versionierte Dateien im Ablageordner würden überschrieben bzw. gelöscht und committet
			await assertAttachmentsUntracked(ws, dir);
			const stored = await storeAttachments(dir, list, (a) => this.o.api.attachment(offer.runId, a, signal));
			emit('system', {
				text: `${stored.length === 1 ? 'Anhang' : 'Anhänge'} bereitgestellt: ${stored.map((s) => s.path).join(', ')}`
			});
			return attachmentPromptHint(offer.prompt, stored);
		} catch (e) {
			if (signal.aborted) throw e;
			throw new RunError('setup', `Anhänge konnten nicht geladen werden – ${errorMessage(e)}`);
		}
	}

	/** Schritt 1: Cache aktualisieren und Worktree anlegen */
	private async prepareWorktree(
		offer: RunOffer,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<{ dir: string; startSha: string; remoteSha: string | null; resumedWip: string | null }> {
		const ws = this.o.workspace;
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		try {
			const cache = await ws.ensureCache(repo);
			const dir = ws.runDir(offer.runId);
			return await ws.withRepo(repo, async () => {
				const remoteSha = offer.question ? null : await ws.revParse(cache, `refs/remotes/origin/${offer.branch}`);
				// Der Head-Branch eines bestehenden PR wird nie neu angelegt
				if (!remoteSha && !offer.question && offer.delivery.mode === 'pr-update')
					throw new RunError('git', `Branch des PR #${offer.delivery.number} existiert nicht mehr`);
				const basePull =
					offer.delivery.mode === 'integrate' && offer.delivery.pullNumber !== undefined
						? offer.delivery.pullNumber
						: null;
				let start: string;
				if (remoteSha) {
					start = remoteSha;
					emit('git', { action: 'worktree', detail: `Fortsetzung auf origin/${offer.branch}` });
				} else {
					let base = await ws.revParse(cache, `refs/remotes/origin/${offer.baseRef}`);
					if (!base && offer.question) throw new RunError('git', `Basis ${offer.baseRef} fehlt`);
					// Basis = Head-Branch eines PR (Teilauftrag einer PR-Orchestrierung): nie neu anlegen
					if (!base && basePull !== null)
						throw new RunError('git', `Branch des PR #${basePull} existiert nicht mehr`);
					if (!base) {
						emit('git', {
							action: 'branch',
							detail: `Basis ${offer.baseRef} fehlt – wird aus ${offer.project.defaultBranch} angelegt`
						});
						base = await ws.createRemoteBranch(repo, cache, offer.baseRef, offer.project.defaultBranch);
					}
					start = base;
					emit('git', { action: 'worktree', detail: `Neuer Branch ${offer.branch} von origin/${offer.baseRef}` });
				}
				// Der Haupt-Branch bleibt der Arbeitskopie vorbehalten → dann ohne lokalen Branch
				const branch = offer.question || offer.branch === offer.project.defaultBranch ? null : offer.branch;
				// Zwischenstand eines übergebenen/verlorenen Vorläufers (WIP-Ref) fortsetzen, falls noch aktuell
				const wip = offer.resumeWip && !offer.readOnly && !offer.question && branch ? offer.resumeWip : null;
				if (wip) {
					const fetched = await fetchWip(ws, repo, cache, wip.ref);
					const usable = await wipUsable(ws, cache, { fetched, expected: wip.sha, remoteSha });
					if (usable.ok) {
						await ws.addWorktree(cache, dir, wip.sha, branch);
						await restoreWip(ws, dir, usable.parent);
						emit('git', {
							action: 'worktree',
							detail: `Zwischenstand von ${wip.fromRunner || 'einem anderen Runner'} übernommen (${wip.sha.slice(0, 10)})`
						});
						return { dir, startSha: start, remoteSha, resumedWip: wip.ref };
					}
					emit('system', { text: `Zwischenstand nicht übernommen: ${usable.reason} – Start ohne ihn` });
				}
				await ws.addWorktree(cache, dir, start, branch);
				return { dir, startSha: start, remoteSha, resumedWip: null };
			});
		} catch (e) {
			if (e instanceof GitError) throw new RunError('git', e.message);
			throw e;
		}
	}

	/**
	 * PR-Kontext laden und prüfen, bevor in den Head-Branch `branch` des PR gepusht wird. Ungeeignete PRs
	 * (geschlossen, Fork, anderer Branch) brechen den Lauf ab – ebenso ein PR, der sich nicht laden lässt: ohne
	 * geprüfte Metadaten wird nicht gepusht. Nur die Inline-Kommentare sind optional (`fetchPullContext`).
	 */
	private async loadPull(
		offer: RunOffer,
		number: number,
		branch: string,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<PullContext> {
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		let ctx: PullContext;
		try {
			ctx = await fetchPullContext(this.o.workspace, repo, number);
			assertPullUpdatable(ctx, branch);
		} catch (e) {
			throw new RunError('git', errorMessage(e));
		}
		emit('git', { action: 'pr', detail: `PR #${number} geladen: ${ctx.title.slice(0, 200)}`, url: ctx.url });
		return ctx;
	}

	/** Projektbefehl in der Shell ausführen; Ausgabe als `system`/`stderr`-Ereignisse */
	private async shell(
		cmd: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
		signal: AbortSignal,
		timeoutMs: number,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<ShellResult> {
		emit('system', { text: `$ ${cmd}` });
		// Ende der Ausgabe für einen Reparaturauftrag merken (stdout und stderr in Reihenfolge)
		let tail = '';
		const keep = (t: string) => {
			tail = (tail + t).slice(-40_000);
		};
		const out = new ChunkEmitter((t) => emit('system', { text: t }));
		const err = new ChunkEmitter((t) => emit('stderr', { text: t }));
		const r = await exec(cmd, [], {
			cwd,
			env,
			shell: true,
			signal,
			timeoutMs,
			maxStdoutBytes: 50_000_000,
			onStdout: (s) => {
				keep(s);
				out.push(s);
			},
			onStderr: (s) => {
				keep(s);
				err.push(s);
			}
		});
		out.end();
		err.end();
		if (r.spawnError) {
			emit('stderr', { text: `Befehl konnte nicht gestartet werden: ${r.spawnError}` });
			keep(`\nBefehl konnte nicht gestartet werden: ${r.spawnError}`);
		}
		if (r.timedOut) return { code: -1, output: `${tail}\n(Zeitlimit überschritten)` };
		return { code: r.code, output: tail };
	}

	/**
	 * Auslieferung nach `offer.delivery` (Push, PR, PR-Update, direkt, Integrations-Branch). Setzt die Felder von
	 * `finish` und liefert die Basis der ausgelieferten Commits. Konflikte werfen `DeliveryError('conflict')` mit
	 * `target` – die eigenständige Konfliktlösung übernimmt der Aufrufer.
	 */
	private async deliver(
		offer: RunOffer,
		dir: string,
		prepared: { startSha: string; remoteSha: string | null },
		c: {
			summary: string | null;
			integratedOnly: boolean;
			pull: PullContext | null;
			finish: FinishInput;
			runTests: (label: string, failure: string) => Promise<void>;
			emit: (k: RunEventKind, p: Record<string, unknown>) => void;
		}
	): Promise<string> {
		const ws = this.o.workspace;
		const redactor = this.o.redactor;
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		const { finish } = c;
		const gitEmit = (k: RunEventKind, p: Record<string, unknown>) => c.emit(k, p);
		let commitBase = prepared.startSha;
		const d = offer.delivery;
		if (d.mode === 'branch') {
			await pushBranch(ws, repo, dir, offer.branch, prepared.remoteSha, gitEmit);
			finish.branchPushed = true;
		} else if (d.mode === 'pr') {
			await pushBranch(ws, repo, dir, offer.branch, prepared.remoteSha, gitEmit);
			const pr = await ensurePullRequest(
				ws,
				repo,
				{ branch: offer.branch, base: offer.project.defaultBranch, title: d.title || offer.title, body: d.body },
				gitEmit
			);
			finish.pr = pr;
			if (d.autoMerge) await enableAutoMerge(ws, repo, pr.number, gitEmit);
		} else if (d.mode === 'pr-update') {
			if (!c.integratedOnly) {
				// Kein Force-Push: parallel gepushte Commits werden per Rebase übernommen
				const synced = await syncPullBranch(
					ws,
					repo,
					{ dir, branch: offer.branch, number: d.number, expectedRemote: prepared.remoteSha },
					gitEmit
				);
				commitBase = synced.base;
				// Der getestete Stand ist nach dem Rebase nicht mehr der auszuliefernde → erneut testen
				if (synced.rebased)
					await c.runTests(
						'Tests laufen erneut (testCmd, nach Rebase auf parallel gepushte Commits)',
						'Tests nach Rebase auf parallel gepushte Commits fehlgeschlagen'
					);
				await pushBranch(ws, repo, dir, offer.branch, commitBase, gitEmit, { allowForce: false });
			}
			// Bei `integratedOnly` liegen die Änderungen der Teilaufträge bereits auf dem PR-Branch
			finish.branchPushed = true;
			const url =
				c.pull?.url ||
				(await pullUrl(ws, repo, d.number)) ||
				`https://github.com/${repo.repoOwner}/${repo.repoName}/pull/${d.number}`;
			finish.pr = { number: d.number, url };
			c.emit('git', { action: 'pr', detail: `PR #${d.number} aktualisiert`, url });
			const commits = await commitInfos(ws, dir, commitBase);
			const body = pullCommentBody({
				summary: c.summary ? redactor.redact(c.summary) : null,
				commits,
				taskId: offer.taskId,
				note: d.integrated ? 'Die Änderungen der Teilaufträge wurden bereits einzeln in den PR-Branch gemergt.' : undefined
			});
			await commentOnPull(ws, repo, d.number, redactor.redact(body), gitEmit);
		} else if (d.mode === 'direct') {
			commitBase = await deliverDirect(ws, repo, dir, offer.project.defaultBranch, gitEmit);
			finish.merged = true;
			finish.branch = offer.project.defaultBranch;
		} else if (d.mode === 'integrate') {
			await pushBranch(ws, repo, dir, offer.branch, prepared.remoteSha, gitEmit);
			await deliverIntegrate(
				ws,
				repo,
				{
					dir,
					branch: offer.branch,
					integrationBranch: d.integrationBranch,
					defaultBranch: offer.project.defaultBranch,
					runId: offer.runId,
					taskId: offer.taskId,
					pullNumber: d.pullNumber
				},
				gitEmit
			);
			finish.merged = true;
		}
		return commitBase;
	}

	/**
	 * Recherche für einen laufenden Agent (Recherche-Schnittstelle): eigener, nur lesender Agent-Aufruf im selben
	 * Worktree. Konto: `researchAccounts` (in Reihenfolge), sonst ein anderes freies Konto, sonst dasselbe. Stößt ein
	 * Konto an sein Limit, wird das nächste versucht. Verbrauch desselben Kontos zählt zum Lauf (`onUsage`).
	 */
	private async research(
		offer: RunOffer,
		acct: AccountConfig,
		dir: string,
		req: ResearchRequest,
		signal: AbortSignal,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void,
		onUsage: (u: AgentUsage) => void
	): Promise<string> {
		// Dieselbe Frage im selben Repository kürzlich schon recherchiert → ohne Agent-Aufruf beantworten
		const cache = new ResearchCache(
			path.join(this.o.workspace.o.workDir, 'meta', 'research', offer.project.repoOwner, offer.project.repoName)
		);
		const hit = await cache.get(req);
		if (hit) {
			emit('system', { text: `Recherche aus dem Zwischenspeicher (keine Tokens):\n${tailText(hit.answer, 4000)}` });
			return hit.answer;
		}
		const candidates = this.researchAccounts(acct);
		if (!candidates.length) throw new Error('Kein angemeldetes Konto für Recherchen verfügbar');
		const q = req.question.replace(/\s+/g, ' ').trim();
		const errors: string[] = [];
		for (const cand of candidates.slice(0, 3)) {
			if (signal.aborted) throw new Error('Abgebrochen');
			emit('status', { text: `Recherche über ${cand.key} (${cand.provider}): ${q.slice(0, 200)}` });
			const tmp = path.join(this.o.workspace.tmpRoot, offer.runId, `research-${Date.now().toString(36)}`);
			await mkdir(tmp, { recursive: true });
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 15 * 60_000);
			timer.unref();
			try {
				const proc = this.o.adapters[cand.provider].start({
					cwd: dir,
					prompt: researchTaskPrompt(req, { title: offer.title }),
					systemPrompt: researchSystemPrompt({
						repo: `${offer.project.repoOwner}/${offer.project.repoName}`,
						defaultBranch: offer.project.defaultBranch
					}),
					model: cand.provider === 'openai-api' ? (cand.model ?? null) : null,
					resumeSessionId: null,
					env: accountEnv(cand, process.env, { AIDEV_RUN_ID: offer.runId, AIDEV_TASK_ID: offer.taskId }),
					readOnly: true,
					question: true,
					research: true,
					signal: AbortSignal.any([signal, ctrl.signal]),
					account: cand,
					tmpDir: tmp
				});
				let limit: AgentLimit | null = null;
				let u: AgentUsage | null = null;
				for await (const ev of proc.events) {
					if (ev.kind === 'usage') u = ev.usage;
					else if (ev.kind === 'limits') this.limits.update(cand.key, ev.windows, 'stream');
					else if (ev.kind === 'limit') {
						if (!limit) {
							limit = { limitKind: ev.limitKind, resetsAt: ev.resetsAt, raw: ev.raw };
							proc.kill();
						}
					} else if (ev.kind === 'tool') {
						const name = typeof ev.payload.name === 'string' ? ev.payload.name : 'tool';
						emit('system', { text: `Recherche (${cand.key}): ${name}` });
					}
				}
				const r = await proc.done;
				u = r.usage ?? u;
				if (u && cand.key === acct.key) onUsage(u);
				limit = limit ?? r.limit;
				if (limit) {
					const w = limitHitWindow(limit.limitKind, limit.resetsAt);
					if (w) this.limits.update(cand.key, [w], 'error');
					errors.push(`${cand.key}: Limit erreicht (${limit.limitKind})`);
					continue;
				}
				if (signal.aborted) throw new Error('Abgebrochen');
				if (r.exitCode !== 0 || !r.lastText.trim()) {
					errors.push(`${cand.key}: ${r.error ?? 'keine Antwort'}`);
					continue;
				}
				const answer = this.o.redactor.redact(r.lastText.trim());
				emit('system', { text: `Recherche-Ergebnis (${cand.key}):\n${tailText(answer, 4000)}` });
				await cache.put(req, answer, cand.key);
				return answer;
			} finally {
				clearTimeout(timer);
				await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
			}
		}
		throw new Error(errors.join('; ').slice(0, 2000) || 'Recherche fehlgeschlagen');
	}

	/** Konten für Recherchen in Reihenfolge der Eignung (angemeldet, verfügbar, nicht am Limit) */
	private researchAccounts(current: AccountConfig): AccountConfig[] {
		const all = [...this.o.accounts().values()].filter((a) => a.ok && a.loggedIn).map((a) => a.config);
		const now = Date.now();
		const limited = (key: string) =>
			(this.limits.snapshot(key)?.windows ?? []).some(
				(w) => w.status === 'rejected' && (!w.resetsAt || Date.parse(w.resetsAt) > now)
			);
		// Fake-Konten nur, wenn der Lauf selbst ein Fake-Konto nutzt (Tests/Vorführung)
		const usable = all.filter((a) => (a.provider !== 'fake' || current.provider === 'fake') && !limited(a.key));
		const preferred = (this.o.config.researchAccounts ?? [])
			.map((k) => usable.find((a) => a.key === k))
			.filter((a): a is AccountConfig => !!a);
		const others = usable.filter((a) => a.key !== current.key && !preferred.includes(a));
		const self = usable.filter((a) => a.key === current.key && !preferred.includes(a));
		return [...preferred, ...others, ...self];
	}

}

/** Fasst Ausgabe zu Ereignissen zusammen (je ~4 KB bzw. 200 ms) */
class ChunkEmitter {
	private buf = '';
	private timer: NodeJS.Timeout | null = null;
	constructor(private readonly send: (text: string) => void) {}
	push(s: string): void {
		this.buf += s;
		if (this.buf.length >= 4000) this.flush();
		else if (!this.timer) this.timer = setTimeout(() => this.flush(), 200);
	}
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (!this.buf) return;
		const text = this.buf.replace(/\r?\n$/, '');
		this.buf = '';
		if (text) this.send(text);
	}
	end(): void {
		this.flush();
	}
}

/**
 * Würde ein Merge von `target` in HEAD Konflikte erzeugen? Prüfung ohne Änderung am Worktree
 * (`git merge-tree --write-tree`, git ≥ 2.38). Unbekannt (älteres git) → false.
 */
async function wouldConflict(ws: Workspace, dir: string, target: string): Promise<boolean> {
	const anc = await ws.run(dir, ['merge-base', '--is-ancestor', target, 'HEAD'], { allowFail: true });
	if (anc.code === 0) return false;
	const r = await ws.run(dir, ['merge-tree', '--write-tree', '--name-only', 'HEAD', target], { allowFail: true });
	return r.code === 1;
}

function toRunError(e: unknown, run: ActiveRun): RunError {
	if (e instanceof RunError) {
		if (e.kind === 'cancelled' && !e.message) return new RunError('cancelled', run.cancelMessage || 'Abgebrochen');
		if (e.kind === 'timeout' && !e.message)
			return new RunError('timeout', `Zeitlimit von ${run.offer.timeoutSec} s überschritten`);
		return e;
	}
	if (e instanceof LeaseLostError) return new RunError('cancelled', e.message);
	if (run.reason === 'cancel' || run.reason === 'shutdown' || run.reason === 'handover' || run.reason === 'revoked')
		return new RunError('cancelled', run.cancelMessage || 'Abgebrochen');
	if (run.reason === 'timeout') return new RunError('timeout', `Zeitlimit von ${run.offer.timeoutSec} s überschritten`);
	if (e instanceof DeliveryError) return new RunError(e.kind, e.message, e.conflictFiles);
	if (e instanceof GitError) return new RunError('git', e.message);
	if (e instanceof ApiError) return new RunError('internal', `Atrium: ${e.message}`);
	return new RunError('internal', errorMessage(e));
}

function statusText(f: FinishInput): string {
	switch (f.status) {
		case 'succeeded':
			return f.pr ? `Fertig – PR #${f.pr.number}` : f.merged ? 'Fertig – gemergt' : 'Fertig';
		case 'limited':
			return 'Abgebrochen: Limit erreicht';
		case 'cancelled':
			return 'Abgebrochen';
		default:
			return `Fehlgeschlagen (${f.errorKind ?? 'unbekannt'})`;
	}
}
