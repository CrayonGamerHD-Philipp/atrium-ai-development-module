/**
 * Pull Requests: Zustand über einen Runner (`gh.pr-list`) abgleichen und auf die Aufträge übertragen
 * (gemergt → `done`, geschlossen → `failed` mit „PR geschlossen“).
 */
import { sql } from 'drizzle-orm';
import { rowsOf, type RequestContext } from '$lib/sdk/server';
import { clip, mdb, oneOf } from './db';
import { newEffects } from './effects';
import { prListResult } from './protocol';
import { publish } from './publish.service';
import { loadPullDtos } from './queries';
import { callRunner, parseResult, projectAndRunner, rpcProjectOf } from './rpc.service';
import type { PullRequestDto } from './schemas';
import { applyPullState, getTask } from './tasks.service';

export async function syncPulls(
	ctx: RequestContext | null,
	projectId: string
): Promise<PullRequestDto[]> {
	const { project, runnerId } = await projectAndRunner(projectId, 'main');
	const { pulls } = parseResult(
		prListResult,
		await callRunner(runnerId, 'gh.pr-list', rpcProjectOf(project), 'main')
	);
	const fx = newEffects();
	const list = await mdb().transaction(async (tx) => {
		for (const pr of pulls) {
			const existing = await oneOf(
				tx,
				sql`SELECT task_id FROM pull_request WHERE project_id = ${projectId} AND number = ${pr.number}`
			);
			let taskId = existing?.task_id ? String(existing.task_id) : null;
			if (!taskId) {
				const t = await oneOf(
					tx,
					sql`SELECT id FROM task WHERE project_id = ${projectId}
						AND (pr_number = ${pr.number} OR (branch = ${pr.branch} AND role <> 'resolve'))
						ORDER BY (pr_number = ${pr.number}) DESC, created_at DESC LIMIT 1`
				);
				taskId = t ? String(t.id) : null;
			}
			await tx.execute(
				sql`INSERT INTO pull_request (project_id, number, task_id, title, branch, state, is_draft,
						mergeable, checks, auto_merge, url, additions, deletions, created_at, updated_at, synced_at)
					VALUES (${projectId}, ${pr.number}, ${taskId}, ${clip(pr.title, 300)}, ${pr.branch},
						${pr.state}, ${pr.isDraft}, ${pr.mergeable}, ${pr.checks}, ${pr.autoMerge}, ${pr.url},
						${pr.additions}, ${pr.deletions}, COALESCE(${pr.createdAt || null}::timestamptz, now()),
						COALESCE(${pr.updatedAt || null}::timestamptz, now()), now())
					ON CONFLICT (project_id, number) DO UPDATE SET
						task_id = COALESCE(pull_request.task_id, EXCLUDED.task_id),
						title = EXCLUDED.title, branch = EXCLUDED.branch, state = EXCLUDED.state,
						is_draft = EXCLUDED.is_draft, mergeable = EXCLUDED.mergeable, checks = EXCLUDED.checks,
						auto_merge = EXCLUDED.auto_merge, url = EXCLUDED.url, additions = EXCLUDED.additions,
						deletions = EXCLUDED.deletions, updated_at = EXCLUDED.updated_at, synced_at = now()`
			);
			fx.pulls.add(`${projectId}:${pr.number}`);
			if (taskId) {
				const task = await getTask(tx, taskId, true);
				if (task && (task.pr_number === null || task.pr_number === undefined)) {
					await tx.execute(
						sql`UPDATE task SET pr_number = ${pr.number}, pr_url = ${pr.url} WHERE id = ${taskId}`
					);
					fx.tasks.add(taskId);
				}
			}
			// Zustand auf alle Aufträge dieses PR übertragen (mehrere Aufträge können denselben PR bearbeiten)
			const related = await rowsOf(
				tx,
				sql`SELECT id FROM task WHERE project_id = ${projectId} AND status = 'review'
					AND (pr_number = ${pr.number} OR target_pr = ${pr.number}
						${taskId ? sql`OR id = ${taskId}` : sql``})`
			);
			for (const r of related) {
				const task = await getTask(tx, String(r.id), true);
				if (task) await applyPullState(tx, fx, task, pr.state);
			}
		}
		return loadPullDtos(tx, projectId);
	});
	await publish(ctx, fx);
	return list;
}
