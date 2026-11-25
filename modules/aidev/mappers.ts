/** Zeilen (`tx.execute`) → DTOs aus `schemas.ts`. Reine Abbildung, keine Datenbankzugriffe. */
import { num, str, toIso, toIsoOrNull, type Row } from '$lib/sdk/server';
import { jsonOf, stringList } from './db';
import type { CommitPolicy, Provider, Role } from './protocol';
import type {
	AccountDto,
	AccountLimitsDto,
	ChatMessageDto,
	CommitDto,
	ProjectDto,
	PullRequestDto,
	RunDto,
	RunStatus,
	RunSummaryDto,
	RunnerDto,
	TaskDto,
	TaskStatus
} from './schemas';

export type ProjectCounts = ProjectDto['counts'];
export const EMPTY_COUNTS: ProjectCounts = {
	queued: 0,
	running: 0,
	review: 0,
	needsInput: 0,
	done: 0
};

export function projectDto(r: Row, counts: ProjectCounts = EMPTY_COUNTS): ProjectDto {
	const owner = String(r.repo_owner);
	const name = String(r.repo_name);
	return {
		id: String(r.id),
		name: String(r.name),
		repoOwner: owner,
		repoName: name,
		repoUrl: `https://github.com/${owner}/${name}`,
		defaultBranch: String(r.default_branch),
		commitPolicy: String(r.commit_policy) as CommitPolicy,
		maxParallel: num(r.max_parallel),
		setupCmd: String(r.setup_cmd ?? ''),
		testCmd: String(r.test_cmd ?? ''),
		instructions: String(r.instructions ?? ''),
		preferredRunnerId: str(r.preferred_runner_id),
		createdAt: toIso(r.created_at),
		updatedAt: toIso(r.updated_at),
		archivedAt: toIsoOrNull(r.archived_at),
		counts
	};
}

/** Erwartet `run.*` plus `account_label`, `account_key`, `runner_name` (LEFT JOIN) */
export function runSummaryDto(r: Row): RunSummaryDto {
	const label = str(r.account_label);
	return {
		id: String(r.id),
		attempt: num(r.attempt),
		status: String(r.status) as RunStatus,
		provider: String(r.provider) as Provider,
		model: String(r.model ?? ''),
		accountLabel: label || str(r.account_key) || '',
		runnerName: str(r.runner_name) ?? '',
		startedAt: toIsoOrNull(r.started_at),
		finishedAt: toIsoOrNull(r.finished_at)
	};
}

export function commitDto(r: Row): CommitDto {
	return {
		sha: String(r.sha),
		message: String(r.message ?? ''),
		additions: num(r.additions),
		deletions: num(r.deletions),
		files: stringList(r.files)
	};
}

export function runDto(r: Row, commits: CommitDto[]): RunDto {
	return {
		...runSummaryDto(r),
		taskId: String(r.task_id),
		projectId: String(r.project_id),
		runnerId: str(r.runner_id),
		accountId: str(r.account_id),
		branch: str(r.branch),
		headSha: str(r.head_sha),
		sessionId: str(r.session_id),
		errorKind: str(r.error_kind),
		errorMessage: str(r.error_message),
		summary: str(r.summary),
		eventCount: num(r.event_count),
		units: num(r.units),
		createdAt: toIso(r.created_at),
		commits
	};
}

export function taskDto(r: Row, dependsOn: string[], lastRun: RunSummaryDto | null): TaskDto {
	return {
		id: String(r.id),
		delivery: r.delivery === 'branch' ? 'branch' : 'project',
		targetPr: r.target_pr === null || r.target_pr === undefined ? null : num(r.target_pr),
		branchPushed: r.branch_pushed === true,
		projectId: String(r.project_id),
		parentId: str(r.parent_id),
		position: num(r.position),
		title: String(r.title),
		prompt: String(r.prompt),
		role: String(r.role) as Role,
		status: String(r.status) as TaskStatus,
		priority: num(r.priority),
		attempts: num(r.attempts),
		maxAttempts: num(r.max_attempts),
		providerHint: (str(r.provider_hint) as Provider | null) ?? null,
		branch: str(r.branch),
		resultSummary: str(r.result_summary),
		errorMessage: str(r.error_message),
		prNumber: r.pr_number === null || r.pr_number === undefined ? null : num(r.pr_number),
		prUrl: str(r.pr_url),
		dependsOn,
		createdBy: str(r.created_by),
		createdAt: toIso(r.created_at),
		updatedAt: toIso(r.updated_at),
		startedAt: toIsoOrNull(r.started_at),
		finishedAt: toIsoOrNull(r.finished_at),
		lastRun
	};
}

export function accountDto(
	r: Row,
	usage: AccountDto['usage'],
	effective: { fiveHours: number; week: number },
	limits: AccountLimitsDto | null = null
): AccountDto {
	return {
		id: String(r.id),
		runnerId: String(r.runner_id),
		runnerName: str(r.runner_name) ?? '',
		key: String(r.key),
		provider: String(r.provider) as Provider,
		label: String(r.label ?? ''),
		loggedIn: r.logged_in === true,
		models: stringList(r.models),
		enabled: r.enabled === true,
		maxConcurrency: num(r.max_concurrency),
		budget5hUnits: num(r.budget_5h_units),
		budgetWeekUnits: num(r.budget_week_units),
		effective5hUnits: effective.fiveHours,
		effectiveWeekUnits: effective.week,
		weekAnchor: toIsoOrNull(r.week_anchor),
		contextK: num(r.context_k),
		defaultModel: String(r.default_model ?? ''),
		cooldownUntil: toIsoOrNull(r.cooldown_until),
		cooldownReason: str(r.cooldown_reason),
		usage,
		// Limit-Stand mit Analyse (`limits.ts`), `null` = nie gemeldet
		limits
	};
}

export function runnerDto(r: Row, accounts: AccountDto[]): RunnerDto {
	return {
		id: String(r.id),
		name: String(r.name),
		status: String(r.status) as RunnerDto['status'],
		version: String(r.version ?? ''),
		online: r.online === true,
		lastSeenAt: toIsoOrNull(r.last_seen_at),
		maxSlots: num(r.max_slots),
		slotsUsed: num(r.slots_used),
		capabilities: jsonOf<RunnerDto['capabilities']>(r.capabilities, {}),
		createdAt: toIso(r.created_at),
		accounts
	};
}

export function prDto(r: Row): PullRequestDto {
	return {
		projectId: String(r.project_id),
		number: num(r.number),
		taskId: str(r.task_id),
		title: String(r.title ?? ''),
		branch: String(r.branch ?? ''),
		state: String(r.state) as PullRequestDto['state'],
		isDraft: r.is_draft === true,
		mergeable: String(r.mergeable ?? 'unknown'),
		checks: String(r.checks ?? 'unknown'),
		autoMerge: r.auto_merge === true,
		url: String(r.url ?? ''),
		additions: num(r.additions),
		deletions: num(r.deletions),
		updatedAt: toIso(r.updated_at),
		syncedAt: toIso(r.synced_at)
	};
}

export function chatDto(r: Row, names: ReadonlyMap<string, string>): ChatMessageDto {
	const authorId = str(r.author_user_id);
	return {
		id: String(r.id),
		projectId: String(r.project_id),
		taskId: str(r.task_id),
		kind: String(r.kind) as ChatMessageDto['kind'],
		body: String(r.body),
		author: authorId ? { id: authorId, name: names.get(authorId) ?? 'Unbekannt' } : null,
		createdAt: toIso(r.created_at)
	};
}
