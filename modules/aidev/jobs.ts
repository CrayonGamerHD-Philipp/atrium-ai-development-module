/**
 * Hintergrundjobs: Sicherheitsnetz des Schedulers (Leases, Runner offline, Dispatch), PR-Abgleich und Aufräumen.
 * Alle idempotent (Abbruch mitten im Lauf möglich).
 */
import { sql } from 'drizzle-orm';
import { logBestEffort, rowsOf, type ModuleJob } from '$lib/sdk/server';
import { loadSettings, mdb } from './db';
import { LIMIT_SAMPLE_RETENTION_DAYS } from './limits';
import { syncPulls } from './pulls.service';
import { schedulerTick } from './scheduler.service';

/** PR-Abgleich für Projekte mit offenen PRs bzw. Aufträgen im Zustand `review` */
export async function prSyncAll(): Promise<string> {
	const projects = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT p.id FROM project p WHERE p.archived_at IS NULL AND (
					EXISTS (SELECT 1 FROM pull_request pr WHERE pr.project_id = p.id AND pr.state = 'open')
					OR EXISTS (SELECT 1 FROM task t WHERE t.project_id = p.id AND t.status = 'review')
				)
				ORDER BY p.created_at`
		)
	);
	let ok = 0;
	let failed = 0;
	for (const p of projects) {
		try {
			await syncPulls(null, String(p.id));
			ok++;
		} catch (e) {
			failed++;
			logBestEffort('aidev.pr-sync', e, { target: String(p.id) });
		}
	}
	return `${ok} Projekte abgeglichen, ${failed} fehlgeschlagen`;
}

/**
 * Alte Lauf-Ereignisse (nach `eventRetentionDays`, 0 = nie), liegengebliebene Reservierungen und Limit-Proben
 * älter als 14 Tage löschen
 */
export async function retention(): Promise<string> {
	const { limits } = await loadSettings();
	return mdb().transaction(async (tx) => {
		let events = 0;
		if (limits.eventRetentionDays > 0) {
			const rows = await rowsOf(
				tx,
				sql`DELETE FROM run_event e USING run r
					WHERE e.run_id = r.id AND r.status NOT IN ('offered', 'running')
						AND e.ts < now() - ${limits.eventRetentionDays}::int * interval '1 day'
					RETURNING e.seq`
			);
			events = rows.length;
		}
		const reserved = await rowsOf(
			tx,
			sql`DELETE FROM usage_ledger u WHERE u.source = 'reserved' AND u.ts < now() - interval '24 hours'
				AND NOT EXISTS (SELECT 1 FROM run r WHERE r.id = u.run_id AND r.status IN ('offered', 'running'))
				RETURNING u.id`
		);
		const samples = await rowsOf(
			tx,
			sql`DELETE FROM account_limit_sample
				WHERE ts < now() - ${LIMIT_SAMPLE_RETENTION_DAYS}::int * interval '1 day'
				RETURNING id`
		);
		return `${events} Ereignisse, ${reserved.length} Reservierungen und ${samples.length} Limit-Proben gelöscht`;
	});
}

export const aidevJobs: ModuleJob[] = [
	{
		id: 'scheduler',
		summary:
			'Abgelaufene Läufe zurückstellen, Runner ohne Lebenszeichen offline setzen, Aufträge verteilen',
		schedule: { everyMinutes: 1 },
		run: async () => schedulerTick()
	},
	{
		id: 'pr-sync',
		summary: 'Pull Requests mit GitHub abgleichen',
		schedule: { everyMinutes: 10 },
		run: async () => prSyncAll()
	},
	{
		id: 'retention',
		summary: 'Alte Lauf-Ereignisse, Reservierungen und Limit-Proben löschen',
		schedule: 'daily',
		run: async () => retention()
	}
];
