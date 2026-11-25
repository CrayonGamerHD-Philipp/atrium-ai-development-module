/**
 * Limit-Stand speichern und laden: Schnappschuss je Konto (`provider_account.limit_snapshot`, nur wenn neuer als
 * der gespeicherte) und Verlaufsproben (`account_limit_sample`, höchstens eine je Konto und Fenster alle 5 min,
 * mit dem Verbrauch aus `usage_ledger` im Fenster). Auswertung: `limits.ts`.
 */
import { sql } from 'drizzle-orm';
import { inList, num, rowsOf, toIso } from '$lib/sdk/server';
import { jsonb, oneOf, type Tx } from './db';
import {
	LIMIT_SAMPLE_INTERVAL_MS,
	LIMIT_SAMPLE_LOOKBACK_MS,
	WINDOW_DURATION_MS,
	type LimitSample
} from './limits';
import type { LimitSnapshot } from './protocol';

const iso = (ms: number) => new Date(ms).toISOString();

/** Verbrauch (ohne Reservierungen) eines Kontos seit `since` */
async function unitsSince(tx: Tx, accountId: string, since: number): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT COALESCE(sum(units), 0) AS used FROM usage_ledger
			WHERE account_id = ${accountId} AND source <> 'reserved' AND ts >= ${iso(since)}::timestamptz`
	);
	return num(r?.used);
}

/**
 * Schnappschuss speichern, sofern er neuer ist als der gespeicherte; dann je Fenster eine Probe (höchstens alle
 * 5 min). Liefert `true`, wenn gespeichert wurde. `limit_snapshot_at` wird auf „jetzt“ begrenzt, damit eine
 * vorgehende Runner-Uhr spätere Meldungen nicht blockiert.
 */
export async function storeLimitSnapshot(
	tx: Tx,
	accountId: string,
	snapshot: LimitSnapshot,
	now: number = Date.now()
): Promise<boolean> {
	const observed = Math.min(new Date(snapshot.observedAt).getTime(), now);
	if (!Number.isFinite(observed)) return false;
	const updated = await oneOf(
		tx,
		sql`UPDATE provider_account SET limit_snapshot = ${jsonb(snapshot)},
				limit_snapshot_at = ${iso(observed)}::timestamptz
			WHERE id = ${accountId}
				AND (limit_snapshot_at IS NULL OR limit_snapshot_at < ${iso(observed)}::timestamptz)
			RETURNING id`
	);
	if (!updated) return false;

	const windows = [...new Map(snapshot.windows.map((w) => [w.window, w])).values()];
	const recent = await rowsOf(
		tx,
		sql`SELECT DISTINCT time_window FROM account_limit_sample
			WHERE account_id = ${accountId} AND ts > ${iso(observed - LIMIT_SAMPLE_INTERVAL_MS)}::timestamptz`
	);
	const skip = new Set(recent.map((r) => String(r.time_window)));
	for (const w of windows) {
		if (skip.has(w.window)) continue;
		const duration = WINDOW_DURATION_MS[w.window];
		let units = 0;
		if (duration != null) {
			// Fensterbeginn aus der Rücksetzzeit (Anbieterfenster), sonst gleitend ab jetzt
			const resetsAt = w.resetsAt ? new Date(w.resetsAt).getTime() : null;
			const start = resetsAt != null && resetsAt > now ? resetsAt - duration : now - duration;
			units = await unitsSince(tx, accountId, Math.min(start, now));
		}
		await tx.execute(
			sql`INSERT INTO account_limit_sample
					(id, account_id, ts, time_window, used_percent, resets_at, units_in_window)
				VALUES (${crypto.randomUUID()}, ${accountId}, ${iso(observed)}::timestamptz, ${w.window},
					${w.usedPercent}, ${w.resetsAt}::timestamptz, ${units})`
		);
	}
	return true;
}

/** Proben der letzten 7 Tage für alle angegebenen Konten (eine Abfrage), nach Konto gruppiert */
export async function loadLimitSamples(
	tx: Tx,
	accountIds: string[],
	now: number = Date.now()
): Promise<Map<string, LimitSample[]>> {
	const result = new Map<string, LimitSample[]>();
	if (!accountIds.length) return result;
	const rows = await rowsOf(
		tx,
		sql`SELECT account_id, ts, time_window, used_percent, resets_at, units_in_window
			FROM account_limit_sample
			WHERE account_id IN (${inList(accountIds)})
				AND ts > ${iso(now - LIMIT_SAMPLE_LOOKBACK_MS)}::timestamptz
			ORDER BY account_id, ts`
	);
	for (const r of rows) {
		const id = String(r.account_id);
		const list = result.get(id) ?? [];
		list.push({
			window: String(r.time_window),
			ts: new Date(toIso(r.ts)).getTime(),
			usedPercent:
				r.used_percent === null || r.used_percent === undefined ? null : num(r.used_percent),
			resetsAt: r.resets_at ? new Date(toIso(r.resets_at)).getTime() : null,
			unitsInWindow: num(r.units_in_window)
		});
		result.set(id, list);
	}
	return result;
}
