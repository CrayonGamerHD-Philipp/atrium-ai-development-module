/**
 * Aufträge: Liste je Projekt, Anlegen, Detail, Ändern, Einplanen, Abbrechen, Neu starten, Antworten, Löschen,
 * Diff (über einen Runner) und Lauf-Ereignisse. Eigene Aufträge mit `task.create`, fremde mit `task.manage`.
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	defineEndpoint,
	errors,
	inList,
	num,
	rowsOf,
	str,
	toIso
} from '$lib/sdk/server';
import { mdb, oneOf } from './db';
import { newEffects } from './effects';
import { gitDiffResult, type RunEvent } from './protocol';
import { publish } from './publish.service';
import { loadTaskDetail, loadTaskDto, taskDtosOf } from './queries';
import { requireProject } from './projects.service';
import { callRunner, parseResult, projectAndRunner, rpcProjectOf } from './rpc.service';
import {
	assertCanEditTask,
	cancelTaskAs,
	createTask,
	descendantIds,
	insertChat,
	isFinal,
	REPLY_RESTARTS,
	requireTask,
	restartTask,
	RESTARTABLE,
	transition,
	updateTask
} from './tasks.service';
import {
	idParams,
	PERM,
	replyInput,
	restartInput,
	runEventsQuery,
	taskInput,
	taskPatch,
	tasksQuery,
	type DiffDto,
	type RunEventDto,
	type TaskDetailDto,
	type TaskDto,
	type TaskStatus
} from './schemas';

const tags = ['Modul: aidev – Aufträge'];

export const taskEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/tasks',
		summary: 'Aufträge eines Projekts (neueste zuerst, inkl. Teilaufträge)',
		tags,
		permission: PERM.projectView,
		params: idParams,
		query: tasksQuery,
		handler: async ({ params, query }): Promise<TaskDto[]> =>
			mdb().transaction(async (tx) => {
				await requireProject(tx, params.id);
				const filter =
					query.status === 'open'
						? sql`AND status NOT IN ('done', 'failed', 'cancelled')`
						: query.status === 'done'
							? sql`AND status IN ('done', 'failed', 'cancelled')`
							: sql``;
				const rows = await rowsOf(
					tx,
					sql`SELECT * FROM task WHERE project_id = ${params.id} ${filter}
						ORDER BY created_at DESC, position LIMIT ${query.limit}`
				);
				return taskDtosOf(tx, rows);
			})
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/tasks',
		summary: 'Auftrag anlegen',
		description:
			'Ohne `title` entsteht der Titel aus dem Auftragstext. `decompose` → Rolle `orchestrate` (planen und in Teilaufträge zerlegen). `draft` → Entwurf (nicht eingeplant).',
		tags,
		permission: PERM.taskCreate,
		params: idParams,
		body: taskInput,
		handler: async ({ ctx, params, body }): Promise<TaskDto> => {
			const fx = newEffects();
			const dto = await mdb().transaction(async (tx) => {
				const project = await requireProject(tx, params.id);
				const id = await createTask(tx, fx, ctx, project, body);
				return (await loadTaskDto(tx, id))!;
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/tasks/:id',
		summary: 'Auftrag mit Läufen, Teilaufträgen, Abhängigkeiten und PR',
		tags,
		permission: PERM.projectView,
		params: idParams,
		handler: async ({ params }): Promise<TaskDetailDto> =>
			mdb().transaction(async (tx) => loadTaskDetail(tx, await requireTask(tx, params.id)))
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/tasks/:id',
		summary: 'Auftrag ändern',
		description: 'Der Auftragstext ist nur änderbar, solange kein Lauf aktiv ist.',
		tags,
		permission: PERM.projectView,
		params: idParams,
		body: taskPatch,
		handler: async ({ ctx, params, body }): Promise<TaskDto> => {
			const fx = newEffects();
			const dto = await mdb().transaction(async (tx) => {
				const task = await requireTask(tx, params.id, true);
				await updateTask(tx, fx, ctx, task, body);
				return (await loadTaskDto(tx, params.id))!;
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/queue',
		summary: 'Entwurf einplanen',
		tags,
		permission: PERM.projectView,
		params: idParams,
		handler: async ({ ctx, params }): Promise<TaskDto> => {
			const fx = newEffects();
			const dto = await mdb().transaction(async (tx) => {
				const task = await requireTask(tx, params.id, true);
				assertCanEditTask(ctx, task);
				if (task.status !== 'draft') throw errors.conflict('Nur Entwürfe lassen sich einplanen');
				await transition(tx, fx, params.id, 'queued', { error: null });
				return (await loadTaskDto(tx, params.id))!;
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/cancel',
		summary: 'Auftrag abbrechen',
		description:
			'Bricht den Auftrag und offene Teilaufträge ab; laufende Läufe bekommen einen Abbruch-Befehl.',
		tags,
		permission: PERM.projectView,
		params: idParams,
		handler: async ({ ctx, params }): Promise<TaskDto> => {
			const fx = newEffects();
			const dto = await mdb().transaction(async (tx) => {
				await cancelTaskAs(tx, fx, ctx, await requireTask(tx, params.id, true));
				return (await loadTaskDto(tx, params.id))!;
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/retry',
		summary: 'Auftrag neu starten',
		description:
			'Beendete, fehlgeschlagene, abgebrochene oder auf Rückmeldung wartende Aufträge (Versuche = 0). Body optional: `subtasks` = `failed` (Standard, nur fehlgeschlagene/abgebrochene Teilaufträge) oder `all` (alle Teilaufträge, Plan wird erneut ausgeliefert). Teilaufträge eines gescheiterten Elternauftrags öffnen diesen wieder.',
		tags,
		permission: PERM.projectView,
		params: idParams,
		body: restartInput,
		handler: async ({ ctx, params, body }): Promise<TaskDto> => {
			const fx = newEffects();
			const subtasks = body?.subtasks ?? 'failed';
			const dto = await mdb().transaction(async (tx) => {
				const task = await requireTask(tx, params.id, true);
				assertCanEditTask(ctx, task);
				if (!RESTARTABLE.includes(String(task.status) as TaskStatus)) {
					throw errors.conflict(
						'Nur beendete, fehlgeschlagene, abgebrochene oder auf Rückmeldung wartende Aufträge lassen sich neu starten'
					);
				}
				const reset = await restartTask(tx, fx, task, { subtasks, reopenParents: true });
				fx.audits.push({
					action: 'aidev.task.restarted',
					target: params.id,
					metadata: { projectId: String(task.project_id), subtasks, reset }
				});
				return (await loadTaskDto(tx, params.id))!;
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/reply',
		summary: 'Rückmeldung geben und fortsetzen',
		description:
			'Speichert die Nachricht im Projekt-Chat (zum Auftrag). Beendete, fehlgeschlagene oder wartende Aufträge werden neu eingeplant (die Sitzung wird fortgesetzt); laufende bekommen die Nachricht beim nächsten Lauf.',
		tags,
		permission: PERM.projectView,
		params: idParams,
		body: replyInput,
		handler: async ({ ctx, params, body }): Promise<TaskDto> => {
			const fx = newEffects();
			const dto = await mdb().transaction(async (tx) => {
				const task = await requireTask(tx, params.id, true);
				assertCanEditTask(ctx, task);
				await insertChat(tx, fx, {
					projectId: String(task.project_id),
					taskId: params.id,
					kind: 'user',
					body: body.message,
					authorUserId: ctx.userId
				});
				if (REPLY_RESTARTS.includes(String(task.status) as TaskStatus)) {
					await restartTask(tx, fx, task);
				}
				return (await loadTaskDto(tx, params.id))!;
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/tasks/:id',
		summary: 'Auftrag löschen (nur Entwurf oder Endzustand)',
		tags,
		permission: PERM.taskManage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const fx = newEffects();
			await mdb().transaction(async (tx) => {
				const task = await requireTask(tx, params.id, true);
				if (task.status !== 'draft' && !isFinal(task.status)) {
					throw errors.conflict('Nur Entwürfe und beendete Aufträge lassen sich löschen');
				}
				const ids = [params.id, ...(await descendantIds(tx, params.id))];
				const active = await oneOf(
					tx,
					sql`SELECT 1 FROM run WHERE task_id IN (${inList(ids)}) AND status IN ('offered', 'running') LIMIT 1`
				);
				if (active) throw errors.conflict('Ein Teilauftrag läuft noch');
				await tx.execute(sql`DELETE FROM task WHERE id = ${params.id}`);
				for (const id of ids) {
					fx.deletedTasks.push({ projectId: String(task.project_id), taskId: id });
				}
				fx.overview = true;
				fx.dispatch = true;
			});
			await publish(ctx, fx);
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/tasks/:id/diff',
		summary: 'Diff des Auftrags-Branches gegen seine Basis (über einen Runner)',
		tags,
		permission: PERM.projectView,
		params: idParams,
		handler: async ({ params }): Promise<DiffDto> => {
			const task = await mdb().transaction((tx) => requireTask(tx, params.id));
			const branch = str(task.branch);
			if (!branch) throw errors.conflict('Der Auftrag hat noch keinen Branch');
			const { project, runnerId } = await projectAndRunner(String(task.project_id), 'main');
			const base = str(task.base_ref) ?? String(project.default_branch);
			return parseResult(
				gitDiffResult,
				await callRunner(runnerId, 'git.diff', rpcProjectOf(project), 'main', {
					base: `origin/${base}`,
					head: branch
				})
			);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/runs/:id/events',
		summary: 'Ereignisse eines Laufs (ab `afterSeq`)',
		tags,
		permission: PERM.projectView,
		params: idParams,
		query: runEventsQuery,
		handler: async ({ params, query }): Promise<RunEventDto[]> =>
			mdb().transaction(async (tx) => {
				const run = await oneOf(tx, sql`SELECT id FROM run WHERE id = ${params.id}`);
				if (!run) throw errors.notFound('Lauf nicht gefunden');
				const rows = await rowsOf(
					tx,
					sql`SELECT seq, ts, kind, payload FROM run_event
						WHERE run_id = ${params.id} AND seq > ${query.afterSeq}
						ORDER BY seq LIMIT ${query.limit}`
				);
				return rows.map((r) => ({
					runId: params.id,
					seq: num(r.seq),
					ts: toIso(r.ts),
					kind: String(r.kind) as RunEvent['kind'],
					payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
						string,
						unknown
					>
				}));
			})
	})
];
