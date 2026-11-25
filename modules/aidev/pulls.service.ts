/**
 * Pull Requests: Zustand über einen Runner (`gh.pr-list`) abgleichen und auf die Aufträge übertragen
 * (gemergt → `done`, geschlossen → `failed` mit „PR geschlossen“). Danach best-effort die Branches gemergter
 * `aidev/`-PRs auf dem Remote löschen (`cleanupMergedBranches`).
 */
import { sql } from 'drizzle-orm';
import { inList, logBestEffort, rowsOf, type RequestContext } from '$lib/sdk/server';
import { clip, mdb, oneOf, type Tx } from './db';
import { newEffects } from './effects';
import { branchDeleteResult, MAX_BRANCH_DELETE, prListResult } from './protocol';
import { publish } from './publish.service';
import { loadPullDtos } from './queries';
import { callRunner, parseResult, projectAndRunner, rpcProjectOf } from './rpc.service';
import type { PullRequestDto } from './schemas';
import { lockBranchAllocation } from './scheduler.service';
import { applyPullState, descendantIds, getTask } from './tasks.service';

/** Höchstzahl gemergter PRs, deren Branches ein Abgleich aufräumt */
export const BRANCH_CLEANUP_BATCH = 10;
/** Zeitlimit für `git.branch-delete` (Runner-seitig ≤ 18 s) */
const BRANCH_DELETE_TIMEOUT_MS = 25_000;
/** Gültigkeit einer Reservierung zu löschender Branches (falls die Freigabe ausbleibt, z. B. nach einem Absturz) */
const BRANCH_CLAIM_SEC = 120;
/** Wartezeit, bevor ein zurückgehaltener oder fehlgeschlagener PR erneut aufgeräumt wird (faire Rotation) */
export const BRANCH_CLEANUP_RETRY_MIN = 15;
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
			// Fork-PRs nie über den (nur zufällig gleichen) Branch-Namen zuordnen
			const byBranch = pr.crossRepository === true ? null : pr.branch;
			if (!taskId) {
				const t = await oneOf(
					tx,
					sql`SELECT id FROM task WHERE project_id = ${projectId}
						AND (pr_number = ${pr.number} OR (branch = ${byBranch} AND role <> 'resolve'))
						ORDER BY (pr_number = ${pr.number}) DESC, created_at DESC LIMIT 1`
				);
				taskId = t ? String(t.id) : null;
			}
			await tx.execute(
				sql`INSERT INTO pull_request (project_id, number, task_id, title, branch, state, is_draft,
						mergeable, checks, auto_merge, url, additions, deletions, created_at, updated_at, synced_at,
						head_sha, cross_repository)
					VALUES (${projectId}, ${pr.number}, ${taskId}, ${clip(pr.title, 300)}, ${pr.branch},
						${pr.state}, ${pr.isDraft}, ${pr.mergeable}, ${pr.checks}, ${pr.autoMerge}, ${pr.url},
						${pr.additions}, ${pr.deletions}, COALESCE(${pr.createdAt || null}::timestamptz, now()),
						COALESCE(${pr.updatedAt || null}::timestamptz, now()), now(),
						${pr.headSha ?? null}, ${pr.crossRepository ?? null})
					ON CONFLICT (project_id, number) DO UPDATE SET
						task_id = COALESCE(pull_request.task_id, EXCLUDED.task_id),
						title = EXCLUDED.title, branch = EXCLUDED.branch, state = EXCLUDED.state,
						is_draft = EXCLUDED.is_draft, mergeable = EXCLUDED.mergeable, checks = EXCLUDED.checks,
						auto_merge = EXCLUDED.auto_merge, url = EXCLUDED.url, additions = EXCLUDED.additions,
						deletions = EXCLUDED.deletions, updated_at = EXCLUDED.updated_at, synced_at = now(),
						head_sha = EXCLUDED.head_sha, cross_repository = EXCLUDED.cross_repository`
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
	/** Head-Branch des PR und dessen letzter bekannter Stand (nur dieser Stand wird gelöscht) */
	head: string;
	headSha: string | null;
}

/**
 * Alle Branches, die ein nicht abgeschlossener Auftrag oder ein aktiver Lauf noch braucht: eigener Branch, Basis
 * (`base_ref`) und Integrations-Branches aller Vorfahren; dazu Branches offener PRs (lokaler Stand – der Runner prüft
 * zusätzlich live auf GitHub).
 */
async function branchesInUse(tx: Tx, projectId: string): Promise<Set<string>> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE active AS (
				SELECT id, parent_id, branch, base_ref FROM task
				WHERE project_id = ${projectId} AND status NOT IN ('done', 'failed', 'cancelled')
			), ancestors AS (
				SELECT t.id, t.parent_id, t.branch FROM task t JOIN active a ON t.id = a.parent_id
				UNION SELECT t.id, t.parent_id, t.branch FROM task t JOIN ancestors an ON t.id = an.parent_id
			)
			SELECT branch AS b FROM active WHERE branch IS NOT NULL
			UNION SELECT base_ref FROM active WHERE base_ref IS NOT NULL
			UNION SELECT branch FROM ancestors WHERE branch IS NOT NULL
			UNION SELECT branch FROM run WHERE project_id = ${projectId} AND branch IS NOT NULL
				AND status IN ('offered', 'running')
			UNION SELECT branch FROM pull_request WHERE project_id = ${projectId} AND state = 'open'`
	);
	return new Set(rows.map((r) => String(r.b)));
}

/** Kandidaten laden: fällige gemergte `aidev/`-PRs aus dem Ziel-Repository (keine Forks, Herkunft bekannt) */
async function loadCandidates(tx: Tx, projectId: string): Promise<CleanupCandidate[]> {
	const project = await oneOf(tx, sql`SELECT default_branch FROM project WHERE id = ${projectId}`);
	if (!project) return [];
	const prs = await rowsOf(
		tx,
		sql`SELECT number, branch, task_id, head_sha FROM pull_request
			WHERE project_id = ${projectId} AND state = 'merged' AND branch LIKE 'aidev/%'
				AND cross_repository = false AND branch_deleted_at IS NULL
				AND (branch_cleanup_after IS NULL OR branch_cleanup_after <= now())
			ORDER BY branch_cleanup_after NULLS FIRST, updated_at, number LIMIT ${BRANCH_CLEANUP_BATCH}`
	);
	if (!prs.length) return [];
	const inUse = await branchesInUse(tx, projectId);
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
			kept: own.filter((b) => inUse.has(b)),
			head: String(pr.branch),
			headSha: pr.head_sha ? String(pr.head_sha) : null
		});
	}
	return list;
}

/**
 * Branches gemergter PRs löschen: PR-Branch plus Branches des Auftrags und seiner Nachfahren (Aufträge und
 * Läufe). Nur `aidev/`-Branches aus dem Ziel-Repository (Fork-PRs und PRs unbekannter Herkunft bleiben unberührt),
 * nie der Default-Branch und nichts, was ein aktiver Auftrag (auch als Basis oder Integrations-Branch), ein aktiver
 * Lauf oder ein offener PR noch nutzt (der Runner prüft offene PRs zusätzlich live). Der PR-Branch wird nur auf dem
 * gemergten Stand (`head_sha`) gelöscht. Geschlossene (nicht gemergte) PRs bleiben unberührt; ohne Runner mit
 * Capability `branchCleanup` wird nichts gelöscht.
 *
 * Ablauf ohne über den RPC gehaltene Transaktion: (1) unter der Sperre der Branch-Vergabe (`lockBranchAllocation`)
 * Nutzung prüfen und die Branches in `branch_cleanup_claim` reservieren – der Scheduler vergibt sie dann weder als
 * Branch noch als Basis; (2) `git.branch-delete`; (3) Ergebnis speichern, Reservierung freigeben, Scheduler anstoßen.
 *
 * Ein PR gilt als erledigt (`branch_deleted_at`), wenn kein Branch fehlschlug und keiner wegen Nutzung
 * zurückgehalten wurde – auch, wenn es nichts zu löschen gab oder ein Branch seit dem Merge neue Commits hat.
 * Sonst wird er um `BRANCH_CLEANUP_RETRY_MIN` zurückgestellt, damit dauerhaft blockierte PRs spätere nicht
 * verdrängen. Liefert die Zahl erledigter PRs.
 */
export async function cleanupMergedBranches(
	ctx: RequestContext | null,
	projectId: string
): Promise<number> {
	let picked: Awaited<ReturnType<typeof projectAndRunner>> | null;
	try {
		picked = await projectAndRunner(projectId, 'main', { branchCleanup: true });
	} catch {
		picked = null; // kein Runner mit `branchCleanup` (oder keiner verbunden) → nur Kandidaten ohne Löschung
	}

	// (1) Kandidaten wählen und Branches reservieren (höchstens ein RPC je Durchlauf, der Rest kommt danach)
	const { batch, branches, expect } = await mdb().transaction(async (tx) => {
		await lockBranchAllocation(tx);
		await tx.execute(
			sql`DELETE FROM branch_cleanup_claim WHERE project_id = ${projectId} AND expires_at <= now()`
		);
		const candidates = await loadCandidates(tx, projectId);
		const claimed = new Set(
			(
				await rowsOf(
					tx,
					sql`SELECT branch FROM branch_cleanup_claim WHERE project_id = ${projectId}`
				)
			).map((r) => String(r.branch))
		);
		const branches = new Set<string>();
		const expect: Record<string, string> = {};
		const batch: CleanupCandidate[] = [];
		for (const c of candidates) {
			const next = c.branches.filter((b) => !branches.has(b));
			// ohne passenden Runner, über der Obergrenze oder gerade anderweitig in Arbeit: für später lassen
			if (
				next.length &&
				(!picked ||
					branches.size + next.length > MAX_BRANCH_DELETE ||
					next.some((b) => claimed.has(b)))
			) {
				continue;
			}
			for (const b of next) branches.add(b);
			if (c.headSha && c.branches.includes(c.head)) expect[c.head] = c.headSha;
			batch.push(c);
		}
		for (const b of branches) {
			await tx.execute(
				sql`INSERT INTO branch_cleanup_claim (project_id, branch, expires_at)
					VALUES (${projectId}, ${b}, now() + ${`${BRANCH_CLAIM_SEC} seconds`}::interval)`
			);
		}
		return { batch, branches: [...branches], expect };
	});
	if (!batch.length) return 0;

	// (2) Löschen über den Runner
	const failed = new Set<string>();
	const kept = new Set<string>();
	if (branches.length && picked) {
		try {
			const res = parseResult(
				branchDeleteResult,
				await callRunner(
					picked.runnerId,
					'git.branch-delete',
					rpcProjectOf(picked.project),
					'main',
					{ branches, expect },
					BRANCH_DELETE_TIMEOUT_MS
				)
			);
			for (const f of res.failed) failed.add(f.branch);
			for (const k of res.kept ?? []) if (k.reason === 'open-pr') kept.add(k.branch);
			// Branch ohne Ergebnis in der Antwort → nicht als erledigt werten
			const answered = new Set([
				...res.deleted,
				...res.missing,
				...failed,
				...(res.kept ?? []).map((k) => k.branch)
			]);
			for (const b of branches) if (!answered.has(b)) failed.add(b);
		} catch (e) {
			for (const b of branches) failed.add(b);
			logBestEffort('aidev.branch-cleanup', e, { target: projectId });
		}
	}

	// (3) Ergebnis speichern und Reservierung freigeben
	const fx = newEffects();
	const done = await mdb().transaction(async (tx) => {
		const finished: CleanupCandidate[] = [];
		const retry: number[] = [];
		for (const c of batch) {
			if (!c.kept.length && c.branches.every((b) => !failed.has(b) && !kept.has(b)))
				finished.push(c);
			else retry.push(c.number);
		}
		for (const c of finished) {
			await tx.execute(
				sql`UPDATE pull_request SET branch_deleted_at = now(), branch_cleanup_after = NULL
					WHERE project_id = ${projectId} AND number = ${c.number}`
			);
			if (c.branches.length) {
				fx.audits.push({
					action: 'aidev.branch.deleted',
					target: projectId,
					metadata: { number: c.number, branches: c.branches }
				});
			}
		}
		if (retry.length) {
			await tx.execute(
				sql`UPDATE pull_request
					SET branch_cleanup_after = now() + ${`${BRANCH_CLEANUP_RETRY_MIN} minutes`}::interval
					WHERE project_id = ${projectId} AND number IN (${inList(retry)})`
			);
		}
		if (branches.length) {
			await tx.execute(
				sql`DELETE FROM branch_cleanup_claim
					WHERE project_id = ${projectId} AND branch IN (${inList(branches)})`
			);
			fx.dispatch = true; // zurückgestellte Läufe können jetzt vergeben werden
		}
		return finished.length;
	});
	await publish(ctx, fx);
	return done;
}
