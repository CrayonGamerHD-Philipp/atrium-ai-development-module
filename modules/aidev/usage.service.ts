/**
 * Verbrauch und Zustand der Anbieter-Konten: Summen aus `usage_ledger` (gleitendes 5-h-Fenster, Woche ab
 * `weekStartOf(week_anchor)`, inkl. Reservierungen), wirksame Budgets, Auslastung, laufende Läufe. Liefert die
 * `AccountState`s für den Scheduler (inkl. gemeldeter Limits) und die `AccountDto`s/`RunnerDto`s/`OverviewDto`
 * (inkl. Limit-Analyse aus `limits.ts`) für die Oberfläche.
 */
import { sql, type SQL } from 'drizzle-orm';
import { num, rowsOf, toIso, type Row } from '$lib/sdk/server';
import type { Tx } from './db';
import { analyzeLimits, parseSnapshot, reportedUtil, rejectedUntil } from './limits';
import { loadLimitSamples } from './limits.service';
import { accountDto, runnerDto, runSummaryDto } from './mappers';
import type { Provider } from './protocol';
import { utilization, weekStartOf, type AccountState } from './scheduler';
import type { AccountDto, OverviewDto, RunnerDto } from './schemas';

const FIVE_HOURS_MS = 5 * 3600 * 1000;

export interface AccountView {
	row: Row;
	state: AccountState;
	dto: AccountDto;
}

/** Wirksames Budget: kalibriert, sonst eingestellt (0 = unbekannt) */
export function effectiveBudget(calibrated: unknown, configured: unknown): number {
	if (calibrated !== null && calibrated !== undefined && num(calibrated) > 0)
		return num(calibrated);
	return num(configured);
}

const ms = (v: unknown): number | null => (v ? new Date(toIso(v)).getTime() : null);

/** Alle Konten (optional gefiltert) mit Verbrauch und Scheduler-Zustand */
export async function loadAccountViews(
	tx: Tx,
	now: number = Date.now(),
	where: SQL = sql`TRUE`
): Promise<AccountView[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT a.*, rn.name AS runner_name, rn.online AS runner_online, rn.status AS runner_status,
				rn.max_slots AS runner_max_slots,
				(SELECT count(*) FROM run r WHERE r.account_id = a.id AND r.status IN ('offered', 'running')) AS running,
				(SELECT count(*) FROM run r WHERE r.runner_id = a.runner_id AND r.status IN ('offered', 'running')) AS runner_active,
				(SELECT COALESCE(sum(u.units), 0) FROM usage_ledger u
					WHERE u.account_id = a.id AND u.ts > ${new Date(now - FIVE_HOURS_MS).toISOString()}::timestamptz) AS used_5h
			FROM provider_account a
			JOIN runner rn ON rn.id = a.runner_id
			WHERE ${where}
			ORDER BY lower(rn.name), a.key`
	);
	if (!rows.length) return [];
	const weekStarts = new Map(
		rows.map((r) => [String(r.id), weekStartOf(ms(r.week_anchor), now)] as const)
	);
	const values = sql.join(
		rows.map(
			(r) =>
				sql`(${String(r.id)}::uuid, ${new Date(weekStarts.get(String(r.id))!).toISOString()}::timestamptz)`
		),
		sql`, `
	);
	const weekRows = await rowsOf(
		tx,
		sql`SELECT w.id AS account_id, COALESCE(sum(u.units), 0) AS used
			FROM (VALUES ${values}) AS w(id, start)
			LEFT JOIN usage_ledger u ON u.account_id = w.id AND u.ts >= w.start
			GROUP BY w.id`
	);
	const usedWeek = new Map(weekRows.map((r) => [String(r.account_id), num(r.used)]));
	// Limit-Proben aller Konten mit Schnappschuss (eine Abfrage)
	const snapshots = new Map(
		rows.map((r) => [String(r.id), parseSnapshot(r.limit_snapshot)] as const)
	);
	const samples = await loadLimitSamples(
		tx,
		rows.filter((r) => snapshots.get(String(r.id))).map((r) => String(r.id)),
		now
	);
	return rows.map((r) => {
		const id = String(r.id);
		const snapshot = snapshots.get(id) ?? null;
		const state: AccountState = {
			id,
			runnerId: String(r.runner_id),
			provider: String(r.provider) as Provider,
			enabled: r.enabled === true,
			loggedIn: r.logged_in === true,
			runnerOnline: r.runner_online === true && r.runner_status === 'approved',
			runnerFreeSlots: Math.max(0, num(r.runner_max_slots) - num(r.runner_active)),
			running: num(r.running),
			maxConcurrency: num(r.max_concurrency),
			cooldownUntil: ms(r.cooldown_until),
			budget5h: effectiveBudget(r.calibrated_5h_units, r.budget_5h_units),
			budgetWeek: effectiveBudget(r.calibrated_week_units, r.budget_week_units),
			used5h: num(r.used_5h),
			usedWeek: usedWeek.get(id) ?? 0,
			weekStart: weekStarts.get(id)!,
			contextK: num(r.context_k),
			defaultModel: String(r.default_model ?? ''),
			reported: reportedUtil(snapshot, now),
			rejectedUntil: rejectedUntil(snapshot, now)
		};
		const u = utilization(state);
		const dto = accountDto(
			r,
			{
				used5h: state.used5h,
				usedWeek: state.usedWeek,
				util5h: u.u5h,
				utilWeek: u.uWeek,
				running: state.running
			},
			{ fiveHours: state.budget5h, week: state.budgetWeek },
			snapshot ? analyzeLimits(snapshot, state, samples.get(id) ?? [], now) : null
		);
		return { row: r, state, dto };
	});
}

export async function loadAccountDtos(tx: Tx, where?: SQL): Promise<AccountDto[]> {
	return (await loadAccountViews(tx, Date.now(), where)).map((v) => v.dto);
}

export async function loadRunnerDtos(tx: Tx, where: SQL = sql`TRUE`): Promise<RunnerDto[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT * FROM runner WHERE ${where} ORDER BY lower(name), created_at`
	);
	if (!rows.length) return [];
	const accounts = await loadAccountDtos(tx);
	return rows.map((r) =>
		runnerDto(
			r,
			accounts.filter((a) => a.runnerId === String(r.id))
		)
	);
}

export async function loadOverview(tx: Tx): Promise<OverviewDto> {
	const [runnerStats] = await rowsOf(
		tx,
		sql`SELECT count(*) AS total,
				count(*) FILTER (WHERE online AND status = 'approved') AS online,
				count(*) FILTER (WHERE status = 'pending') AS pending
			FROM runner`
	);
	const [taskStats] = await rowsOf(
		tx,
		sql`SELECT count(*) FILTER (WHERE t.status = 'queued') AS queued,
				count(*) FILTER (WHERE t.status = 'running') AS running,
				count(*) FILTER (WHERE t.status = 'review') AS review,
				count(*) FILTER (WHERE t.status = 'needs-input') AS needs_input,
				count(*) FILTER (WHERE t.status = 'failed') AS failed
			FROM task t JOIN project p ON p.id = t.project_id
			WHERE p.archived_at IS NULL`
	);
	const active = await rowsOf(
		tx,
		sql`SELECT r.*, a.label AS account_label, a.key AS account_key, rn.name AS runner_name,
				t.title AS task_title, p.name AS project_name
			FROM run r
			JOIN task t ON t.id = r.task_id
			JOIN project p ON p.id = r.project_id
			LEFT JOIN provider_account a ON a.id = r.account_id
			LEFT JOIN runner rn ON rn.id = r.runner_id
			WHERE r.status IN ('offered', 'running')
			ORDER BY r.created_at`
	);
	return {
		runners: {
			total: num(runnerStats?.total),
			online: num(runnerStats?.online),
			pendingApproval: num(runnerStats?.pending)
		},
		accounts: await loadAccountDtos(tx),
		tasks: {
			queued: num(taskStats?.queued),
			running: num(taskStats?.running),
			review: num(taskStats?.review),
			needsInput: num(taskStats?.needs_input),
			failed: num(taskStats?.failed)
		},
		activeRuns: active.map((r) => ({
			...runSummaryDto(r),
			taskId: String(r.task_id),
			taskTitle: String(r.task_title),
			projectId: String(r.project_id),
			projectName: String(r.project_name)
		}))
	};
}
