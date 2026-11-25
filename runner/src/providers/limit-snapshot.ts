/**
 * Limit-Schnappschüsse: reine Abbildung der Anbieter-Formate auf `LimitWindow` (Vertrag in `protocol.ts`) und ein
 * Speicher, der je Konto und Fenster den jüngsten Stand hält.
 *
 * Quellen:
 * - Claude `rate_limit_event.rate_limit_info` (Run-Stream): `rateLimitType`, `status`, `resetsAt` (Unix-Sekunden,
 *   defensiv auch Millisekunden), `utilization` (Verhältnis 0–1), optional `unifiedWindows.<typ>.{…}`.
 * - Claude OAuth-Abfrage (`/api/oauth/usage`): `five_hour.utilization` (bereits 0–100), `resets_at` (ISO).
 * - Codex `rate_limits.primary/secondary` (Ereignis `token_count` in Stream bzw. Sitzungsdatei): `used_percent`
 *   (0–100), `window_minutes`, `resets_in_seconds` oder `resets_at` (Unix-Sekunden oder ISO).
 *
 * Alle Funktionen werfen nie; unbekannte oder kaputte Eingaben ergeben `null`.
 */
import type { LimitSnapshot, LimitWindow } from '../protocol.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export type LimitWindowKind = LimitWindow['window'];
export type LimitStatus = LimitWindow['status'];
export type LimitSource = LimitSnapshot['source'];

/** Höchstzahl der Fenster je Schnappschuss (Vertrag: `max(10)`) */
export const MAX_WINDOWS = 10;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Prozentwert auf den erlaubten Bereich (0–1000) begrenzen, auf eine Nachkommastelle runden */
function clampPercent(p: number | null): number | null {
	if (p === null || !Number.isFinite(p)) return null;
	return Math.round(Math.min(1000, Math.max(0, p)) * 10) / 10;
}

/** Zeitpunkt aus Unix-Sekunden, Unix-Millisekunden oder ISO-Text → ISO; sonst `null` */
export function toIso(v: unknown): string | null {
	if (typeof v === 'number') {
		if (!Number.isFinite(v) || v <= 0) return null;
		const d = new Date(v > 1e12 ? v : v * 1000);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}
	if (typeof v === 'string' && v.trim()) {
		const s = v.trim();
		if (/^\d+(\.\d+)?$/.test(s)) return toIso(Number(s));
		const t = Date.parse(s);
		return Number.isNaN(t) ? null : new Date(t).toISOString();
	}
	return null;
}

const label = (s: string): string => s.slice(0, 80);

// ---------------------------------------------------------------- Claude

/** Claude-Fenstertyp (`five_hour`, `seven_day_opus`, …) → Fenster des Vertrags */
export function claudeWindow(type: unknown): LimitWindowKind {
	const t = typeof type === 'string' ? type.toLowerCase() : '';
	if (t === 'five_hour' || t === '5h' || t === 'session') return '5h';
	if (t === 'seven_day_opus') return 'week-opus';
	if (t === 'seven_day_sonnet') return 'week-sonnet';
	if (t === 'seven_day' || t === 'week' || t === 'weekly') return 'week';
	return 'other';
}

/** Claude-Status → Status des Vertrags */
export function claudeStatus(status: unknown): LimitStatus {
	switch (typeof status === 'string' ? status.toLowerCase() : '') {
		case 'allowed':
			return 'allowed';
		case 'allowed_warning':
		case 'warning':
			return 'warning';
		case 'rejected':
		case 'blocked':
			return 'rejected';
		default:
			return 'unknown';
	}
}

/** Verhältnis 0–1 (Stream) → Prozent */
function ratioPercent(v: unknown): number | null {
	const n = finite(v);
	return n === null ? null : clampPercent(n * 100);
}

function claudeStreamWindow(type: string, o: Json, fallbackStatus: unknown): LimitWindow {
	return {
		window: claudeWindow(type),
		label: label(type),
		usedPercent: ratioPercent(o.utilization),
		resetsAt: toIso(o.resetsAt ?? o.resets_at),
		status: claudeStatus(o.status ?? fallbackStatus)
	};
}

/**
 * Claude `rate_limit_info` (aus `rate_limit_event`) → Fenster. Das Hauptfenster (`rateLimitType`) hat Vorrang;
 * `unifiedWindows` ergänzt weitere Fenster bzw. fehlende Werte des Hauptfensters.
 */
export function claudeRateLimitWindows(info: unknown): LimitWindow[] | null {
	try {
		if (!isObj(info)) return null;
		const out = new Map<string, LimitWindow>();
		const type = typeof info.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType : '';
		const hasMain = type !== '' || typeof info.status === 'string';
		if (hasMain) {
			const w = claudeStreamWindow(type || 'unbekannt', info, info.status);
			out.set(w.label, w);
		}
		if (isObj(info.unifiedWindows)) {
			for (const [name, v] of Object.entries(info.unifiedWindows)) {
				if (!isObj(v) || !name) continue;
				const w = claudeStreamWindow(name, v, undefined);
				const prev = out.get(w.label);
				if (prev) {
					out.set(w.label, {
						...prev,
						usedPercent: prev.usedPercent ?? w.usedPercent,
						resetsAt: prev.resetsAt ?? w.resetsAt,
						status: prev.status === 'unknown' ? w.status : prev.status
					});
				} else out.set(w.label, w);
			}
		}
		const list = [...out.values()].slice(0, MAX_WINDOWS);
		return list.length ? list : null;
	} catch {
		return null;
	}
}

/**
 * Antwort der Claude-OAuth-Abfrage (`GET /api/oauth/usage`) → Fenster. `utilization` ist dort bereits in Prozent;
 * Fenster mit `null` werden übersprungen. Unbekannte Schlüssel mit derselben Form landen als `other`.
 */
export function claudeUsageWindows(body: unknown): LimitWindow[] | null {
	try {
		if (!isObj(body)) return null;
		const out: LimitWindow[] = [];
		for (const [name, v] of Object.entries(body)) {
			if (!isObj(v)) continue;
			const used = finite(v.utilization);
			const resetsAt = toIso(v.resets_at ?? v.resetsAt);
			if (used === null && resetsAt === null) continue;
			const usedPercent = clampPercent(used);
			out.push({
				window: claudeWindow(name),
				label: label(name),
				usedPercent,
				resetsAt,
				status: typeof v.status === 'string' ? claudeStatus(v.status) : percentStatus(usedPercent)
			});
			if (out.length >= MAX_WINDOWS) break;
		}
		return out.length ? out : null;
	} catch {
		return null;
	}
}

/** Status aus einer Auslastung ableiten, wenn der Anbieter keinen liefert */
function percentStatus(p: number | null): LimitStatus {
	if (p === null) return 'unknown';
	return p >= 100 ? 'rejected' : 'allowed';
}

// ---------------------------------------------------------------- Codex

/** Codex `window_minutes` → Fenster (≈300 → 5h, ≈10080 → Woche, sonst `other`) */
export function codexWindow(minutes: unknown): LimitWindowKind {
	const m = finite(minutes);
	if (m === null) return 'other';
	if (m >= 240 && m <= 360) return '5h';
	if (m >= 9000 && m <= 11_000) return 'week';
	return 'other';
}

function codexEntry(name: string, v: unknown, now: Date): LimitWindow | null {
	if (!isObj(v)) return null;
	const used = finite(v.used_percent ?? v.usedPercent);
	let resetsAt: string | null = null;
	const inSec = finite(v.resets_in_seconds ?? v.resetsInSeconds);
	if (inSec !== null && inSec >= 0) resetsAt = new Date(now.getTime() + inSec * 1000).toISOString();
	else resetsAt = toIso(v.resets_at ?? v.resetsAt);
	if (used === null && resetsAt === null) return null;
	const usedPercent = clampPercent(used);
	return {
		window: codexWindow(v.window_minutes ?? v.windowDurationMins ?? v.windowMinutes),
		label: label(name),
		usedPercent,
		resetsAt,
		status: percentStatus(usedPercent)
	};
}

/** Codex `rate_limits` (`primary`/`secondary`) → Fenster */
export function codexRateLimitWindows(rateLimits: unknown, now: Date = new Date()): LimitWindow[] | null {
	try {
		if (!isObj(rateLimits)) return null;
		const out: LimitWindow[] = [];
		for (const name of ['primary', 'secondary'] as const) {
			const w = codexEntry(name, rateLimits[name], now);
			if (w) out.push(w);
		}
		return out.length ? out : null;
	} catch {
		return null;
	}
}

/**
 * `rate_limits` in einem beliebigen Codex-JSON-Objekt suchen: direkt, unter `payload`, `msg` oder `info`
 * (Formen von `exec --json`, Sitzungsdateien `event_msg/token_count` und älteren Versionen).
 */
export function findCodexRateLimits(o: unknown, depth = 0): unknown {
	if (!isObj(o) || depth > 3) return undefined;
	if (isObj(o.rate_limits)) return o.rate_limits;
	if (isObj(o.rateLimits)) return o.rateLimits;
	for (const k of ['payload', 'msg', 'info', 'event']) {
		const r = findCodexRateLimits(o[k], depth + 1);
		if (r !== undefined) return r;
	}
	return undefined;
}

// ---------------------------------------------------------------- Speicher

/** Gekennzeichnetes Fenster: `other` wird zusätzlich nach Bezeichnung getrennt */
function windowKey(w: LimitWindow): string {
	return w.window === 'other' ? `other:${w.label}` : w.window;
}

interface StoredWindow {
	value: LimitWindow;
	observedAt: number;
	source: LimitSource;
}

/** Hält je Konto und Fenster den zuletzt beobachteten Stand (zusammengeführt nach `observedAt`). */
export class LimitStore {
	private readonly accounts = new Map<string, Map<string, StoredWindow>>();

	/** Fenster übernehmen; ältere Beobachtungen überschreiben neuere nie. */
	update(accountKey: string, windows: LimitWindow[], source: LimitSource, observedAt: Date = new Date()): void {
		const t = observedAt.getTime();
		if (!windows.length || !Number.isFinite(t)) return;
		let m = this.accounts.get(accountKey);
		if (!m) {
			m = new Map();
			this.accounts.set(accountKey, m);
		}
		for (const w of windows) {
			const k = windowKey(w);
			const prev = m.get(k);
			if (prev && prev.observedAt > t) continue;
			// Meldungen ohne Prozentwert (z. B. Limit-Treffer) behalten die zuletzt bekannte Auslastung
			// (nur solange das alte Fenster noch nicht zurückgesetzt wurde)
			const keep =
				prev !== undefined &&
				w.usedPercent === null &&
				(!prev.value.resetsAt || Date.parse(prev.value.resetsAt) > t);
			const value = keep ? { ...w, usedPercent: prev.value.usedPercent } : w;
			m.set(k, { value, observedAt: t, source });
		}
		// Höchstzahl einhalten: älteste Fenster verwerfen
		if (m.size > MAX_WINDOWS) {
			const sorted = [...m.entries()].sort((a, b) => a[1].observedAt - b[1].observedAt);
			for (const [k] of sorted.slice(0, m.size - MAX_WINDOWS)) m.delete(k);
		}
	}

	/** Zeitpunkt der jüngsten Beobachtung einer Quelle (ms) oder `null` */
	lastObserved(accountKey: string, source?: LimitSource): number | null {
		const m = this.accounts.get(accountKey);
		if (!m) return null;
		let best: number | null = null;
		for (const s of m.values()) if ((!source || s.source === source) && (best === null || s.observedAt > best)) best = s.observedAt;
		return best;
	}

	/** Aktueller Schnappschuss eines Kontos (Quelle der jüngsten Beobachtung) oder `null` */
	snapshot(accountKey: string): LimitSnapshot | null {
		const m = this.accounts.get(accountKey);
		if (!m || !m.size) return null;
		const entries = [...m.values()];
		const latest = entries.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
		const order: LimitWindowKind[] = ['5h', 'week', 'week-opus', 'week-sonnet', 'daily', 'other'];
		const windows = entries
			.map((e) => e.value)
			.sort((a, b) => order.indexOf(a.window) - order.indexOf(b.window) || a.label.localeCompare(b.label));
		return { observedAt: new Date(latest.observedAt).toISOString(), source: latest.source, windows };
	}
}

/**
 * Fenster aus einem erkannten Limit-Treffer (Fehlermeldung), wenn der Stream keinen Stand lieferte. Nur `5h` und
 * `week` lassen sich einem Fenster zuordnen.
 */
export function limitHitWindow(kind: string, resetsAt: string | null): LimitWindow | null {
	if (kind !== '5h' && kind !== 'week') return null;
	return { window: kind, label: kind, usedPercent: null, resetsAt: toIso(resetsAt), status: 'rejected' };
}
