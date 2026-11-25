/**
 * Ausführung der Läufe: Slots, Annahme/Ablehnung von Angeboten, Ablauf je Lauf (Worktree → setupCmd → Agent →
 * Commit/Tests/Auslieferung → finish), Abbruch, Zeitlimit, Heartbeat-Daten.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { accountEnv, publicEnv, type AccountConfig, type RunnerConfig } from './config.ts';
import { ApiError, EventBatcher, type RunnerApi } from './client.ts';
import {
	commitAll,
	commitInfos,
	countCommits,
	DeliveryError,
	deliverDirect,
	deliverIntegrate,
	discardChanges,
	enableAutoMerge,
	ensurePullRequest,
	headSha,
	pushBranch
} from './git/delivery.ts';
import { assertRefName, GitError } from './git/git.ts';
import type { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { extractPlan } from './plan.ts';
import type { AdapterRegistry } from './providers/index.ts';
import type { AgentLimit, AgentResult, AgentUsage } from './providers/types.ts';
import type { FinishInput, RunEventKind, RunOffer } from './protocol.ts';
import type { Redactor } from './redact.ts';
import { errorMessage } from './util/async.ts';
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

type AbortReason = 'cancel' | 'timeout' | 'shutdown' | 'limit';

interface ActiveRun {
	offer: RunOffer;
	ctrl: AbortController;
	reason: AbortReason | null;
	cancelMessage: string;
	done: Promise<void>;
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
	/** Gnadenfrist für Batcher in Tests */
	batcherFlushMs?: number;
}

const NO_CHANGES = 'Keine Änderungen – der Agent hat nichts geändert, daher kein Commit und kein PR.';

export class Executor {
	private readonly running = new Map<string, ActiveRun>();
	/** Kürzlich bearbeitete Läufe (doppelte Angebote über `/pending` ignorieren) */
	private readonly seen = new Map<string, number>();
	private stopping = false;
	private readonly log: Logger;

	constructor(private readonly o: ExecutorOptions) {
		this.log = o.log ?? silentLogger;
	}

	get slotsUsed(): number {
		return this.running.size;
	}

	runIds(): string[] {
		return [...this.running.keys()];
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
		if (this.running.size >= this.o.config.maxSlots) return reject('Keine freien Slots');
		const acct = this.o.accounts().get(offer.account.key);
		if (!acct || acct.config.provider !== offer.account.provider)
			return reject(`Unbekanntes Konto „${offer.account.key}“`);
		if (!acct.ok) return reject(`CLI für Konto „${offer.account.key}“ nicht verfügbar`);
		if (!acct.loggedIn) return reject(`Konto „${offer.account.key}“ ist nicht angemeldet`);
		if (offer.delivery.mode === 'branch' && offer.branch === offer.project.defaultBranch)
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
		const run: ActiveRun = { offer, ctrl, reason: null, cancelMessage: '', done: Promise.resolve() };
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
			flushMs: this.o.batcherFlushMs
		});
		const emit = (kind: RunEventKind, payload: Record<string, unknown>) => batcher.push(kind, payload);
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		const tmpDir = path.join(ws.tmpRoot, offer.runId);

		let sessionId: string | null = offer.resumeSessionId;
		let usage: AgentUsage | null = null;
		let limitPosted = false;
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
			try {
				await api.limit(offer.runId, {
					kind: l.limitKind,
					resetsAt: l.resetsAt,
					raw: redactor.redact(l.raw).slice(0, 2000)
				});
			} catch (e) {
				log.warn('Limit-Meldung fehlgeschlagen', errorMessage(e));
			}
		};

		let wtDir: string | null = null;
		try {
			emit('status', { text: 'Repository wird vorbereitet' });
			// 1. Worktree
			const prepared = await this.prepareWorktree(offer, emit);
			wtDir = prepared.dir;
			checkAbort();

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
				if (r !== 0) throw new RunError('setup', `setupCmd fehlgeschlagen (Exit-Code ${r ?? 'unbekannt'})`);
			}

			// 3. Agent
			emit('status', { text: `Agent startet (${offer.account.provider}${offer.model ? `, ${offer.model}` : ''})` });
			await mkdir(tmpDir, { recursive: true });
			const adapter = this.o.adapters[acct.provider];
			const proc = adapter.start({
				cwd: wtDir,
				prompt: offer.prompt,
				systemPrompt: offer.systemPrompt,
				model: offer.model ?? (acct.provider === 'openai-api' ? (acct.model ?? null) : null),
				resumeSessionId: offer.resumeSessionId,
				env: baseEnv,
				readOnly: offer.readOnly,
				question: offer.question === true,
				signal,
				account: acct,
				tmpDir
			});
			let limit: AgentLimit | null = null;
			for await (const ev of proc.events) {
				if (ev.kind === 'usage') usage = ev.usage;
				else if (ev.kind === 'session') sessionId = ev.id;
				else if (ev.kind === 'limit') {
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
			if (result.usage) usage = result.usage;
			if (result.sessionId) sessionId = result.sessionId;
			limit = limit ?? result.limit;
			if (limit) {
				await postLimit(limit);
				if (limit.limitKind === 'auth') throw new RunError('auth', 'Konto nicht (mehr) angemeldet');
				finish.status = 'limited';
				finish.errorKind = 'limit';
				finish.errorMessage = `Limit erreicht (${limit.limitKind})`;
				finish.summary = result.lastText || null;
				return;
			}
			if (run.reason === 'timeout') throw new RunError('timeout', `Zeitlimit von ${offer.timeoutSec} s überschritten`);
			if (run.reason) throw new RunError('cancelled', run.cancelMessage || 'Abgebrochen');
			if (result.exitCode !== 0)
				throw new RunError('agent', result.error ?? `Agent beendet mit Exit-Code ${result.exitCode ?? 'unbekannt'}`);
			const summary = result.lastText || null;
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

			// 5. Schreibend: Commit
			const committed = await commitAll(ws, wtDir, offer.title, offer.taskId);
			if (committed) emit('git', { action: 'commit', detail: 'Änderungen committet' });
			const newCommits = await countCommits(ws, wtDir, prepared.startSha);
			finish.branch = offer.branch;
			finish.headSha = await headSha(ws, wtDir);
			// Ein wiederaufgenommener oder zusammengeführter Branch kann bereits auszuliefernde Commits enthalten.
			const pendingCommits = newCommits || await countCommits(ws, wtDir, `origin/${offer.baseRef}`);
			if (pendingCommits === 0) {
				emit('status', { text: NO_CHANGES });
				finish.status = 'succeeded';
				finish.summary = summary ? `${summary}\n\n(${NO_CHANGES})` : NO_CHANGES;
				return;
			}
			checkAbort();

			// Tests vor dem Push
			if (offer.project.testCmd.trim()) {
				emit('status', { text: 'Tests laufen (testCmd)' });
				const r = await this.shell(offer.project.testCmd, wtDir, publicEnv(baseEnv), signal, timeoutMs, emit);
				checkAbort();
				if (r !== 0) {
					finish.commits = await commitInfos(ws, wtDir, prepared.startSha);
					throw new RunError('tests', `Tests fehlgeschlagen (Exit-Code ${r ?? 'unbekannt'}) – nichts gepusht`);
				}
			}

			// Auslieferung
			let commitBase = prepared.startSha;
			const d = offer.delivery;
			const gitEmit = (k: RunEventKind, p: Record<string, unknown>) => emit(k, p);
			if (d.mode === 'branch') {
				await pushBranch(ws, repo, wtDir, offer.branch, prepared.remoteSha, gitEmit);
				finish.branchPushed = true;
			} else if (d.mode === 'pr') {
				await pushBranch(ws, repo, wtDir, offer.branch, prepared.remoteSha, gitEmit);
				const pr = await ensurePullRequest(
					ws,
					repo,
					{ branch: offer.branch, base: offer.project.defaultBranch, title: d.title || offer.title, body: d.body },
					gitEmit
				);
				finish.pr = pr;
				if (d.autoMerge) await enableAutoMerge(ws, repo, pr.number, gitEmit);
			} else if (d.mode === 'direct') {
				commitBase = await deliverDirect(ws, repo, wtDir, offer.project.defaultBranch, gitEmit);
				finish.merged = true;
				finish.branch = offer.project.defaultBranch;
			} else if (d.mode === 'integrate') {
				await pushBranch(ws, repo, wtDir, offer.branch, prepared.remoteSha, gitEmit);
				await deliverIntegrate(
					ws,
					repo,
					{
						dir: wtDir,
						branch: offer.branch,
						integrationBranch: d.integrationBranch,
						defaultBranch: offer.project.defaultBranch,
						runId: offer.runId,
						taskId: offer.taskId
					},
					gitEmit
				);
				finish.merged = true;
			}
			finish.headSha = await headSha(ws, wtDir);
			finish.commits = await commitInfos(ws, wtDir, commitBase);
			finish.status = 'succeeded';
		} catch (e) {
			const err = toRunError(e, run);
			finish.status = err.kind === 'cancelled' ? 'cancelled' : 'failed';
			finish.errorKind = err.kind;
			finish.errorMessage = redactor.redact(err.message || (err.kind === 'cancelled' ? run.cancelMessage || 'Abgebrochen' : 'Fehler')).slice(0, 4000);
			finish.conflictFiles = err.conflictFiles.slice(0, 200);
			if (err.kind === 'internal') log.error('Interner Fehler', e instanceof Error ? (e.stack ?? e.message) : e);
			emit('error', { text: finish.errorMessage });
			if (wtDir && !finish.headSha) finish.headSha = await headSha(ws, wtDir).catch(() => null);
		} finally {
			clearTimeout(timer);
			await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
			finish.sessionId = sessionId ? sessionId.slice(0, 200) : null;
			if (finish.summary) finish.summary = redactor.redact(finish.summary).slice(0, 40_000);
			if (finish.headSha && !/^[0-9a-f]{7,40}$/.test(finish.headSha)) finish.headSha = null;
			if (finish.pr && !/^https?:\/\//.test(finish.pr.url)) finish.pr = null;
			finish.commits = finish.commits.slice(-200);
			emit('status', { text: statusText(finish) });
			await batcher.close();
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
			try {
				await api.finish(offer.runId, finish);
				log.info(`Lauf beendet: ${finish.status}${finish.errorKind ? ` (${finish.errorKind})` : ''}`);
			} catch (e) {
				log.error('Abschlussmeldung fehlgeschlagen', errorMessage(e));
			}
		}
	}

	/** Schritt 1: Cache aktualisieren und Worktree anlegen */
	private async prepareWorktree(
		offer: RunOffer,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<{ dir: string; startSha: string; remoteSha: string | null }> {
		const ws = this.o.workspace;
		const repo = { repoOwner: offer.project.repoOwner, repoName: offer.project.repoName };
		try {
			const cache = await ws.ensureCache(repo);
			const dir = ws.runDir(offer.runId);
			return await ws.withRepo(repo, async () => {
				const remoteSha = offer.question ? null : await ws.revParse(cache, `refs/remotes/origin/${offer.branch}`);
				let start: string;
				if (remoteSha) {
					start = remoteSha;
					emit('git', { action: 'worktree', detail: `Fortsetzung auf origin/${offer.branch}` });
				} else {
					let base = await ws.revParse(cache, `refs/remotes/origin/${offer.baseRef}`);
					if (!base && offer.question) throw new RunError('git', `Basis ${offer.baseRef} fehlt`);
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
				await ws.addWorktree(cache, dir, start, branch);
				return { dir, startSha: start, remoteSha };
			});
		} catch (e) {
			if (e instanceof GitError) throw new RunError('git', e.message);
			throw e;
		}
	}

	/** Projektbefehl in der Shell ausführen; Ausgabe als `system`/`stderr`-Ereignisse */
	private async shell(
		cmd: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
		signal: AbortSignal,
		timeoutMs: number,
		emit: (k: RunEventKind, p: Record<string, unknown>) => void
	): Promise<number | null> {
		emit('system', { text: `$ ${cmd}` });
		const out = new ChunkEmitter((t) => emit('system', { text: t }));
		const err = new ChunkEmitter((t) => emit('stderr', { text: t }));
		const r = await exec(cmd, [], {
			cwd,
			env,
			shell: true,
			signal,
			timeoutMs,
			maxStdoutBytes: 50_000_000,
			onStdout: (s) => out.push(s),
			onStderr: (s) => err.push(s)
		});
		out.end();
		err.end();
		if (r.spawnError) emit('stderr', { text: `Befehl konnte nicht gestartet werden: ${r.spawnError}` });
		if (r.timedOut) return -1;
		return r.code;
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

function toRunError(e: unknown, run: ActiveRun): RunError {
	if (e instanceof RunError) {
		if (e.kind === 'cancelled' && !e.message) return new RunError('cancelled', run.cancelMessage || 'Abgebrochen');
		if (e.kind === 'timeout' && !e.message)
			return new RunError('timeout', `Zeitlimit von ${run.offer.timeoutSec} s überschritten`);
		return e;
	}
	if (run.reason === 'cancel' || run.reason === 'shutdown')
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
