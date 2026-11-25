/** Anzeige-Helfer (rein, ohne Svelte): Zeiten, Einheiten, Status → Badge-Variante, Fehlertexte */
import { ApiClientError } from '$lib/sdk/client';
import { formatDateTime, formatNumber, formatRelative, formatTime } from '$lib/sdk/i18n';
import type { Provider, Role } from '../protocol';
import {
	PROVIDER_LABELS,
	ROLE_LABELS,
	STATUS_LABELS,
	type RunStatus,
	type TaskStatus
} from '../schemas';

export type BadgeTone = 'success' | 'warning' | 'info' | 'destructive' | 'secondary' | 'outline';

export const roleLabel = (r: Role) => ROLE_LABELS[r] ?? r;
export const providerLabel = (p: Provider) => PROVIDER_LABELS[p] ?? p;
export const statusLabel = (s: TaskStatus) => STATUS_LABELS[s] ?? s;

/** Kurze Anbieter-Namen für Badges */
export const PROVIDER_SHORT: Record<Provider, string> = {
	claude: 'Claude',
	codex: 'Codex',
	gemini: 'Gemini',
	'openai-api': 'API',
	fake: 'Test'
};

export const TASK_TONE: Record<TaskStatus, BadgeTone> = {
	draft: 'outline',
	queued: 'secondary',
	blocked: 'secondary',
	running: 'info',
	review: 'info',
	done: 'success',
	failed: 'destructive',
	cancelled: 'outline',
	'needs-input': 'warning'
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
	offered: 'Angeboten',
	running: 'Läuft',
	succeeded: 'Erfolgreich',
	failed: 'Fehlgeschlagen',
	limited: 'Limit erreicht',
	cancelled: 'Abgebrochen',
	lost: 'Verbindung verloren'
};
export const RUN_TONE: Record<RunStatus, BadgeTone> = {
	offered: 'secondary',
	running: 'info',
	succeeded: 'success',
	failed: 'destructive',
	limited: 'warning',
	cancelled: 'outline',
	lost: 'warning'
};

export const ERROR_KIND_LABELS: Record<string, string> = {
	agent: 'Agent-Fehler',
	timeout: 'Zeitüberschreitung',
	limit: 'Nutzungslimit',
	auth: 'Anmeldung beim Anbieter',
	git: 'Git-Fehler',
	conflict: 'Merge-Konflikt',
	tests: 'Tests fehlgeschlagen',
	setup: 'Einrichtung fehlgeschlagen',
	cancelled: 'Abgebrochen',
	internal: 'Interner Fehler'
};

export const PR_STATE_LABELS = { open: 'Offen', merged: 'Gemergt', closed: 'Geschlossen' } as const;

/** Fehlertext aus einer API-Antwort */
export function errMsg(e: unknown, fallback: string): string {
	if (e instanceof ApiClientError) {
		if (e.status === 503)
			return e.message || 'Kein Runner erreichbar. Starte einen Runner und versuche es erneut.';
		return e.message || fallback;
	}
	if (e instanceof Error && e.message) return `${fallback}: ${e.message}`;
	return fallback;
}

/** 503 = kein Runner online o. Ä. */
export const isUnavailable = (e: unknown) => e instanceof ApiClientError && e.status === 503;

export const relative = (iso: string | null | undefined, now = new Date()) =>
	iso ? formatRelative(iso, now) : '–';
export const absolute = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : '');
export const clock = (iso: string | null | undefined) => (iso ? formatTime(iso) : '');
/** Tag + Uhrzeit („heute 14:30“, „Mo., 01.12. 09:00“) – siehe `./datetime` */
export { atDayClock, dayClock } from './datetime';

/** Dauer in Sekunden → „1 h 05 min“, „4 min 12 s“, „35 s“ */
export function duration(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
	if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
	return `${sec} s`;
}

/** Laufzeit von `start` bis `end` (oder jetzt) */
export function elapsed(start: string | null, end: string | null, now: number): string {
	if (!start) return '–';
	const a = Date.parse(start);
	const b = end ? Date.parse(end) : now;
	if (!Number.isFinite(a) || !Number.isFinite(b)) return '–';
	return duration((b - a) / 1000);
}

/** Verbrauchseinheiten (≈ Tokens) kompakt: 1,2 Mio. / 350 Tsd. */
export function units(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0';
	if (n >= 1_000_000) return `${formatNumber(n / 1_000_000, n >= 10_000_000 ? 0 : 1)} Mio.`;
	if (n >= 1_000) return `${formatNumber(n / 1_000, 0)} Tsd.`;
	return formatNumber(n, 0);
}

/** Auslastung 0..1 (oder darüber) → Prozent, geklemmt */
export const percent = (x: number) =>
	Math.round(Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 9.99) * 100);

/** Kürzt Text auf `max` Zeichen */
export function shorten(text: string, max = 160): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Wert eines Ereignis-Payloads als Text (Objekte als JSON) */
export function asText(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

/** Kurzform eines Tool-Inputs (häufige Felder zuerst) */
export function toolSummary(input: unknown): string {
	if (input && typeof input === 'object') {
		const o = input as Record<string, unknown>;
		for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
			if (typeof o[key] === 'string' && o[key]) return shorten(o[key] as string, 120);
		}
	}
	return shorten(asText(input), 120);
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '');

/** Erste Zeile einer Commit-Nachricht */
export const firstLine = (msg: string) => msg.split('\n', 1)[0] ?? '';

/** Titel oder gekürzter Prompt */
export const taskTitle = (t: { title: string; prompt: string }) =>
	t.title?.trim() || shorten(t.prompt, 80) || 'Ohne Titel';
