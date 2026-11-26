/**
 * Scheduler (Datenbankseite): wartende Aufträge über `planAssignments` (`scheduler.ts`) auf Konten verteilen,
 * Läufe anlegen und als `offer` an die Runner schicken. Nie parallel: In-Prozess-Kette + Advisory-Sperre
 * `pg_advisory_xact_lock(hashtext('aidev:scheduler'))` in der Transaktion. `requestDispatch()` stößt entprellt an
 * (50 ms, mehrere Anstöße werden zusammengefasst).
 *
 * Branches und Basis eines Laufs:
 * - Auftrag ohne Elternteil: `aidev/<kurz-id>-<slug>` auf Basis des Haupt-Branchs.
 * - Teilauftrag: `aidev/<eltern-kurz>/<position+1>-<slug>` auf Basis des Integrations-Branchs des Elternauftrags.
 *   Beim ersten Teilauftrag existiert `origin/<Integrations-Branch>` evtl. noch nicht – der Runner legt ihn dann
 *   aus dem Haupt-Branch an und pusht ihn (gleiche Regel gilt für jede fehlende Basis).
 * - Konfliktlösung und Ausliefern: vorhandener Branch des (ursprünglichen) Auftrags.
 * - Auftrag mit `target_pr` (bestehenden PR bearbeiten): `createTask` setzt `branch` = Head-Branch des PR und
 *   `base_ref` = Haupt-Branch; `branchPlan` übernimmt beides. Bei `orchestrate` wird der PR-Branch so zum
 *   Integrations-Branch (Teilaufträge zweigen von ihm ab und werden hineingemergt), das Ausliefern pusht in den PR.
 *   Teilaufträge erhalten dafür `integrate` mit `pullNumber` (PR-Prüfung, keine Neuanlage des Branchs, nur Runner
 *   mit `prUpdate`); das Ausliefern erhält `pr-update` mit `integrated`, sobald Teilaufträge Commits gemergt haben.
 */
import { sql } from 'drizzle-orm';
import { inList, logBestEffort, num, rowsOf, str, toIso, type Row } from '$lib/sdk/server';
import {
	clip,
	loadSettings,
	mdb,
	oneOf,
	shortId,
	stringList,
	type AidevSettings,
	type Tx
} from './db';
import { effectiveAttachmentRows, uniqueAttachmentNames } from './attachments.service';
import { newEffects, sendCommand, type Effects } from './effects';
import { attachmentOffer } from './mappers';
import { buildSystemPrompt, buildTaskPrompt, slugify, type PromptContext } from './prompts';
import {
	READ_ONLY_ROLES,
	type Delivery,
	type Provider,
	type Role,
	type RunOffer
} from './protocol';
import { publish } from './publish.service';
import { connectionLossTargets, loseRun } from './runs.service';
import { planAssignments, type ProjectState, type TaskCandidate } from './scheduler';
import { effectiveRole, getTask, planOf, resolveInfoOf, topBranchOf } from './tasks.service';
import { loadAccountViews } from './usage.service';
import { LEASE_SEC, OFFER_LEASE_SEC, RUNNER_STALE_SEC } from './db';

// ---------------------------------------------------------------- Branches, Auslieferung, Prompt

const ms = (v: unknown) => new Date(toIso(v)).getTime();

/** Arbeits-Branch und Basis des nächsten Laufs */
export async function branchPlan(
	tx: Tx,
	task: Row,
	project: Row
): Promise<{ branch: string; baseRef: string }> {
	const main = String(project.default_branch);
	const parent = task.parent_id ? await getTask(tx, String(task.parent_id)) : null;
	if (task.role === 'resolve') {
		return {
			branch: str(task.branch) ?? str(parent?.branch) ?? topBranchOf(task),
			baseRef: str(task.base_ref) ?? str(parent?.base_ref) ?? main
		};
	}
	if (task.role === 'orchestrate') {
		return { branch: str(task.branch) ?? topBranchOf(task), baseRef: main };
	}
	if (parent && parent.role === 'orchestrate') {
		return {
			branch:
				str(task.branch) ??
				`aidev/${shortId(String(parent.id))}/${num(task.position) + 1}-${slugify(String(task.title))}`,
			baseRef: str(parent.branch) ?? topBranchOf(parent)
		};
	}
	return { branch: str(task.branch) ?? topBranchOf(task), baseRef: str(task.base_ref) ?? main };
}

/**
 * Auslieferung: Nur-Lesen → none; Teilauftrag → integrate; Konfliktlösung → wie der ursprüngliche Auftrag;
 * Auftrag mit `target_pr` → pr-update (Vorrang vor `delivery`). Konfliktlösungen erben pr-update über den
 * Elternauftrag, eine Orchestrierung liefert am Ende in den PR.
 */
export async function deliveryOf(tx: Tx, task: Row, project: Row, depth = 0): Promise<Delivery> {
	if (READ_ONLY_ROLES.includes(effectiveRole(task))) return { mode: 'none' };
	const parent = task.parent_id ? await getTask(tx, String(task.parent_id)) : null;
	if (task.role === 'resolve' && parent && depth < 5) {
		return deliveryOf(tx, parent, project, depth + 1);
	}
	if (parent && parent.role === 'orchestrate') {
		const integrationBranch = str(parent.branch) ?? topBranchOf(parent);
		// Integrations-Branch = Head-Branch eines PR: Runner prüft den PR und legt den Branch nie neu an
		return parent.target_pr
			? { mode: 'integrate', integrationBranch, pullNumber: num(parent.target_pr) }
			: { mode: 'integrate', integrationBranch };
	}
	if (task.target_pr) {
		const number = num(task.target_pr);
		// Abschluss einer Orchestrierung: Teilaufträge haben ihre Änderungen schon in den PR-Branch gemergt
		if (planOf(task) && (await hasIntegratedChanges(tx, String(task.id))))
			return { mode: 'pr-update', number, integrated: true };
		return { mode: 'pr-update', number };
	}
	if (task.delivery === 'branch') return { mode: 'branch' };
	const policy = String(project.commit_policy);
	if (policy === 'direct') return { mode: 'direct' };
	return {
		mode: 'pr',
		autoMerge: policy === 'pr-automerge',
		title: clip(String(task.title), 200),
		body: clip(`${clip(String(task.prompt), 4000)}\n\n---\nAidev-Task: ${String(task.id)}`, 20_000)
	};
}

/** Hat ein Teilauftrag (oder dessen Konfliktlösung) Commits erfolgreich in den Integrations-Branch gemergt? */
async function hasIntegratedChanges(tx: Tx, parentId: string): Promise<boolean> {
	const row = await oneOf(
		tx,
		sql`SELECT 1 FROM run r JOIN task t ON t.id = r.task_id
			WHERE r.status = 'succeeded'
				AND EXISTS (SELECT 1 FROM run_commit c WHERE c.run_id = r.id)
				AND (t.parent_id = ${parentId}
					OR t.parent_id IN (SELECT id FROM task WHERE parent_id = ${parentId}))
			LIMIT 1`
	);
	return !!row;
}

const DELIVER_PROMPT = (branch: string, prompt: string) =>
	`Alle Teilaufträge sind im Integrations-Branch „${branch}“ zusammengeführt. Prüfe die Integration, führe die ` +
	`Tests aus, behebe Kleinigkeiten und liefere das Ergebnis aus.\n\nUrsprünglicher Auftrag:\n${prompt}`;

async function promptContext(tx: Tx, task: Row, project: Row, role: Role): Promise<PromptContext> {
	const deliver = !!planOf(task);
	const resultRows = deliver
		? await rowsOf(
				tx,
				sql`SELECT title, role, result_summary FROM task
					WHERE parent_id = ${task.id} AND role <> 'resolve' AND status = 'done'
					ORDER BY position, created_at`
			)
		: await rowsOf(
				tx,
				sql`SELECT t.title, t.role, t.result_summary FROM task_dep d
					JOIN task t ON t.id = d.depends_on_id
					WHERE d.task_id = ${task.id} AND t.status = 'done'
					ORDER BY t.position, t.created_at`
			);
	const replies = await rowsOf(
		tx,
		// die Chat-Nachricht, aus der der Auftrag entstand (gleiche Transaktion), ist kein Nachtrag
		sql`SELECT body FROM chat_message WHERE task_id = ${task.id} AND kind = 'user'
				AND created_at > (SELECT created_at FROM task WHERE id = ${task.id})
			ORDER BY created_at, id`
	);
	const parent = task.parent_id ? await getTask(tx, String(task.parent_id)) : null;
	const readOnly = READ_ONLY_ROLES.includes(role);
	// Aktionsvorschläge nur für Chat-Fragen und eigenständige Arbeitsaufträge (keine Teilaufträge, keine Orchestrierung)
	const allowActions =
		task.chat_question === true ||
		(!task.parent_id &&
			(['research', 'implement', 'review', 'fix'] as Role[]).includes(role) &&
			!planOf(task));
	// das Schema kennt kein Löschen/Archivieren von Aufträgen; Chat-Fragen sind keine änderbaren Aufträge
	const projectTasks = allowActions
		? await rowsOf(
				tx,
				sql`SELECT id, title, status, role FROM task
					WHERE project_id = ${task.project_id} AND id <> ${task.id} AND chat_question = false
					ORDER BY created_at DESC, id DESC LIMIT 30`
			)
		: [];
	return {
		role,
		question: task.chat_question === true,
		// Teilaufträge einer Orchestrierung aus dem Chat sehen den Gesprächsverlauf des Elternauftrags
		chatContext: String(task.chat_context ?? '') || String(parent?.chat_context ?? ''),
		project: {
			name: String(project.name),
			repoOwner: String(project.repo_owner),
			repoName: String(project.repo_name),
			defaultBranch: String(project.default_branch),
			instructions: String(project.instructions ?? ''),
			testCmd: String(project.test_cmd ?? '')
		},
		task: {
			title: String(task.title),
			prompt: deliver
				? DELIVER_PROMPT(str(task.branch) ?? topBranchOf(task), String(task.prompt))
				: String(task.prompt)
		},
		readOnly,
		expectPlan: role === 'orchestrate',
		dependencyResults: resultRows
			.filter((r) => str(r.result_summary))
			.map((r) => ({
				title: String(r.title),
				role: String(r.role) as Role,
				summary: clip(String(r.result_summary), 8000)
			})),
		replies: replies.map((r) => String(r.body)),
		parent: parent ? { title: String(parent.title), prompt: String(parent.prompt) } : null,
		conflictFiles: resolveInfoOf(task)?.conflictFiles ?? [],
		previousError: str(task.error_message),
		allowActions,
		projectTasks: projectTasks.map((r) => ({
			id: String(r.id),
			title: String(r.title),
			status: String(r.status),
			role: String(r.role)
		}))
	};
}

/** Angebot eines Laufs aus der Datenbank (auch für `GET /runner/pending` und erneutes Senden) */
export async function buildOffer(
	tx: Tx,
	run: Row,
	settings: AidevSettings
): Promise<RunOffer | null> {
	const task = await getTask(tx, String(run.task_id));
	const project = await oneOf(tx, sql`SELECT * FROM project WHERE id = ${run.project_id}`);
	const account = run.account_id
		? await oneOf(tx, sql`SELECT key, provider FROM provider_account WHERE id = ${run.account_id}`)
		: null;
	if (!task || !project || !account) return null;
	const role = effectiveRole(task);
	const ctx = await promptContext(tx, task, project, role);
	// eigene und geerbte Anhänge (Elternkette); der Runner lädt die Bytes über `/runner/runs/:id/attachments/:aid`
	const files = uniqueAttachmentNames(
		(await effectiveAttachmentRows(tx, [String(task.id)])).get(String(task.id)) ?? []
	);
	ctx.attachments = files.map((f) => ({
		name: String(f.name),
		mime: String(f.mime),
		size: num(f.size)
	}));
	const plan = await branchPlan(tx, task, project);
	ctx.delivery = await deliveryOf(tx, task, project);
	const sessionAccount = str(task.session_account_id);
	return {
		runId: String(run.id),
		taskId: String(task.id),
		attempt: num(run.attempt),
		role,
		title: clip(String(task.title), 200),
		prompt: buildTaskPrompt(ctx),
		systemPrompt: buildSystemPrompt(ctx),
		project: {
			id: String(project.id),
			name: clip(String(project.name), 120),
			repoOwner: String(project.repo_owner),
			repoName: String(project.repo_name),
			defaultBranch: String(project.default_branch),
			setupCmd: String(project.setup_cmd ?? ''),
			testCmd: String(project.test_cmd ?? '')
		},
		account: { key: String(account.key), provider: String(account.provider) as Provider },
		model: str(run.model) || null,
		branch: str(run.branch) ?? plan.branch,
		baseRef: plan.baseRef,
		readOnly: ctx.readOnly,
		question: ctx.question,
		expectPlan: ctx.expectPlan,
		resumeSessionId:
			!ctx.question && sessionAccount && sessionAccount === str(run.account_id)
				? str(task.session_id)
				: null,
		// ältere Angebote ohne Anhänge enthalten das Feld nicht
		...(files.length ? { attachments: files.map(attachmentOffer) } : {}),
		delivery: ctx.delivery,
		leaseSec: LEASE_SEC,
		timeoutSec: settings.limits.runTimeoutMin * 60
	};
}

/** Offene Angebote eines Runners */
export async function pendingOffers(
	tx: Tx,
	runnerId: string,
	settings: AidevSettings
): Promise<RunOffer[]> {
	const runs = await rowsOf(
		tx,
		sql`SELECT * FROM run WHERE runner_id = ${runnerId} AND status = 'offered' ORDER BY created_at`
	);
	const offers: RunOffer[] = [];
	for (const run of runs) {
		const offer = await buildOffer(tx, run, settings);
		if (offer) offers.push(offer);
	}
	return offers;
}

// ---------------------------------------------------------------- Dispatch

async function candidates(tx: Tx): Promise<Row[]> {
	return rowsOf(
		tx,
		sql`SELECT t.* FROM task t
			JOIN project p ON p.id = t.project_id
			WHERE t.status = 'queued' AND p.archived_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM run r WHERE r.task_id = t.id AND r.status IN ('offered', 'running'))
				AND NOT EXISTS (
					SELECT 1 FROM task_dep d JOIN task dt ON dt.id = d.depends_on_id
					WHERE d.task_id = t.id AND dt.status <> 'done'
				)
				AND (t.parent_id IS NULL OR EXISTS (
					SELECT 1 FROM task pt WHERE pt.id = t.parent_id AND pt.status = 'blocked'
				))
			ORDER BY t.priority DESC, t.created_at, t.id
			LIMIT 500`
	);
}

async function projectStates(tx: Tx, ids: string[]): Promise<ProjectState[]> {
	if (!ids.length) return [];
	const rows = await rowsOf(
		tx,
		sql`SELECT p.id, p.max_parallel, p.preferred_runner_id,
				(SELECT count(DISTINCT r.task_id) FROM run r
					WHERE r.project_id = p.id AND r.status IN ('offered', 'running')) AS running
			FROM project p WHERE p.id IN (${inList(ids)})`
	);
	return rows.map((r) => ({
		id: String(r.id),
		running: num(r.running),
		maxParallel: num(r.max_parallel),
		preferredRunnerId: str(r.preferred_runner_id)
	}));
}

/**
 * Sperre der Branch-Vergabe bis zum Ende der Transaktion: Der Scheduler legt Läufe (und damit Branches) nur unter
 * ihr an; das Branch-Aufräumen (`cleanupMergedBranches`) prüft unter ihr die Nutzung und reserviert die zu
 * löschenden Branches (`branch_cleanup_claim`), die der Scheduler bis zur Freigabe nicht vergibt.
 */
export async function lockBranchAllocation(tx: Tx): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aidev:scheduler'))`);
}

/** Ein Durchlauf: Zuteilungen planen, Läufe anlegen, Angebote sammeln. Liefert die Zahl der Angebote. */
async function dispatchIn(tx: Tx, fx: Effects, settings: AidevSettings): Promise<number> {
	await lockBranchAllocation(tx);
	const rows = await candidates(tx);
	if (!rows.length) return 0;
	const now = Date.now();
	const accounts = await loadAccountViews(tx, now);
	if (!accounts.length) return 0;
	const runnerCaps = await rowsOf(
		tx,
		sql`SELECT id, capabilities->>'question' = 'true' AS question,
				capabilities->>'branchDelivery' = 'true' AS branch,
				capabilities->>'prUpdate' = 'true' AS pr_update,
				capabilities->>'attachments' = 'true' AS attachments FROM runner`
	);
	const runnersWith = (key: string) =>
		new Set(runnerCaps.filter((r) => r[key] === true).map((r) => String(r.id)));
	const questionRunners = runnersWith('question');
	// Auslieferungsarten, die nicht jeder Runner kennt (gemischte Runner-Versionen beim Upgrade)
	const branchRunners = runnersWith('branch');
	const prRunners = runnersWith('pr_update');
	// Aufträge mit (eigenen oder geerbten) Anhängen nur an Runner, die Anhänge bereitstellen können
	const attachmentRunners = runnersWith('attachments');
	const withFiles = new Set(
		[
			...(await effectiveAttachmentRows(
				tx,
				rows.map((r) => String(r.id))
			))
		]
			.filter(([, list]) => list.length > 0)
			.map(([id]) => id)
	);
	const capsFor = (d: Delivery): Set<string> | null => {
		if (d.mode === 'branch') return branchRunners;
		if (d.mode === 'pr-update') return prRunners;
		// Merge in den Head-Branch eines PR: nur Runner, die den PR prüfen und den Branch nie neu anlegen
		if (d.mode === 'integrate' && d.pullNumber !== undefined) return prRunners;
		return null;
	};
	const restricted = new Map<string, Set<string>>();
	// Nur diese Zeilen können eine solche Auslieferung haben (Konfliktlösungen erben sie vom Elternauftrag,
	// Teilaufträge einer PR-Orchestrierung mergen in den PR-Branch).
	const maybeRestricted = rows.filter(
		(r) =>
			!!r.parent_id ||
			r.delivery === 'branch' ||
			(r.target_pr !== null && r.target_pr !== undefined)
	);
	if (maybeRestricted.length) {
		const projects = new Map(
			(
				await rowsOf(
					tx,
					sql`SELECT * FROM project WHERE id IN (${inList([...new Set(maybeRestricted.map((r) => String(r.project_id)))])})`
				)
			).map((p) => [String(p.id), p])
		);
		for (const r of maybeRestricted) {
			const project = projects.get(String(r.project_id));
			if (!project) continue;
			const caps = capsFor(await deliveryOf(tx, r, project));
			if (caps) restricted.set(String(r.id), caps);
		}
	}
	const without = (caps: Set<string> | null) =>
		caps ? accounts.filter((a) => !caps.has(a.state.runnerId)).map((a) => a.state.id) : [];
	const byId = new Map(rows.map((r) => [String(r.id), r]));
	// Verbindungsverluste seit dem letzten Neustart: diese Runner/Konten weich abziehen (anderer Agent bevorzugt)
	const lostTo = await connectionLossTargets(
		tx,
		rows.map((r) => String(r.id))
	);
	const avoid = (id: string) => {
		const t = lostTo.get(id);
		return { avoidRunnerIds: t?.runnerIds ?? [], avoidAccountIds: t?.accountIds ?? [] };
	};
	const tasks: TaskCandidate[] = rows.map((r) => ({
		id: String(r.id),
		projectId: String(r.project_id),
		role: effectiveRole(r),
		priority: num(r.priority),
		createdAt: ms(r.created_at),
		requiredContextK: num(r.required_context_k),
		providerHint: (str(r.provider_hint) as Provider | null) ?? null,
		excludedAccountIds: [
			...stringList(r.excluded_account_ids),
			...(r.chat_question === true ? without(questionRunners) : []),
			...without(restricted.get(String(r.id)) ?? null),
			...(withFiles.has(String(r.id)) ? without(attachmentRunners) : [])
		],
		sessionAccountId: str(r.session_account_id),
		estimatedUnits: settings.limits.estimatedUnitsPerRun,
		...avoid(String(r.id))
	}));
	const assignments = planAssignments({
		tasks,
		accounts: accounts.map((a) => a.state),
		projects: await projectStates(tx, [...new Set(tasks.map((t) => t.projectId))]),
		routing: settings.routing,
		now
	});
	let offers = 0;
	for (const a of assignments) {
		const task = byId.get(a.taskId);
		if (!task) continue;
		const project = await oneOf(tx, sql`SELECT * FROM project WHERE id = ${task.project_id}`);
		if (!project) continue;
		const plan = await branchPlan(tx, task, project);
		// Branch oder Basis wird gerade aufgeräumt → später (Freigabe stößt einen neuen Durchlauf an)
		const claimed = await oneOf(
			tx,
			sql`SELECT 1 AS x FROM branch_cleanup_claim WHERE project_id = ${task.project_id}
				AND branch IN (${plan.branch}, ${plan.baseRef}) AND expires_at > now()`
		);
		if (claimed) continue;
		const runId = crypto.randomUUID();
		const attempt = num(task.attempts) + 1;
		await tx.execute(
			sql`INSERT INTO run (id, task_id, project_id, attempt, runner_id, account_id, provider, model,
					status, lease_expires_at, branch)
				VALUES (${runId}, ${task.id}, ${task.project_id}, ${attempt}, ${a.runnerId}, ${a.accountId},
					${a.provider}, ${a.model ?? ''}, 'offered',
					now() + ${OFFER_LEASE_SEC}::int * interval '1 second', ${plan.branch})`
		);
		const writes = !READ_ONLY_ROLES.includes(effectiveRole(task));
		await tx.execute(
			sql`UPDATE task SET attempts = ${attempt}, updated_at = now(),
					branch = ${writes ? sql`COALESCE(branch, ${plan.branch})` : sql`branch`},
					base_ref = ${writes ? sql`COALESCE(base_ref, ${plan.baseRef})` : sql`base_ref`}
				WHERE id = ${task.id}`
		);
		await tx.execute(
			sql`INSERT INTO usage_ledger (id, account_id, run_id, model, units, source)
				VALUES (${crypto.randomUUID()}, ${a.accountId}, ${runId}, ${a.model ?? ''},
					${settings.limits.estimatedUnitsPerRun}, 'reserved')`
		);
		const run = await oneOf(tx, sql`SELECT * FROM run WHERE id = ${runId}`);
		const offer = run ? await buildOffer(tx, run, settings) : null;
		if (offer) {
			sendCommand(fx, a.runnerId, { type: 'offer', offer });
			offers++;
		}
		fx.tasks.add(String(task.id));
		fx.runs.add(runId);
		fx.overview = true;
	}
	return offers;
}

let chain: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
let stopped = false;

/** Sofort einen Durchlauf ausführen (wartet auf laufende). Liefert die Zahl der Angebote. */
export function dispatch(): Promise<number> {
	stopped = false;
	inflight++;
	const run = chain.then(async () => {
		const settings = await loadSettings();
		const fx = newEffects();
		const n = await mdb().transaction((tx) => dispatchIn(tx, fx, settings));
		// eigener Durchlauf: kein erneuter Anstoß aus den eigenen Wirkungen
		fx.dispatch = false;
		await publish(null, fx);
		return n;
	});
	chain = run.catch(() => undefined).finally(() => inflight--);
	return run;
}

/** Entprellt anstoßen (koalesziert) */
export function requestDispatch(): void {
	if (stopped || timer) return;
	timer = setTimeout(() => {
		timer = null;
		dispatch().catch((e: unknown) => logBestEffort('aidev.scheduler.dispatch', e));
	}, 50);
}

/** Wartet, bis kein Anstoß mehr aussteht und kein Durchlauf läuft (Tests) */
export async function whenDispatchIdle(): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (!timer && inflight === 0) return;
		await new Promise((r) => setTimeout(r, 20));
		await chain;
	}
}

/** Ausstehende Anstöße verwerfen (Modul aus) */
export function stopScheduler(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	stopped = true;
}

/** Nach `stopScheduler` wieder erlauben (Modul an, Tests) */
export function startScheduler(): void {
	stopped = false;
}

// ---------------------------------------------------------------- Sicherheitsnetz (Job)

/** Meldung eines laufenden Laufs, dessen Lease abgelaufen ist */
export const LEASE_EXPIRED_MESSAGE = 'Runner meldet sich nicht mehr (Lease abgelaufen)';

/**
 * Einen Lauf mit abgelaufener Lease freigeben. Eigene Transaktion je Lauf und Sperrreihenfolge **Auftrag → Lauf**
 * wie beim Neustart/Abbrechen (`requireTask(…, true)` → `cancelActiveRuns`), damit gleichzeitiges Neustarten
 * keinen Deadlock auslöst. Nach dem Sperren wird erneut geprüft: Ein inzwischen eingetroffener Heartbeat
 * (verlängerte Lease) oder ein Neustart (Lauf beendet) hat Vorrang. Liefert `true`, wenn der Lauf verloren ging.
 */
export async function expireRunLease(runId: string, taskId: string): Promise<boolean> {
	const fx = newEffects();
	const lost = await mdb().transaction(async (tx) => {
		await getTask(tx, taskId, true);
		const run = await oneOf(
			tx,
			sql`SELECT * FROM run WHERE id = ${runId} AND status IN ('offered', 'running')
				AND lease_expires_at < now() FOR UPDATE`
		);
		if (!run) return false;
		// nie angenommen → ungezählt zurück; lief bereits → Verbindungsverlust (automatisch neu eingeplant)
		if (run.status === 'offered') {
			await loseRun(tx, fx, run, 'Angebot nicht rechtzeitig angenommen', false);
		} else {
			await loseRun(tx, fx, run, LEASE_EXPIRED_MESSAGE, false, { connection: true });
		}
		return true;
	});
	await publish(null, fx);
	return lost;
}

/** Abgelaufene Leases → `lost`, Runner ohne Heartbeat → offline, danach Dispatch */
export async function schedulerTick(): Promise<string> {
	const expired = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, task_id FROM run WHERE status IN ('offered', 'running') AND lease_expires_at < now()
				ORDER BY created_at`
		)
	);
	let lost = 0;
	for (const run of expired) {
		// ein fehlgeschlagener Lauf (z. B. Sperrkonflikt) hält die übrigen nicht auf – nächster Tick versucht es erneut
		try {
			if (await expireRunLease(String(run.id), String(run.task_id))) lost++;
		} catch (e) {
			logBestEffort('aidev.scheduler.lease', e, { target: String(run.id) });
		}
	}
	const fx = newEffects();
	const offline = await mdb().transaction(async (tx) => {
		const stale = await rowsOf(
			tx,
			sql`UPDATE runner SET online = false
				WHERE online AND (last_seen_at IS NULL
					OR last_seen_at < now() - ${RUNNER_STALE_SEC}::int * interval '1 second')
				RETURNING id`
		);
		if (stale.length) fx.overview = true;
		return stale.length;
	});
	await publish(null, fx);
	const offers = await dispatch();
	return `${lost} Läufe verloren, ${offline} Runner offline, ${offers} Angebote`;
}
