/**
 * Pull Requests: Zustand über einen Runner (`gh.pr-list`) abgleichen und auf die Aufträge übertragen
 * (gemergt → `done`, geschlossen → `failed` mit „PR geschlossen“). Danach best-effort die Branches gemergter
 * `aidev/`-PRs auf dem Remote löschen (`cleanupMergedBranches`).
 */
import { sql } from 'drizzle-orm';
import { inList, logBestEffort, rowsOf, type RequestContext } from '$lib/sdk/server';
import { clip, mdb, oneOf } from './db';
import { newEffects } from './effects';
import { branchDeleteResult, MAX_BRANCH_DELETE, prListResult } from './protocol';
import { publish } from './publish.service';
import { loadPullDtos } from './queries';
import { callRunner, parseResult, projectAndRunner, rpcProjectOf } from './rpc.service';
import type { PullRequestDto } from './schemas';
import { applyPullState, descendantIds, getTask } from './tasks.service';

/** Höchstzahl gemergter PRs, deren Branches ein Abgleich aufräumt */
export const BRANCH_CLEANUP_BATCH = 10;
/** Zeitlimit für `git.branch-delete` (mehrere `git push --delete` können dauern) */
const BRANCH_DELETE_TIMEOUT_MS = 60_000;
/** Präfix der vom System angelegten Branches – nur diese werden gelöscht */
const AIDEV_PREFIX = 'aidev/';

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
	try {
		await cleanupMergedBranches(ctx, projectId);
	} catch (e) {
		logBestEffort('aidev.branch-cleanup', e, { target: projectId });
	}
	return list;
}

interface CleanupCandidate {
	number: number;
	/** zu löschende Branches */
	branches: string[];
	/** Branches, die noch genutzt werden (→ später erneut versuchen) */
	kept: string[];
}

/**
 * Branches gemergter PRs löschen: PR-Branch plus Branches des Auftrags und seiner Nachfahren (Aufträge und
 * Läufe). Nur `aidev/`-Branches, nie der Default-Branch und nichts, was ein aktiver Auftrag, ein aktiver Lauf oder
 * ein offener PR noch nutzt. Geschlossene (nicht gemergte) PRs bleiben unberührt. Ohne Runner mit Capability
 * `branchCleanup` passiert nichts. Ein PR gilt als aufgeräumt (`branch_deleted_at`), wenn kein Branch
 * fehlschlug und keiner wegen Nutzung zurückgehalten wurde.
 */
export async function cleanupMergedBranches(
	ctx: RequestContext | null,
	projectId: string
): Promise<number> {
	const candidates = await mdb().transaction(async (tx) => {
		const project = await oneOf(
			tx,
			sql`SELECT default_branch FROM project WHERE id = ${projectId}`
		);
		if (!project) return [];
		const prs = await rowsOf(
			tx,
			sql`SELECT number, branch, task_id FROM pull_request
				WHERE project_id = ${projectId} AND state = 'merged' AND branch LIKE 'aidev/%'
					AND branch_deleted_at IS NULL
				ORDER BY updated_at, number LIMIT ${BRANCH_CLEANUP_BATCH}`
		);
		if (!prs.length) return [];
		const inUse = new Set<string>(
			(
				await rowsOf(
					tx,
					sql`SELECT branch FROM task WHERE project_id = ${projectId} AND branch IS NOT NULL
							AND status NOT IN ('done', 'failed', 'cancelled')
						UNION SELECT branch FROM run WHERE project_id = ${projectId} AND branch IS NOT NULL
							AND status IN ('offered', 'running')
						UNION SELECT branch FROM pull_request WHERE project_id = ${projectId} AND state = 'open'`
				)
			).map((r) => String(r.branch))
		);
		const defaultBranch = String(project.default_branch);
		const list: CleanupCandidate[] = [];
		for (const pr of prs) {
			const all = new Set<string>([String(pr.branch)]);
			if (pr.task_id) {
				const ids = [String(pr.task_id), ...(await descendantIds(tx, String(pr.task_id)))];
				const rows = await rowsOf(
					tx,
					sql`SELECT branch FROM task WHERE id IN (${inList(ids)}) AND branch IS NOT NULL
						UNION SELECT branch FROM run WHERE task_id IN (${inList(ids)}) AND branch IS NOT NULL`
				);
				for (const r of rows) all.add(String(r.branch));
			}
			const own = [...all].filter((b) => b.startsWith(AIDEV_PREFIX) && b !== defaultBranch);
			list.push({
				number: Number(pr.number),
				branches: own.filter((b) => !inUse.has(b)),
				kept: own.filter((b) => inUse.has(b))
			});
		}
		return list;
	});
	const branches = [...new Set(candidates.flatMap((c) => c.branches))];
	if (!branches.length) return 0;

	let picked: Awaited<ReturnType<typeof projectAndRunner>>;
	try {
		picked = await projectAndRunner(projectId, 'main', { branchCleanup: true });
	} catch {
		return 0; // kein Runner mit `branchCleanup` (oder keiner verbunden) → beim nächsten Abgleich erneut
	}
	const failed = new Set<string>();
	for (let i = 0; i < branches.length; i += MAX_BRANCH_DELETE) {
		const chunk = branches.slice(i, i + MAX_BRANCH_DELETE);
		try {
			const res = parseResult(
				branchDeleteResult,
				await callRunner(
					picked.runnerId,
					'git.branch-delete',
					rpcProjectOf(picked.project),
					'main',
					{ branches: chunk },
					BRANCH_DELETE_TIMEOUT_MS
				)
			);
			for (const f of res.failed) failed.add(f.branch);
		} catch (e) {
			for (const b of chunk) failed.add(b);
			logBestEffort('aidev.branch-cleanup', e, { target: projectId });
		}
	}

	const fx = newEffects();
	const done = candidates.filter((c) => !c.kept.length && c.branches.every((b) => !failed.has(b)));
	if (!done.length) return 0;
	await mdb().transaction(async (tx) => {
		for (const c of done) {
			await tx.execute(
				sql`UPDATE pull_request SET branch_deleted_at = now()
					WHERE project_id = ${projectId} AND number = ${c.number}`
			);
			fx.audits.push({
				action: 'aidev.branch.deleted',
				target: projectId,
				metadata: { number: c.number, branches: c.branches }
			});
		}
	});
	await publish(ctx, fx);
	return done.length;
}
