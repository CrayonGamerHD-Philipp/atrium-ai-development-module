/**
 * Limit-Stand speichern und laden: Schnappschuss je Konto (`provider_account.limit_snapshot`, nur wenn neuer als
 * der gespeicherte, Zeiten auf die Atrium-Uhr begrenzt) und Verlaufsproben (`account_limit_sample`, höchstens eine
 * je Konto und Fenster alle 5 min, mit dem Verbrauch aus `usage_ledger` im Fenster). Auswertung: `limits.ts`.
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

/** Verbrauch (ohne Reservierungen) eines Kontos im Zeitraum `[since, until]` */
async function unitsBetween(
	tx: Tx,
	accountId: string,
	since: number,
	until: number
): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT COALESCE(sum(units), 0) AS used FROM usage_ledger
			WHERE account_id = ${accountId} AND source <> 'reserved'
				AND ts >= ${iso(since)}::timestamptz AND ts <= ${iso(until)}::timestamptz`
	);
	return num(r?.used);
}

/**
 * Zeiten eines Schnappschusses auf die Atrium-Uhr bringen: Liegt `observedAt` in der Zukunft (vorgehende
 * Runner-Uhr), werden Schnappschuss und Fensterzeiten um diese Abweichung zurückgesetzt; Fensterzeiten nie nach
 * dem Schnappschuss. Ungültige Zeit → null.
 */
export function normalizeSnapshot(snapshot: LimitSnapshot, now: number): LimitSnapshot | null {
	const raw = new Date(snapshot.observedAt).getTime();
	if (!Number.isFinite(raw)) return null;
	const skew = Math.max(0, raw - now);
	const observed = raw - skew;
	const windows = snapshot.windows.map((w) => {
		if (w.observedAt === undefined) return w;
		const own = new Date(w.observedAt).getTime() - skew;
		const rest = { ...w };
		delete rest.observedAt;
		// eigene Zeit nur, wenn sie gültig und älter als der Schnappschuss ist
		return Number.isFinite(own) && own < observed ? { ...rest, observedAt: iso(own) } : rest;
	});
	return { ...snapshot, observedAt: iso(observed), windows };
}

/**
 * Schnappschuss speichern, sofern er neuer ist als der gespeicherte; dann je Fenster eine Probe (höchstens alle
 * 5 min, zur Beobachtungszeit des Fensters). Liefert `true`, wenn gespeichert wurde. Alle Zeiten werden auf „jetzt“
 * begrenzt (`normalizeSnapshot`), damit eine vorgehende Runner-Uhr weder spätere Meldungen blockiert noch den
 * Stand dauerhaft aktuell erscheinen lässt. Die ursprüngliche Runner-Zeit (`runnerObservedAt` im JSON) erkennt
 * wiederholt gesendete, identische Beobachtungen, die sonst durch das Begrenzen jedes Mal neuer wirken würden.
 */
export async function storeLimitSnapshot(
	tx: Tx,
	accountId: string,
	snapshot: LimitSnapshot,
	now: number = Date.now()
): Promise<boolean> {
	const normalized = normalizeSnapshot(snapshot, now);
	if (!normalized) return false;
	const observed = new Date(normalized.observedAt).getTime();
	const runnerObservedAt = iso(new Date(snapshot.observedAt).getTime());
	const updated = await oneOf(
		tx,
		sql`UPDATE provider_account SET limit_snapshot = ${jsonb({ ...normalized, runnerObservedAt })},
				limit_snapshot_at = ${normalized.observedAt}::timestamptz
			WHERE id = ${accountId}
				AND (limit_snapshot_at IS NULL OR limit_snapshot_at < ${normalized.observedAt}::timestamptz)
				AND (limit_snapshot ->> 'runnerObservedAt') IS DISTINCT FROM ${runnerObservedAt}
			RETURNING id`
	);
	if (!updated) return false;

	const windows = [...new Map(normalized.windows.map((w) => [w.window, w])).values()];
	const recent = await rowsOf(
		tx,
		sql`SELECT time_window, max(ts) AS last_ts FROM account_limit_sample
			WHERE account_id = ${accountId} AND ts > ${iso(observed - LIMIT_SAMPLE_LOOKBACK_MS)}::timestamptz
			GROUP BY time_window`
	);
	const lastSample = new Map(
		recent.map((r) => [String(r.time_window), new Date(toIso(r.last_ts)).getTime()])
	);
	for (const w of windows) {
		const at = w.observedAt ? new Date(w.observedAt).getTime() : observed;
		// höchstens eine Probe je Fenster alle 5 min; ältere, erneut mitgesendete Fenster liegen bereits vor
		const last = lastSample.get(w.window);
		if (last !== undefined && last > at - LIMIT_SAMPLE_INTERVAL_MS) continue;
		const duration = WINDOW_DURATION_MS[w.window];
		let units = 0;
		if (duration != null) {
			// Fensterbeginn aus der Rücksetzzeit (Anbieterfenster), sonst gleitend bis zur Beobachtung
			const resetsAt = w.resetsAt ? new Date(w.resetsAt).getTime() : null;
			const start = resetsAt != null && resetsAt > at ? resetsAt - duration : at - duration;
			units = await unitsBetween(tx, accountId, Math.min(start, at), at);
		}
		await tx.execute(
			sql`INSERT INTO account_limit_sample
					(id, account_id, ts, time_window, used_percent, resets_at, units_in_window)
				VALUES (${crypto.randomUUID()}, ${accountId}, ${iso(at)}::timestamptz, ${w.window},
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
