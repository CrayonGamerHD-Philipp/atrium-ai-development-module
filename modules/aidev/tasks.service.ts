/**
 * Zustandslogik der Aufträge (nur Datenbank, Nebenwirkungen über `Effects`).
 *
 * Grundregeln
 * - Ein Auftrag `queued` ist Kandidat für den Scheduler, solange er keinen Lauf im Zustand `offered`/`running` hat,
 *   alle Abhängigkeiten (`task_dep`) `done` sind und – bei Teilaufträgen – der Elternauftrag `blocked` ist.
 *   Teilaufträge werden daher immer `queued` angelegt; offene Abhängigkeiten prüft allein der Scheduler.
 * - Vergabe zählt den Versuch (`attempts + 1`); der Auftrag bleibt `queued`, bis der Runner annimmt (`running`).
 *   Abgelehnte, nie angenommene, abgebrochene und durch Limits beendete Läufe zählen nicht (Rückbuchung).
 *
 * Orchestrierung (Rolle `orchestrate`, „Planen & aufteilen“)
 * 1. Planungslauf (nur lesen, `expectPlan`). Erfolg → Plan aus `finish.plan` bzw. `extractPlan(summary)` gegen
 *    `planSchema` prüfen (eindeutige Schlüssel, bekannte Abhängigkeiten, kein Zyklus per `findCycle`).
 *    Ungültig → normaler Fehlversuch. Gültig → Teilaufträge (position = Index, Abhängigkeiten über `key`),
 *    Plan in `task.plan` (mit `delivered: false`), `task.branch` = Integrations-Branch `aidev/<kurz-id>-<slug>`,
 *    Elternauftrag `blocked`.
 * 2. Teilaufträge laufen auf `aidev/<eltern-kurz>/<n>-<slug>` mit Basis = Integrations-Branch und Auslieferung
 *    `integrate` (Runner legt den Integrations-Branch aus dem Haupt-Branch an, falls er noch fehlt).
 * 3. Sind alle Teilaufträge (ohne Konfliktlösungen) beendet und mindestens einer `done` (abgebrochene zählen als
 *    erledigt), wird der Elternauftrag wieder `queued` (Versuche = 0) für den Lauf „Ausliefern“: Rolle
 *    `implement`, schreibend, auf dem Integrations-Branch, Auslieferung nach Projekt-Policy (PR / Auto-Merge /
 *    direkt). Erfolg → `plan.delivered = true`, danach wie jeder Auftrag (`review` bzw. `done`).
 *    Sind alle Teilaufträge abgebrochen, wird der Elternauftrag `cancelled`.
 * 4. Ein Teilauftrag endgültig `failed` → Elternauftrag `failed`; offene Teilaufträge ohne aktiven Lauf werden
 *    abgebrochen (laufende enden regulär, ändern den Elternauftrag aber nicht mehr). „Neu starten“ am
 *    Elternauftrag setzt fehlgeschlagene/abgebrochene (`subtasks: 'all'`: alle) Teilaufträge zurück und blockiert
 *    ihn erneut. „Neu starten“ an einem Teilauftrag öffnet gescheiterte Vorfahren wieder (→ `blocked`), samt der
 *    nur deshalb abgebrochenen Geschwister.
 *
 * Konflikte (`finish.status = failed`, `errorKind = conflict`)
 * - Es entsteht ein Kind-Auftrag Rolle `resolve` (Konfliktdateien in `plan.conflictFiles` und im Prompt), auf
 *   demselben Branch mit derselben Auslieferung wie der ursprüngliche Auftrag; dieser wird `blocked`.
 * - Erfolg der Konfliktlösung → ihr Ergebnis (PR, Merge) gilt für den ursprünglichen Auftrag (`review`/`done`).
 * - Scheitert die Konfliktlösung nach `max_attempts` (oder wird sie abgebrochen) → ursprünglicher Auftrag
 *   `needs-input`. Konflikte innerhalb einer Konfliktlösung erzeugen keine weitere Konfliktlösung.
 *
 * Chat: Erreicht ein Auftrag ohne Elternteil `done`/`review`/`failed`/`needs-input` (Teilaufträge nur bei
 * `needs-input`), entsteht eine `agent`-Nachricht mit Titel, Ergebnis und ggf. PR im Projekt-Chat.
 * Aktionsvorschläge (`aidev-actions`-Block, `actions.ts`) von Chat-Fragen und einfachen Aufträgen werden dabei aus
 * dem Ergebnis entfernt und als `pending` an der Nachricht gespeichert (`chat_message.actions`).
 */
import { sql } from 'drizzle-orm';
import { errors, inList, num, rowsOf, str, type RequestContext } from '$lib/sdk/server';
import { extractChatActions, type ChatAction, type StoredChatAction } from './actions';
import { linkAttachments } from './attachments.service';
import { clip, jsonb, jsonOf, oneOf, shortId, stringList, type Row, type Tx } from './db';
import type { Effects } from './effects';
import { sendCommand } from './effects';
import { slugify, slugOrNull, titleFromPrompt } from './prompts';
import { planSchema, READ_ONLY_ROLES, type Plan, type Role } from './protocol';
import { findCycle } from './scheduler';
import {
	FINAL_TASK_STATUSES,
	PERM,
	type TaskInput,
	type TaskPatch,
	type TaskStatus
} from './schemas';

/** Gespeicherter Plan eines Orchestrierungs-Auftrags */
export type StoredPlan = Plan & { delivered: boolean };
/** Zusatzdaten einer Konfliktlösung (in `task.plan`) */
export interface ResolveInfo {
	kind: 'resolve';
	conflictFiles: string[];
}

export const isFinal = (s: unknown) => FINAL_TASK_STATUSES.includes(String(s) as TaskStatus);

export async function getTask(tx: Tx, id: string, forUpdate = false): Promise<Row | null> {
	return oneOf(
		tx,
		forUpdate
			? sql`SELECT * FROM task WHERE id = ${id} FOR UPDATE`
			: sql`SELECT * FROM task WHERE id = ${id}`
	);
}

export async function requireTask(tx: Tx, id: string, forUpdate = false): Promise<Row> {
	const task = await getTask(tx, id, forUpdate);
	if (!task) throw errors.notFound('Auftrag nicht gefunden');
	return task;
}

/** Plan eines Orchestrierungs-Auftrags (nach dem Planungslauf), sonst `null` */
export function planOf(task: Row): StoredPlan | null {
	if (task.role !== 'orchestrate') return null;
	const plan = jsonOf<StoredPlan | null>(task.plan, null);
	return plan && Array.isArray(plan.subtasks) ? plan : null;
}

export function resolveInfoOf(task: Row): ResolveInfo | null {
	if (task.role !== 'resolve') return null;
	const info = jsonOf<ResolveInfo | null>(task.plan, null);
	return info ? { kind: 'resolve', conflictFiles: stringList(info.conflictFiles) } : null;
}

/** Rolle des nächsten Laufs: Orchestrierung mit Plan → Ausliefern (`implement`) */
export function effectiveRole(task: Row): Role {
	if (planOf(task)) return 'implement';
	return String(task.role) as Role;
}

export const isReadOnlyRun = (task: Row) => READ_ONLY_ROLES.includes(effectiveRole(task));

/** Integrations-Branch bzw. Arbeits-Branch eines Auftrags ohne Elternteil */
export const topBranchOf = (task: Row) =>
	`aidev/${shortId(String(task.id))}-${slugify(String(task.title))}`;

/**
 * Integrations-Branch einer Orchestrierung bei Plan-Übernahme: ein gespeicherter Branch (z. B. Head-Branch des
 * bestehenden PRs) hat Vorrang, sonst der Namensvorschlag des Plans (`plan.branch`), sonst `topBranchOf`.
 */
export function integrationBranchOf(parent: Row, plan: Pick<Plan, 'branch'>): string {
	const stored = str(parent.branch);
	if (stored) return stored;
	const hasTargetPr = parent.target_pr !== null && parent.target_pr !== undefined;
	const suggested = hasTargetPr ? null : slugOrNull(plan.branch);
	return suggested ? `aidev/${shortId(String(parent.id))}-${suggested}` : topBranchOf(parent);
}

// ---------------------------------------------------------------- Zugriff

/** Eigene Aufträge mit `task.create`, fremde nur mit `task.manage` (alle mit `project.view` sehen alles) */
export function assertCanEditTask(ctx: RequestContext, task: Row): void {
	if (ctx.permissions.has(PERM.taskManage)) return;
	if (ctx.permissions.has(PERM.taskCreate) && ctx.userId && str(task.created_by) === ctx.userId) {
		return;
	}
	throw errors.forbidden(
		ctx.permissions.has(PERM.taskCreate)
			? 'Fremde Aufträge darf nur bearbeiten, wer alle Aufträge verwalten darf'
			: 'Keine Berechtigung für diesen Auftrag'
	);
}

// ---------------------------------------------------------------- Chat

export async function insertChat(
	tx: Tx,
	fx: Effects,
	m: {
		projectId: string;
		taskId: string | null;
		kind: 'user' | 'agent' | 'system';
		body: string;
		authorUserId?: string | null;
		/** Aktionsvorschläge des Agents (nur `agent`-Nachrichten) */
		actions?: StoredChatAction[] | null;
	}
): Promise<string> {
	const id = crypto.randomUUID();
	const actions = m.actions?.length ? jsonb(m.actions) : null;
	await tx.execute(
		sql`INSERT INTO chat_message (id, project_id, task_id, author_user_id, kind, body, actions)
			VALUES (${id}, ${m.projectId}, ${m.taskId}, ${m.authorUserId ?? null}, ${m.kind}, ${clip(m.body, m.kind === 'agent' ? 40_000 : 20_000)}, ${actions})`
	);
	fx.chat.add(id);
	return id;
}

/** Rollen einfacher Aufträge, deren Agent Plattformaktionen vorschlagen darf */
const ACTION_ROLES: Role[] = ['research', 'implement', 'review', 'fix'];

/** Darf das Ergebnis dieses Auftrags Aktionsvorschläge enthalten? (Chat-Fragen und einfache Aufträge ohne Plan) */
function acceptsChatActions(task: Row): boolean {
	if (task.parent_id) return false;
	if (task.chat_question === true) return true;
	return ACTION_ROLES.includes(String(task.role) as Role) && !planOf(task);
}

/** Neue, noch nicht entschiedene Vorschläge */
export function pendingActions(actions: ChatAction[]): StoredChatAction[] {
	return actions.map((action) => ({
		action,
		state: 'pending',
		taskId: null,
		error: null,
		decidedBy: null,
		decidedAt: null
	}));
}

function agentText(task: Row, status: TaskStatus): string {
	if (task.chat_question === true) {
		if (status === 'done') return str(task.result_summary) ?? 'Keine Antwort erhalten.';
		if (status === 'cancelled') return 'Frage abgebrochen.';
		return `Frage fehlgeschlagen: ${str(task.error_message) ?? 'Unbekannter Fehler'}`;
	}
	const title = `„${String(task.title)}“`;
	const summary = str(task.result_summary);
	const error = str(task.error_message);
	const pr = task.pr_number !== null && task.pr_number !== undefined ? num(task.pr_number) : null;
	const prLine = pr ? `Pull Request #${pr}${task.pr_url ? `: ${String(task.pr_url)}` : ''}` : null;
	const parts: string[] = [];
	switch (status) {
		case 'done':
			parts.push(`Auftrag ${title} ist fertig.`);
			break;
		case 'review':
			parts.push(`Auftrag ${title} ist umgesetzt – der Pull Request wartet auf Prüfung.`);
			break;
		case 'failed':
			parts.push(`Auftrag ${title} ist fehlgeschlagen${error ? `: ${error}` : '.'}`);
			break;
		case 'needs-input':
			parts.push(`Auftrag ${title} braucht eine Rückmeldung${error ? `: ${error}` : '.'}`);
			break;
		default:
			parts.push(`Auftrag ${title}: ${status}`);
	}
	if (prLine) parts.push(prLine);
	if (
		(status === 'done' || status === 'review') &&
		task.target_pr !== null &&
		task.target_pr !== undefined
	) {
		parts.push(`PR #${num(task.target_pr)} aktualisiert.`);
	}
	if (status === 'done' && task.branch_pushed === true && task.branch) {
		parts.push(`Branch bereitgestellt: ${String(task.branch)} (ohne Pull Request).`);
	}
	if (summary && (status === 'done' || status === 'review')) parts.push(clip(summary, 4000));
	return parts.join('\n\n');
}

// ---------------------------------------------------------------- Zustandswechsel

const FINISHED_STATES: TaskStatus[] = ['done', 'failed', 'cancelled', 'review', 'needs-input'];

export interface TransitionOptions {
	/** `undefined` = unverändert, `null` = löschen */
	error?: string | null;
	summary?: string | null;
	resetAttempts?: boolean;
}

/** Status setzen, Folgen für Elternauftrag und Chat auslösen; liefert die neue Zeile */
export async function transition(
	tx: Tx,
	fx: Effects,
	id: string,
	status: TaskStatus,
	opts: TransitionOptions = {}
): Promise<Row> {
	const finished = FINISHED_STATES.includes(status);
	const row = await oneOf(
		tx,
		sql`UPDATE task SET status = ${status}, updated_at = now(),
				finished_at = ${finished ? sql`now()` : sql`NULL`},
				error_message = ${opts.error === undefined ? sql`error_message` : sql`${opts.error === null ? null : clip(opts.error, 4000)}`},
				result_summary = ${opts.summary === undefined || opts.summary === null ? sql`result_summary` : sql`${opts.summary}`},
				attempts = ${opts.resetAttempts ? sql`0` : sql`attempts`}
			WHERE id = ${id} RETURNING *`
	);
	if (!row) throw errors.notFound('Auftrag nicht gefunden');
	fx.tasks.add(id);
	fx.overview = true;
	if (status === 'queued') fx.dispatch = true;
	const hasParent = !!row.parent_id;
	if (
		(!hasParent &&
			(['done', 'review', 'failed', 'needs-input'].includes(status) ||
				(row.chat_question === true && status === 'cancelled'))) ||
		(hasParent && status === 'needs-input')
	) {
		let actions: StoredChatAction[] = [];
		let note = '';
		const summary = str(row.result_summary);
		if ((status === 'done' || status === 'review') && summary && acceptsChatActions(row)) {
			const found = extractChatActions(summary);
			if (found.actions.length || found.invalid) {
				// Block aus dem Ergebnis entfernen – sichtbar bleibt nur der Text, die Vorschläge hängen an der Nachricht
				const stripped = found.body.trim() ? found.body : null;
				await tx.execute(sql`UPDATE task SET result_summary = ${stripped} WHERE id = ${id}`);
				row.result_summary = stripped;
				actions = pendingActions(found.actions);
				if (found.invalid) {
					note =
						found.invalid === 1
							? 'Hinweis: 1 ungültiger Vorschlag wurde ignoriert.'
							: `Hinweis: ${found.invalid} ungültige Vorschläge wurden ignoriert.`;
				}
			}
		}
		const text = agentText(row, status);
		await insertChat(tx, fx, {
			projectId: String(row.project_id),
			taskId: id,
			kind: 'agent',
			body: note ? `${text}\n\n${note}` : text,
			actions
		});
	}
	await propagate(tx, fx, row);
	return row;
}

/** Folgen eines Statuswechsels für den Elternauftrag */
async function propagate(tx: Tx, fx: Effects, task: Row): Promise<void> {
	if (!task.parent_id) return;
	const status = String(task.status) as TaskStatus;
	const parent = await getTask(tx, String(task.parent_id), true);
	if (!parent) return;

	if (task.role === 'resolve') {
		// Erfolg übernimmt `applyOutcome` direkt; Scheitern/Abbruch → Rückfrage am ursprünglichen Auftrag
		if ((status === 'failed' || status === 'cancelled') && parent.status === 'blocked') {
			await transition(tx, fx, String(parent.id), 'needs-input', {
				error:
					status === 'failed'
						? 'Der Konflikt konnte nicht automatisch gelöst werden – bitte Hinweise geben oder selbst lösen'
						: 'Die Konfliktlösung wurde abgebrochen'
			});
		}
		return;
	}

	if (parent.role !== 'orchestrate' || isFinal(parent.status)) return;

	if (status === 'failed') {
		await failChildrenOf(tx, fx, String(parent.id), String(task.id));
		await transition(tx, fx, String(parent.id), 'failed', {
			error: `Teilauftrag „${String(task.title)}“ ist fehlgeschlagen${task.error_message ? `: ${String(task.error_message)}` : ''}`
		});
		return;
	}
	if ((status === 'done' || status === 'cancelled') && parent.status === 'blocked') {
		const children = await rowsOf(
			tx,
			sql`SELECT status FROM task WHERE parent_id = ${parent.id} AND role <> 'resolve'`
		);
		if (!children.every((c) => c.status === 'done' || c.status === 'cancelled')) return;
		if (children.some((c) => c.status === 'done')) {
			await transition(tx, fx, String(parent.id), 'queued', { error: null, resetAttempts: true });
		} else {
			await transition(tx, fx, String(parent.id), 'cancelled', {
				error: 'Alle Teilaufträge wurden abgebrochen'
			});
		}
	}
}

/** Begründung an Geschwistern, die `failChildrenOf` abbricht (erkennt der Neustart eines Teilauftrags wieder) */
const CANCELLED_BY_SIBLING = 'Abgebrochen, weil ein anderer Teilauftrag fehlgeschlagen ist';

/** Offene Geschwister ohne aktiven Lauf abbrechen (Elternauftrag scheitert) */
async function failChildrenOf(tx: Tx, fx: Effects, parentId: string, exceptId: string) {
	const rows = await rowsOf(
		tx,
		sql`UPDATE task t SET status = 'cancelled', updated_at = now(), finished_at = now(),
				error_message = ${CANCELLED_BY_SIBLING}
			WHERE t.parent_id = ${parentId} AND t.id <> ${exceptId}
				AND t.status NOT IN ('done', 'failed', 'cancelled')
				AND NOT EXISTS (SELECT 1 FROM run r WHERE r.task_id = t.id AND r.status IN ('offered', 'running'))
			RETURNING t.id`
	);
	for (const r of rows) fx.tasks.add(String(r.id));
}

/** Konto für diesen Auftrag nicht mehr wählen */
export async function excludeAccount(tx: Tx, taskId: string, accountId: string | null) {
	if (!accountId) return;
	await tx.execute(
		sql`UPDATE task SET excluded_account_ids = (
				SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb)
				FROM jsonb_array_elements_text(excluded_account_ids || ${jsonb([accountId])}) AS x
			)
			WHERE id = ${taskId}`
	);
}

// ---------------------------------------------------------------- Anlegen

export async function createTask(
	tx: Tx,
	fx: Effects,
	ctx: RequestContext,
	project: Row,
	input: TaskInput
): Promise<string> {
	if (project.archived_at) throw errors.conflict('Das Projekt ist archiviert');
	const deps = [...new Set(input.dependsOn)];
	if (deps.length) {
		const found = await rowsOf(
			tx,
			sql`SELECT id FROM task WHERE id IN (${inList(deps)}) AND project_id = ${project.id}`
		);
		if (found.length !== deps.length) {
			throw errors.validation([
				{ path: ['dependsOn'], message: 'Unbekannte Abhängigkeit (nur Aufträge dieses Projekts)' }
			]);
		}
	}
	// Bestehenden PR bearbeiten: Branch = Head-Branch des PR, Basis = Haupt-Branch des Projekts
	let target: { number: number; branch: string; baseRef: string; url: string | null } | null = null;
	if (input.targetPr !== null) {
		const main = String(project.default_branch);
		const pr = await oneOf(
			tx,
			sql`SELECT number, branch, state, url FROM pull_request
				WHERE project_id = ${project.id} AND number = ${input.targetPr}`
		);
		const fail = (message: string) => errors.validation([{ path: ['targetPr'], message }]);
		if (!pr) throw fail('PR nicht gefunden – Pull Requests zuerst synchronisieren');
		if (pr.state !== 'open') throw fail('Nur offene PRs können bearbeitet werden');
		const branch = str(pr.branch);
		if (!branch || branch === main) {
			throw fail('Der PR hat keinen bearbeitbaren Branch (fehlt oder ist der Haupt-Branch)');
		}
		target = { number: num(pr.number), branch, baseRef: main, url: str(pr.url) };
	}
	const id = crypto.randomUUID();
	const title = clip(input.title?.trim() || titleFromPrompt(input.prompt) || 'Auftrag', 200);
	const role: Role = input.decompose ? 'orchestrate' : input.role;
	await tx.execute(
		sql`INSERT INTO task (id, project_id, title, prompt, role, status, priority, max_attempts,
				provider_hint, created_by, delivery, target_pr, branch, base_ref, pr_number, pr_url)
			VALUES (${id}, ${project.id}, ${title}, ${input.prompt}, ${role},
				${input.draft ? 'draft' : 'queued'}, ${input.priority}, ${input.maxAttempts},
				${input.providerHint}, ${ctx.userId}, ${input.delivery}, ${target?.number ?? null},
				${target?.branch ?? null}, ${target?.baseRef ?? null}, ${target?.number ?? null},
				${target?.url ?? null})`
	);
	for (const dep of deps) {
		await tx.execute(sql`INSERT INTO task_dep (task_id, depends_on_id) VALUES (${id}, ${dep})`);
	}
	// eigene Uploads dieses Projekts verknüpfen (geprüft in `linkAttachments`, sonst 422)
	await linkAttachments(tx, input.attachmentIds ?? [], {
		projectId: String(project.id),
		userId: ctx.userId,
		taskId: id
	});
	fx.tasks.add(id);
	fx.overview = true;
	if (!input.draft) fx.dispatch = true;
	fx.audits.push({
		action: 'aidev.task.created',
		target: id,
		metadata: { projectId: String(project.id), role, draft: input.draft }
	});
	return id;
}

// ---------------------------------------------------------------- Ändern

/**
 * Auftrag ändern (`PATCH /tasks/:id`, Vorschlag „Auftrag ändern“): Rechte wie `assertCanEditTask`; der Auftragstext
 * ist nur änderbar, solange kein Lauf aktiv ist. `task` vorher mit `FOR UPDATE` laden.
 */
export async function updateTask(
	tx: Tx,
	fx: Effects,
	ctx: RequestContext,
	task: Row,
	patch: TaskPatch
): Promise<void> {
	assertCanEditTask(ctx, task);
	if (patch.prompt !== undefined && patch.prompt !== task.prompt) {
		const active = await oneOf(
			tx,
			sql`SELECT 1 FROM run WHERE task_id = ${task.id} AND status IN ('offered', 'running') LIMIT 1`
		);
		if (active || task.status === 'running') {
			throw errors.conflict('Der Auftragstext lässt sich während eines Laufs nicht ändern');
		}
	}
	await tx.execute(
		sql`UPDATE task SET title = ${patch.title ?? String(task.title)},
				prompt = ${patch.prompt ?? String(task.prompt)},
				priority = ${patch.priority ?? num(task.priority)},
				provider_hint = ${patch.providerHint === undefined ? str(task.provider_hint) : patch.providerHint},
				max_attempts = ${patch.maxAttempts ?? num(task.max_attempts)},
				updated_at = now()
			WHERE id = ${task.id}`
	);
	fx.tasks.add(String(task.id));
	fx.dispatch = true;
}

// ---------------------------------------------------------------- Plan

export type PlanCheck = { ok: true; plan: Plan } | { ok: false; error: string };

/** Plan prüfen: Schema, eindeutige Schlüssel, bekannte Abhängigkeiten, kein Zyklus */
export function checkPlan(raw: unknown): PlanCheck {
	if (raw === null || raw === undefined) return { ok: false, error: 'Kein Plan gefunden' };
	const parsed = planSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			error: `Plan ungültig${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}`
		};
	}
	const plan = parsed.data;
	const keys = new Set<string>();
	for (const st of plan.subtasks) {
		if (keys.has(st.key))
			return { ok: false, error: `Plan ungültig: Schlüssel „${st.key}“ doppelt` };
		keys.add(st.key);
	}
	const graph = new Map<string, string[]>();
	for (const st of plan.subtasks) {
		for (const dep of st.dependsOn) {
			if (!keys.has(dep)) {
				return { ok: false, error: `Plan ungültig: unbekannte Abhängigkeit „${dep}“` };
			}
			if (dep === st.key) return { ok: false, error: `Plan ungültig: „${dep}“ hängt von sich ab` };
		}
		graph.set(st.key, [...new Set(st.dependsOn)]);
	}
	const cycle = findCycle(graph);
	if (cycle) return { ok: false, error: `Plan ungültig: Zyklus ${cycle.join(' → ')}` };
	return { ok: true, plan };
}

/** Teilaufträge aus einem geprüften Plan anlegen, Elternauftrag blockieren */
export async function applyPlan(
	tx: Tx,
	fx: Effects,
	parent: Row,
	plan: Plan,
	summary: string | null
): Promise<void> {
	const ids = new Map<string, string>();
	for (const st of plan.subtasks) ids.set(st.key, crypto.randomUUID());
	let position = 0;
	for (const st of plan.subtasks) {
		const id = ids.get(st.key)!;
		await tx.execute(
			sql`INSERT INTO task (id, project_id, parent_id, position, title, prompt, role, status, priority,
					max_attempts, provider_hint, required_context_k, created_by)
				VALUES (${id}, ${parent.project_id}, ${parent.id}, ${position}, ${clip(st.title, 200)},
					${st.prompt}, ${st.role}, 'queued', ${num(parent.priority)}, ${num(parent.max_attempts)},
					${st.provider ?? null}, ${num(parent.required_context_k)}, ${str(parent.created_by)})`
		);
		position++;
		fx.tasks.add(id);
	}
	for (const st of plan.subtasks) {
		for (const dep of new Set(st.dependsOn)) {
			await tx.execute(
				sql`INSERT INTO task_dep (task_id, depends_on_id) VALUES (${ids.get(st.key)!}, ${ids.get(dep)!})`
			);
		}
	}
	const stored: StoredPlan = { ...plan, delivered: false };
	// Bestehender PR: dessen Head-Branch bleibt der Integrations-Branch (Ausliefern pusht in den PR)
	const integrationBranch = integrationBranchOf(parent, plan);
	await tx.execute(
		sql`UPDATE task SET plan = ${jsonb(stored)}, branch = ${integrationBranch},
				base_ref = ${null}, updated_at = now()
			WHERE id = ${parent.id}`
	);
	await transition(tx, fx, String(parent.id), 'blocked', {
		error: null,
		summary: plan.summary || summary
	});
	fx.dispatch = true;
}

// ---------------------------------------------------------------- Konflikte

export async function createResolveTask(
	tx: Tx,
	fx: Effects,
	original: Row,
	conflictFiles: string[],
	branch: string | null
): Promise<string> {
	const [pos] = await rowsOf(
		tx,
		sql`SELECT COALESCE(max(position), -1) + 1 AS p FROM task WHERE parent_id = ${original.id}`
	);
	const id = crypto.randomUUID();
	const files = conflictFiles.length
		? conflictFiles.map((f) => `- ${f}`).join('\n')
		: '(keine Dateien gemeldet)';
	const prompt =
		`Beim Zusammenführen des Branches für den Auftrag „${String(original.title)}“ sind Konflikte entstanden.\n` +
		`Löse die Konflikte, sodass beide Seiten sinnvoll erhalten bleiben, führe die Tests aus und schließe die ` +
		`Zusammenführung ab.\n\nDateien mit Konflikten:\n${files}\n\nUrsprünglicher Auftrag:\n${clip(String(original.prompt), 8000)}`;
	const info: ResolveInfo = { kind: 'resolve', conflictFiles };
	await tx.execute(
		sql`INSERT INTO task (id, project_id, parent_id, position, title, prompt, role, status, priority,
				max_attempts, branch, base_ref, plan, created_by)
			VALUES (${id}, ${original.project_id}, ${original.id}, ${num(pos?.p)},
				${clip(`Konflikt lösen: ${String(original.title)}`, 200)}, ${prompt}, 'resolve', 'queued',
				${num(original.priority)}, ${num(original.max_attempts)},
				${branch ?? str(original.branch)}, ${str(original.base_ref)}, ${jsonb(info)},
				${str(original.created_by)})`
	);
	fx.tasks.add(id);
	fx.dispatch = true;
	return id;
}

// ---------------------------------------------------------------- Ergebnis übernehmen

export interface PullInfo {
	number: number;
	url: string;
	branch: string | null;
	merged: boolean;
}

export async function upsertPull(
	tx: Tx,
	fx: Effects,
	projectId: string,
	taskId: string | null,
	title: string,
	pr: PullInfo
): Promise<void> {
	await tx.execute(
		sql`INSERT INTO pull_request (project_id, number, task_id, title, branch, state, url, synced_at)
			VALUES (${projectId}, ${pr.number}, ${taskId}, ${clip(title, 300)}, ${pr.branch ?? ''},
				${pr.merged ? 'merged' : 'open'}, ${pr.url}, now())
			ON CONFLICT (project_id, number) DO UPDATE SET
				task_id = COALESCE(EXCLUDED.task_id, pull_request.task_id),
				url = EXCLUDED.url,
				branch = CASE WHEN EXCLUDED.branch <> '' THEN EXCLUDED.branch ELSE pull_request.branch END,
				state = CASE WHEN EXCLUDED.state = 'merged' THEN 'merged' ELSE pull_request.state END,
				updated_at = now()`
	);
	fx.pulls.add(`${projectId}:${pr.number}`);
}

/** Erfolgreiche Auslieferung übernehmen: PR → `review` (gemergt → `done`), sonst `done` */
export async function applyOutcome(
	tx: Tx,
	fx: Effects,
	task: Row,
	outcome: { pr: PullInfo | null; summary: string | null }
): Promise<void> {
	let status: TaskStatus = 'done';
	if (outcome.pr) {
		await upsertPull(
			tx,
			fx,
			String(task.project_id),
			String(task.id),
			String(task.title),
			outcome.pr
		);
		await tx.execute(
			sql`UPDATE task SET pr_number = ${outcome.pr.number}, pr_url = ${outcome.pr.url} WHERE id = ${task.id}`
		);
		status = outcome.pr.merged ? 'done' : 'review';
	}
	await transition(tx, fx, String(task.id), status, { error: null, summary: outcome.summary });
}

/** PR-Zustand (Sync) auf den zugehörigen Auftrag übertragen: gemergt → `done`, geschlossen → `failed` */
export async function applyPullState(
	tx: Tx,
	fx: Effects,
	task: Row,
	state: 'open' | 'merged' | 'closed'
): Promise<void> {
	if (task.status !== 'review') return;
	if (state === 'merged') await transition(tx, fx, String(task.id), 'done', { error: null });
	else if (state === 'closed') {
		await transition(tx, fx, String(task.id), 'failed', { error: 'PR geschlossen' });
	}
}

// ---------------------------------------------------------------- Abbrechen, Wiederholen, Antworten

/** IDs aller Nachfahren (Teilaufträge, Konfliktlösungen) */
export async function descendantIds(tx: Tx, id: string): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE d AS (
				SELECT id FROM task WHERE parent_id = ${id}
				UNION ALL SELECT t.id FROM task t JOIN d ON t.parent_id = d.id
			) SELECT id FROM d`
	);
	return rows.map((r) => String(r.id));
}

/**
 * Aktive Läufe der Aufträge abbrechen: `cancel`-Befehl an den Runner, angebotene Läufe enden sofort
 * (Reservierung entfällt). `finishRunning`: auch laufende sofort als `cancelled` beenden (Reservierung wie bei
 * `loseRun` abrechnen), damit direkt ein neuer Lauf geplant werden kann – spätere Meldungen des Runners zu
 * diesem Lauf ändern nichts mehr (`finishRun` nur für aktive Läufe, der Heartbeat bricht ihn ab).
 */
async function cancelActiveRuns(
	tx: Tx,
	fx: Effects,
	taskIds: string[],
	reason: string,
	finishRunning = false
): Promise<Row[]> {
	if (!taskIds.length) return [];
	const runs = await rowsOf(
		tx,
		sql`SELECT id, runner_id, status FROM run
			WHERE task_id IN (${inList(taskIds)}) AND status IN ('offered', 'running')
			FOR UPDATE`
	);
	for (const r of runs) {
		sendCommand(fx, str(r.runner_id), { type: 'cancel', runId: String(r.id), reason });
		fx.runs.add(String(r.id));
		if (r.status === 'offered') {
			await tx.execute(
				sql`UPDATE run SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL,
						error_kind = 'cancelled', error_message = 'Vor dem Start abgebrochen'
					WHERE id = ${r.id}`
			);
			await tx.execute(
				sql`DELETE FROM usage_ledger WHERE run_id = ${r.id} AND source = 'reserved'`
			);
		} else if (finishRunning) {
			await tx.execute(
				sql`UPDATE run SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL,
						error_kind = 'cancelled', error_message = ${reason}
					WHERE id = ${r.id}`
			);
			// wie `settleReservation`: gemeldeter Verbrauch ersetzt die Reservierung, sonst bleibt sie als Schätzung
			const reported = await oneOf(
				tx,
				sql`SELECT 1 FROM usage_ledger WHERE run_id = ${r.id} AND source = 'reported' LIMIT 1`
			);
			await tx.execute(
				reported
					? sql`DELETE FROM usage_ledger WHERE run_id = ${r.id} AND source = 'reserved'`
					: sql`UPDATE usage_ledger SET source = 'estimated' WHERE run_id = ${r.id} AND source = 'reserved'`
			);
		}
	}
	if (runs.length) {
		fx.overview = true;
		fx.dispatch = true;
	}
	return runs;
}

/**
 * Auftrag und offene Nachfahren abbrechen. Angebotene Läufe enden sofort (`cancelled`), laufende bekommen einen
 * `cancel`-Befehl und behalten ihren Status bis `finish`/Heartbeat.
 */
export async function cancelTask(tx: Tx, fx: Effects, task: Row): Promise<void> {
	if (isFinal(task.status)) throw errors.conflict('Der Auftrag ist bereits beendet');
	const ids = [String(task.id), ...(await descendantIds(tx, String(task.id)))];
	const runs = await cancelActiveRuns(tx, fx, ids, 'Auftrag abgebrochen');
	const rest = ids.slice(1);
	if (rest.length) {
		const rows = await rowsOf(
			tx,
			sql`UPDATE task SET status = 'cancelled', updated_at = now(), finished_at = now()
				WHERE id IN (${inList(rest)}) AND status NOT IN ('done', 'failed', 'cancelled')
				RETURNING id`
		);
		for (const r of rows) fx.tasks.add(String(r.id));
	}
	await transition(tx, fx, String(task.id), 'cancelled');
	fx.audits.push({
		action: 'aidev.task.cancelled',
		target: String(task.id),
		metadata: { projectId: String(task.project_id), runs: runs.length }
	});
}

/** Abbrechen im Namen einer Person (`POST /tasks/:id/cancel`, Vorschlag „Auftrag abbrechen“): mit Rechteprüfung */
export async function cancelTaskAs(
	tx: Tx,
	fx: Effects,
	ctx: RequestContext,
	task: Row
): Promise<void> {
	assertCanEditTask(ctx, task);
	await cancelTask(tx, fx, task);
}

async function assertParentAllowsRestart(tx: Tx, task: Row): Promise<void> {
	if (!task.parent_id) return;
	const parent = await getTask(tx, String(task.parent_id));
	if (parent && parent.status !== 'blocked') {
		throw errors.conflict('Bitte den übergeordneten Auftrag wiederholen');
	}
}

async function hasActiveRun(tx: Tx, taskId: string): Promise<boolean> {
	return !!(await oneOf(
		tx,
		sql`SELECT 1 FROM run WHERE task_id = ${taskId} AND status IN ('offered', 'running') LIMIT 1`
	));
}

async function anyActiveRun(tx: Tx, taskIds: string[]): Promise<boolean> {
	if (!taskIds.length) return false;
	return !!(await oneOf(
		tx,
		sql`SELECT 1 FROM run WHERE task_id IN (${inList(taskIds)}) AND status IN ('offered', 'running') LIMIT 1`
	));
}

/** Elternaufträge, die ein manueller Neustart eines Teilauftrags wieder öffnen darf (Plan nicht ausgeliefert) */
const REOPENABLE_PARENT: TaskStatus[] = ['failed', 'cancelled', 'needs-input'];

/**
 * Vorfahren, die beim manuellen Neustart wieder `blocked` werden (innerster zuerst). Der Aufstieg endet am ersten
 * blockierten Vorfahren; ein aktiver (`queued`/`running`) oder bereits ausgelieferter (`done`/`review`)
 * Vorfahre verhindert den Neustart.
 */
async function reopenableAncestors(tx: Tx, task: Row): Promise<Row[]> {
	const out: Row[] = [];
	let current = task;
	while (current.parent_id) {
		const parent = await getTask(tx, String(current.parent_id), true);
		if (!parent || parent.status === 'blocked') break;
		const delivered = planOf(parent)?.delivered === true;
		if (!REOPENABLE_PARENT.includes(String(parent.status) as TaskStatus) || delivered) {
			throw errors.conflict('Bitte den übergeordneten Auftrag neu starten');
		}
		if (await hasActiveRun(tx, String(parent.id))) {
			throw errors.conflict('Der übergeordnete Auftrag hat noch einen aktiven Lauf');
		}
		out.push(parent);
		current = parent;
	}
	return out;
}

/**
 * Vorfahren wieder blockieren (Fehler, Versuche, Ende zurücksetzen). Geschwister, die nur wegen des
 * Fehlschlags abgebrochen wurden (`failChildrenOf`), laufen ebenfalls neu; liefert die Zahl der Geschwister.
 */
async function reopenAncestors(tx: Tx, fx: Effects, task: Row, ancestors: Row[]): Promise<number> {
	let siblings = 0;
	let child = task;
	for (const parent of ancestors) {
		const rows = await rowsOf(
			tx,
			sql`UPDATE task SET status = 'queued', attempts = 0, error_message = NULL, finished_at = NULL,
					excluded_account_ids = '[]'::jsonb, updated_at = now()
				WHERE parent_id = ${parent.id} AND id <> ${child.id} AND role <> 'resolve'
					AND status = 'cancelled' AND error_message = ${CANCELLED_BY_SIBLING}
				RETURNING id`
		);
		for (const r of rows) fx.tasks.add(String(r.id));
		siblings += rows.length;
		await tx.execute(
			sql`UPDATE task SET excluded_account_ids = '[]'::jsonb WHERE id = ${parent.id}`
		);
		await transition(tx, fx, String(parent.id), 'blocked', { error: null, resetAttempts: true });
		child = parent;
	}
	return siblings;
}

export interface RestartOptions {
	/** Teilaufträge einer Orchestrierung: nur fehlgeschlagene/abgebrochene (Standard) oder alle außer `resolve` */
	subtasks?: 'failed' | 'all';
	/**
	 * Manueller Neustart (`POST /tasks/:id/retry`): nicht blockierte Vorfahren mit nicht ausgeliefertem Plan
	 * wieder blockieren statt abzulehnen. Ohne (Antwort im Chat) gilt weiter: Elternauftrag muss `blocked` sein.
	 */
	reopenParents?: boolean;
}

/**
 * Neu starten (Versuche = 0, Ausschlüsse leeren). Orchestrierung mit Plan: fehlgeschlagene/abgebrochene
 * (`subtasks: 'all'`: alle) Teilaufträge zurücksetzen und wieder blockieren (alle erledigt → Ausliefern).
 * Bei `all` werden offene Konfliktlösungen im Baum abgebrochen und `plan.delivered` zurückgesetzt, damit die
 * Auslieferung erneut läuft. Liefert die Zahl der zusätzlich zurückgesetzten Aufträge (Teilaufträge,
 * Geschwister und wieder geöffnete Vorfahren).
 */
export async function restartTask(
	tx: Tx,
	fx: Effects,
	task: Row,
	opts: RestartOptions = {}
): Promise<number> {
	const subtasks = opts.subtasks ?? 'failed';
	const ancestors = opts.reopenParents ? await reopenableAncestors(tx, task) : [];
	if (!opts.reopenParents) await assertParentAllowsRestart(tx, task);
	if (WAITING.includes(String(task.status) as TaskStatus)) {
		// wartender/blockierter (z. B. hängengebliebener) Auftrag: eigene Läufe abbrechen statt ablehnen
		await cancelActiveRuns(tx, fx, [String(task.id)], 'Auftrag neu gestartet', true);
	} else if (await hasActiveRun(tx, String(task.id))) {
		throw errors.conflict('Der Auftrag hat noch einen aktiven Lauf');
	}
	const plan = planOf(task);
	const descendants = plan && subtasks === 'all' ? await descendantIds(tx, String(task.id)) : [];
	if (await anyActiveRun(tx, descendants)) {
		throw errors.conflict('Ein Teilauftrag hat noch einen aktiven Lauf');
	}
	let count = ancestors.length + (await reopenAncestors(tx, fx, task, ancestors));
	await tx.execute(
		sql`UPDATE task SET excluded_account_ids = '[]'::jsonb, attempts = 0 WHERE id = ${task.id}`
	);
	if (plan && subtasks === 'all') {
		if (descendants.length) {
			const cancelled = await rowsOf(
				tx,
				sql`UPDATE task SET status = 'cancelled', updated_at = now(), finished_at = now(),
						error_message = 'Abgebrochen, weil der Auftrag neu gestartet wurde'
					WHERE id IN (${inList(descendants)}) AND role = 'resolve'
						AND status NOT IN ('done', 'failed', 'cancelled')
					RETURNING id`
			);
			for (const r of cancelled) fx.tasks.add(String(r.id));
		}
		const reset = await rowsOf(
			tx,
			sql`UPDATE task SET status = 'queued', attempts = 0, error_message = NULL, finished_at = NULL,
					excluded_account_ids = '[]'::jsonb, updated_at = now()
				WHERE parent_id = ${task.id} AND role <> 'resolve'
				RETURNING id`
		);
		for (const r of reset) fx.tasks.add(String(r.id));
		count += reset.length;
		if (plan.delivered) {
			const next: StoredPlan = { ...plan, delivered: false };
			await tx.execute(sql`UPDATE task SET plan = ${jsonb(next)} WHERE id = ${task.id}`);
		}
		if (reset.length) {
			await transition(tx, fx, String(task.id), 'blocked', { error: null, resetAttempts: true });
			fx.dispatch = true;
			return count;
		}
	} else if (plan && !plan.delivered) {
		const reset = await rowsOf(
			tx,
			sql`UPDATE task SET status = 'queued', attempts = 0, error_message = NULL, finished_at = NULL,
					excluded_account_ids = '[]'::jsonb, updated_at = now()
				WHERE parent_id = ${task.id} AND role <> 'resolve' AND status IN ('failed', 'cancelled')
				RETURNING id`
		);
		for (const r of reset) fx.tasks.add(String(r.id));
		count += reset.length;
		const open = await oneOf(
			tx,
			sql`SELECT 1 FROM task WHERE parent_id = ${task.id} AND role <> 'resolve'
				AND status NOT IN ('done', 'cancelled') LIMIT 1`
		);
		if (open) {
			await transition(tx, fx, String(task.id), 'blocked', { error: null, resetAttempts: true });
			fx.dispatch = true;
			return count;
		}
	}
	await transition(tx, fx, String(task.id), 'queued', { error: null, resetAttempts: true });
	return count;
}

/** Wartende Zustände: der Neustart bricht die eigenen aktiven Läufe ab, statt mit 409 abzulehnen */
const WAITING: TaskStatus[] = ['queued', 'blocked'];
/** Manuell neu startbar (`POST /tasks/:id/retry`), auch wartende/blockierte (hängengebliebene) Aufträge */
export const RESTARTABLE: TaskStatus[] = [
	'failed',
	'cancelled',
	'needs-input',
	'done',
	'review',
	'queued',
	'blocked'
];
/** @deprecated Bitte `RESTARTABLE` verwenden (gleiche Liste) */
export const RETRYABLE: TaskStatus[] = RESTARTABLE;
/** Antwort setzt diese Zustände fort (Sitzung wird fortgesetzt) */
export const REPLY_RESTARTS: TaskStatus[] = [
	'failed',
	'cancelled',
	'needs-input',
	'done',
	'review'
];
