/**
 * Limit-Analyse (reine Logik, keine Datenbankzugriffe): wertet den zuletzt gemeldeten Limit-Stand eines Kontos
 * (`provider_account.limit_snapshot`) zusammen mit den Verlaufsproben (`account_limit_sample`) und dem
 * Scheduler-Zustand aus – Aktualität, eigene Schätzung, Prognose der Erschöpfung und Budgetvorschläge.
 * Aufgerufen von `usage.service.ts`; der Scheduler nutzt `reportedUtil` und `rejectedUntil`.
 */
import { limitSnapshotSchema, type LimitSnapshot, type LimitWindow } from './protocol';
import { utilization, type AccountState } from './scheduler';
import type { AccountLimitWindowDto, AccountLimitsDto } from './schemas';

/** Ab diesem Alter gilt ein Limit-Stand als veraltet */
export const LIMIT_STALE_MS = 30 * 60 * 1000;
/** Höchstens eine Probe je Konto und Fenster in diesem Abstand */
export const LIMIT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/** Zeitraum der Proben für Prognose und Budgetvorschlag */
export const LIMIT_SAMPLE_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
/** Aufbewahrung der Proben (Job `retention`) */
export const LIMIT_SAMPLE_RETENTION_DAYS = 14;
/** Budgetvorschläge erst ab dieser gemeldeten Auslastung (darunter zu ungenau) */
export const MIN_PERCENT_FOR_BUDGET = 10;
/** Toleranz beim Zuordnen von Proben zur aktuellen Reset-Periode (Rücksetzzeiten schwanken leicht) */
const RESET_TOLERANCE_MS = 10 * 60 * 1000;

const HOUR_MS = 3600 * 1000;

/** Länge der Fenster (für die Verbrauchssumme der Proben); `other` hat keine bekannte Länge */
export const WINDOW_DURATION_MS: Record<LimitWindow['window'], number | null> = {
	'5h': 5 * HOUR_MS,
	week: 7 * 24 * HOUR_MS,
	'week-opus': 7 * 24 * HOUR_MS,
	'week-sonnet': 7 * 24 * HOUR_MS,
	daily: 24 * HOUR_MS,
	other: null
};

const WEEK_WINDOWS: ReadonlySet<LimitWindow['window']> = new Set([
	'week',
	'week-opus',
	'week-sonnet'
]);

/** Verlaufsprobe eines Fensters (Zeiten in ms seit Epoch) */
export interface LimitSample {
	window: string;
	ts: number;
	usedPercent: number | null;
	resetsAt: number | null;
	unitsInWindow: number;
}

/** ISO-Zeit → ms (ungültig/leer → null) */
function msOf(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const t = new Date(iso).getTime();
	return Number.isFinite(t) ? t : null;
}

const finite = (n: number | null | undefined): n is number =>
	typeof n === 'number' && Number.isFinite(n);

/** Gespeicherten Schnappschuss (jsonb, evtl. als Text) prüfen; ungültig → null */
export function parseSnapshot(v: unknown): LimitSnapshot | null {
	if (v === null || v === undefined) return null;
	let value = v;
	if (typeof v === 'string') {
		try {
			value = JSON.parse(v);
		} catch {
			return null;
		}
	}
	const parsed = limitSnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Daten älter als 30 Minuten (oder ohne gültige Beobachtungszeit)? */
export function isStale(snapshot: LimitSnapshot, now: number): boolean {
	const at = msOf(snapshot.observedAt);
	return at == null || now - at > LIMIT_STALE_MS;
}

/** Median (leere Liste → null) */
export function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Lineare Prognose, wann das Fenster 100 % erreicht: Steigung per Kleinste-Quadrate aus den Punkten der aktuellen
 * Reset-Periode, fortgeschrieben ab dem jüngsten Punkt. Nur bei steigender Nutzung und wenn der Zeitpunkt vor
 * `resetsAt` liegt; sonst null. Bereits erschöpft (≥ 100 %) → Zeitpunkt des jüngsten Punkts.
 */
export function forecastExhaustion(
	points: { ts: number; usedPercent: number }[],
	resetsAt: number | null
): number | null {
	if (resetsAt == null) return null;
	const pts = points
		.filter((p) => finite(p.ts) && finite(p.usedPercent))
		.sort((a, b) => a.ts - b.ts);
	if (pts.length < 2) return null;
	const n = pts.length;
	const mx = pts.reduce((s, p) => s + p.ts, 0) / n;
	const my = pts.reduce((s, p) => s + p.usedPercent, 0) / n;
	let sxx = 0;
	let sxy = 0;
	for (const p of pts) {
		sxx += (p.ts - mx) ** 2;
		sxy += (p.ts - mx) * (p.usedPercent - my);
	}
	if (!(sxx > 0)) return null;
	const slope = sxy / sxx; // Prozent je ms
	if (!(slope > 0)) return null;
	const last = pts[n - 1]!;
	const at = last.usedPercent >= 100 ? last.ts : last.ts + (100 - last.usedPercent) / slope;
	if (!Number.isFinite(at) || at >= resetsAt) return null;
	return Math.round(at);
}

/** Budgetvorschlag: Median von `units / (usedPercent / 100)` aus Proben mit mindestens 10 % Auslastung */
export function suggestBudget(
	samples: LimitSample[],
	window: LimitWindow['window']
): number | null {
	const values = samples
		.filter(
			(s) =>
				s.window === window &&
				finite(s.usedPercent) &&
				s.usedPercent >= MIN_PERCENT_FOR_BUDGET &&
				finite(s.unitsInWindow) &&
				s.unitsInWindow > 0
		)
		.map((s) => s.unitsInWindow / (s.usedPercent! / 100));
	const m = median(values);
	return m == null ? null : Math.round(m);
}

/** Gehört die Probe zur gleichen Reset-Periode wie das gemeldete Fenster? */
function samePeriod(sample: LimitSample, resetsAt: number): boolean {
	return sample.resetsAt != null && Math.abs(sample.resetsAt - resetsAt) <= RESET_TOLERANCE_MS;
}

function estimatedUtilOf(
	window: LimitWindow['window'],
	state: AccountState,
	util: { u5h: number; uWeek: number }
): number | null {
	// eigene Schätzung nur bei bekanntem Budget (0 = unbekannt → keine Aussage)
	if (window === '5h') return state.budget5h > 0 ? util.u5h : null;
	if (window === 'week') return state.budgetWeek > 0 ? util.uWeek : null;
	return null;
}

/** Limit-Stand eines Kontos mit Analyse für die Oberfläche */
export function analyzeLimits(
	snapshot: LimitSnapshot,
	state: AccountState,
	samples: LimitSample[],
	now: number
): AccountLimitsDto {
	const util = utilization(state);
	const observedAt = msOf(snapshot.observedAt);
	const windows: AccountLimitWindowDto[] = snapshot.windows.map((w) => {
		const resetsAt = msOf(w.resetsAt);
		let exhaustsAt: number | null = null;
		if (resetsAt != null && resetsAt > now && finite(w.usedPercent)) {
			const points = samples
				.filter((s) => s.window === w.window && finite(s.usedPercent) && samePeriod(s, resetsAt))
				.map((s) => ({ ts: s.ts, usedPercent: s.usedPercent! }));
			// aktueller Stand zählt mit, sofern er nicht schon als Probe vorliegt
			if (observedAt != null && !points.some((p) => p.ts === observedAt)) {
				points.push({ ts: observedAt, usedPercent: w.usedPercent });
			}
			exhaustsAt = forecastExhaustion(points, resetsAt);
		}
		return {
			window: w.window,
			label: w.label,
			usedPercent: w.usedPercent,
			resetsAt: w.resetsAt,
			status: w.status,
			estimatedUtil: estimatedUtilOf(w.window, state, util),
			exhaustsAt: exhaustsAt == null ? null : new Date(exhaustsAt).toISOString()
		};
	});
	return {
		observedAt: snapshot.observedAt,
		source: snapshot.source,
		stale: isStale(snapshot, now),
		windows,
		suggestedBudget5hUnits: suggestBudget(samples, '5h'),
		suggestedBudgetWeekUnits: suggestBudget(samples, 'week')
	};
}

/**
 * Vom Anbieter gemeldete Auslastung (0..1, über 1 bei Overage) für den Scheduler. Nur aktuelle Daten (nicht
 * veraltet) und Fenster, deren Rücksetzzeit noch in der Zukunft liegt; `uWeek` = Maximum aus week/week-opus/
 * week-sonnet. Kein Wert → null.
 */
export function reportedUtil(
	snapshot: LimitSnapshot | null,
	now: number
): { u5h: number | null; uWeek: number | null } {
	const result: { u5h: number | null; uWeek: number | null } = { u5h: null, uWeek: null };
	if (!snapshot || isStale(snapshot, now)) return result;
	for (const w of snapshot.windows) {
		const resetsAt = msOf(w.resetsAt);
		if (resetsAt == null || resetsAt <= now || !finite(w.usedPercent)) continue;
		const u = w.usedPercent / 100;
		if (w.window === '5h') result.u5h = Math.max(result.u5h ?? 0, u);
		else if (WEEK_WINDOWS.has(w.window)) result.uWeek = Math.max(result.uWeek ?? 0, u);
	}
	return result;
}

/**
 * Späteste Rücksetzzeit (ms) eines Fensters mit Status `rejected`, die noch in der Zukunft liegt – wirkt wie eine
 * Wartezeit. `other` (z. B. abgelehntes Overage) bleibt unberücksichtigt, weil das reguläre Kontingent dann noch
 * nutzbar sein kann. Keins → null.
 */
export function rejectedUntil(snapshot: LimitSnapshot | null, now: number): number | null {
	if (!snapshot) return null;
	let until: number | null = null;
	for (const w of snapshot.windows) {
		if (w.status !== 'rejected' || w.window === 'other') continue;
		const resetsAt = msOf(w.resetsAt);
		if (resetsAt != null && resetsAt > now) until = Math.max(until ?? 0, resetsAt);
	}
	return until;
}
