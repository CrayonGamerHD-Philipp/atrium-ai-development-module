/** Lesende Abfragen, die DTOs zusammensetzen (Aufträge, Läufe, Projekte, Pull Requests, Chat). Nur Datenbank. */
import { sql, type SQL } from 'drizzle-orm';
import { inList, num, rowsOf, type Row } from '$lib/sdk/server';
import { chatAttachmentsOf, taskAttachmentsOf } from './attachments.service';
import { oneOf, type Tx } from './db';
import {
	chatDto,
	commitDto,
	EMPTY_COUNTS,
	prDto,
	projectDto,
	runDto,
	runSummaryDto,
	taskDto,
	type ProjectCounts
} from './mappers';
import type {
	ChatMessageDto,
	ProjectDto,
	PullRequestDto,
	RunDto,
	RunSummaryDto,
	TaskDetailDto,
	TaskDto,
	TaskStatus
} from './schemas';

/** Lauf mit Konto- und Runner-Namen */
export const RUN_SELECT = sql`SELECT r.*, a.label AS account_label, a.key AS account_key, rn.name AS runner_name
	FROM run r
	LEFT JOIN provider_account a ON a.id = r.account_id
	LEFT JOIN runner rn ON rn.id = r.runner_id`;

// ---------------------------------------------------------------- Projekte

export async function projectCounts(
	tx: Tx,
	projectIds: string[]
): Promise<Map<string, ProjectCounts>> {
	const map = new Map<string, ProjectCounts>();
	if (!projectIds.length) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT project_id, status, count(*) AS n FROM task
			WHERE project_id IN (${inList(projectIds)}) GROUP BY project_id, status`
	);
	for (const r of rows) {
		const id = String(r.project_id);
		const c = map.get(id) ?? { ...EMPTY_COUNTS };
		const n = num(r.n);
		switch (String(r.status) as TaskStatus) {
			case 'queued':
				c.queued += n;
				break;
			case 'running':
				c.running += n;
				break;
			case 'review':
				c.review += n;
				break;
			case 'needs-input':
				c.needsInput += n;
				break;
			case 'done':
				c.done += n;
				break;
			default:
				break;
		}
		map.set(id, c);
	}
	return map;
}

export async function loadProjectRow(tx: Tx, id: string): Promise<Row | null> {
	return oneOf(tx, sql`SELECT * FROM project WHERE id = ${id}`);
}

export async function loadProjectDtos(tx: Tx, where: SQL): Promise<ProjectDto[]> {
	const rows = await rowsOf(tx, sql`SELECT * FROM project WHERE ${where} ORDER BY lower(name), id`);
	const counts = await projectCounts(
		tx,
		rows.map((r) => String(r.id))
	);
	return rows.map((r) => projectDto(r, counts.get(String(r.id))));
}

export async function loadProjectDto(tx: Tx, id: string): Promise<ProjectDto | null> {
	return (await loadProjectDtos(tx, sql`id = ${id}`))[0] ?? null;
}

// ---------------------------------------------------------------- Aufträge

async function lastRunsOf(tx: Tx, taskIds: string[]): Promise<Map<string, RunSummaryDto>> {
	const map = new Map<string, RunSummaryDto>();
	if (!taskIds.length) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT DISTINCT ON (r.task_id) r.*, a.label AS account_label, a.key AS account_key,
				rn.name AS runner_name
			FROM run r
			LEFT JOIN provider_account a ON a.id = r.account_id
			LEFT JOIN runner rn ON rn.id = r.runner_id
			WHERE r.task_id IN (${inList(taskIds)})
			ORDER BY r.task_id, r.created_at DESC, r.attempt DESC`
	);
	for (const r of rows) map.set(String(r.task_id), runSummaryDto(r));
	return map;
}

async function depsOf(tx: Tx, taskIds: string[]): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	if (!taskIds.length) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT task_id, depends_on_id FROM task_dep WHERE task_id IN (${inList(taskIds)})
			ORDER BY depends_on_id`
	);
	for (const r of rows) {
		const id = String(r.task_id);
		map.set(id, [...(map.get(id) ?? []), String(r.depends_on_id)]);
	}
	return map;
}

/** Aufträge zu Zeilen (Abhängigkeiten, letzter Lauf, wirksame Anhänge) */
export async function taskDtosOf(tx: Tx, rows: Row[]): Promise<TaskDto[]> {
	const ids = rows.map((r) => String(r.id));
	const [deps, runs, files] = [
		await depsOf(tx, ids),
		await lastRunsOf(tx, ids),
		await taskAttachmentsOf(tx, ids)
	];
	return rows.map((r) => {
		const id = String(r.id);
		return taskDto(r, deps.get(id) ?? [], runs.get(id) ?? null, files.get(id) ?? []);
	});
}

export async function loadTaskDtos(tx: Tx, ids: string[]): Promise<TaskDto[]> {
	if (!ids.length) return [];
	const rows = await rowsOf(tx, sql`SELECT * FROM task WHERE id IN (${inList(ids)})`);
	return taskDtosOf(tx, rows);
}

export async function loadTaskDto(tx: Tx, id: string): Promise<TaskDto | null> {
	return (await loadTaskDtos(tx, [id]))[0] ?? null;
}

export async function loadTaskDetail(tx: Tx, task: Row): Promise<TaskDetailDto> {
	const id = String(task.id);
	const [dto] = await taskDtosOf(tx, [task]);
	const runRows = await rowsOf(
		tx,
		sql`${RUN_SELECT} WHERE r.task_id = ${id} ORDER BY r.created_at DESC, r.attempt DESC`
	);
	const commitRows = runRows.length
		? await rowsOf(
				tx,
				sql`SELECT * FROM run_commit WHERE run_id IN (${inList(runRows.map((r) => r.id))})
					ORDER BY created_at, sha`
			)
		: [];
	const runs: RunDto[] = runRows.map((r) =>
		runDto(r, commitRows.filter((c) => String(c.run_id) === String(r.id)).map(commitDto))
	);
	const children = await taskDtosOf(
		tx,
		await rowsOf(tx, sql`SELECT * FROM task WHERE parent_id = ${id} ORDER BY position, created_at`)
	);
	const dependencies = (
		await rowsOf(
			tx,
			sql`SELECT t.id, t.title, t.status FROM task_dep d JOIN task t ON t.id = d.depends_on_id
				WHERE d.task_id = ${id} ORDER BY t.position, t.created_at`
		)
	).map((r) => ({
		id: String(r.id),
		title: String(r.title),
		status: String(r.status) as TaskStatus
	}));
	const prRow = await oneOf(
		tx,
		sql`SELECT * FROM pull_request WHERE project_id = ${task.project_id}
			AND (task_id = ${id} OR number = ${task.pr_number === null ? -1 : num(task.pr_number)})
			ORDER BY (number = ${task.pr_number === null ? -1 : num(task.pr_number)}) DESC, updated_at DESC
			LIMIT 1`
	);
	return {
		task: dto!,
		runs,
		children,
		dependencies,
		pullRequest: prRow ? prDto(prRow) : null
	};
}

// ---------------------------------------------------------------- Pull Requests

export async function loadPullDtos(tx: Tx, projectId: string): Promise<PullRequestDto[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT * FROM pull_request WHERE project_id = ${projectId}
			ORDER BY (state = 'open') DESC, updated_at DESC, number DESC`
	);
	return rows.map(prDto);
}

// ---------------------------------------------------------------- Chat

/** Chatnachrichten zu DTOs (Autorennamen vorher außerhalb der Transaktion laden) */
export async function chatDtosOf(
	tx: Tx,
	rows: Row[],
	names: ReadonlyMap<string, string>
): Promise<ChatMessageDto[]> {
	const files = await chatAttachmentsOf(
		tx,
		rows.map((r) => String(r.id))
	);
	return rows.map((r) => chatDto(r, names, files.get(String(r.id)) ?? []));
}
