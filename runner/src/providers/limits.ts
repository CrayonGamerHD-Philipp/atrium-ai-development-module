/**
 * Erkennung von Nutzungs-/Rate-Limits in der Ausgabe der Agent-CLIs. Versionierte Muster-Tabelle je Anbieter;
 * unbekannte Ausgabe liefert `null` und bricht nie einen Lauf ab.
 */
import type { Provider } from '../protocol.ts';

export const LIMIT_PATTERNS_VERSION = '2026-11.1';

export type LimitKind = 'rate' | '5h' | 'week' | 'auth' | 'other';

export interface DetectedLimit {
	kind: LimitKind;
	resetsAt: string | null;
}

interface LimitPattern {
	providers: Provider[] | '*';
	re: RegExp;
	/** `auto`: anhand der Rücksetzzeit (≤ 15 min → `rate`, ≤ 6 h → `5h`, sonst `week`; ohne Zeit `fallback`) */
	kind: LimitKind | 'auto';
	fallback?: LimitKind;
}

/** Reihenfolge ist wichtig: spezifische Muster zuerst */
export const LIMIT_PATTERNS: LimitPattern[] = [
	// Claude Code
	{ providers: ['claude'], re: /Claude AI usage limit reached/i, kind: 'auto', fallback: '5h' },
	{ providers: ['claude'], re: /\b(?:5|five)[- ]hour limit/i, kind: '5h' },
	{ providers: ['claude'], re: /\b(?:weekly|7[- ]day|seven[- ]day)\b[^\n]{0,40}\blimit/i, kind: 'week' },
	{ providers: ['claude'], re: /\b(?:Opus|Sonnet) (?:weekly )?limit\b/i, kind: 'week' },
	{
		providers: ['claude'],
		re: /\b(?:you'?ve|you have|you’ve) (?:hit|reached) your (?:usage )?limit\b|\busage limit reached\b|\bout of extra usage\b/i,
		kind: 'auto',
		fallback: '5h'
	},
	// Codex / OpenAI
	{
		providers: ['codex', 'openai-api'],
		re: /\b(?:you'?ve|you’ve|you have) hit your usage limit\b|\busage_limit_reached\b|\busage limit\b/i,
		kind: 'auto',
		fallback: '5h'
	},
	{
		providers: ['codex', 'openai-api'],
		re: /\binsufficient_quota\b|\bout of credits\b|\bspend cap\b/i,
		kind: 'other'
	},
	// Gemini
	{ providers: ['gemini'], re: /\bRESOURCE_EXHAUSTED\b/, kind: 'auto', fallback: 'rate' },
	{
		providers: ['gemini'],
		re: /\bquota\b[^\n]{0,80}\b(?:per day|daily)\b|\bdaily (?:quota|limit)\b/i,
		kind: 'other'
	},
	{ providers: ['gemini'], re: /\bquota (?:exceeded|exhausted)\b|\bexceeded your current quota\b/i, kind: 'rate' },
	// Anmeldung (alle Anbieter)
	{
		providers: '*',
		re: /\binvalid api key\b|\bplease run \/login\b|\bnot logged in\b|\bauthentication_error\b|\bOAuth token (?:has )?expired\b|\btoken (?:has )?expired\b[^\n]{0,40}\blog ?in\b|\bAPI Error: 401\b|\b401 Unauthorized\b|\bunauthorized\b[^\n]{0,30}\b(?:token|api key|credentials)\b|\bPlease (?:re-?)?authenticate\b|\bcodex login\b/i,
		kind: 'auth'
	},
	// Allgemeine Rate-Limits (alle Anbieter)
	{
		providers: '*',
		re: /\brate_limit_error\b|\brate[- ]limit(?:ed| exceeded| reached)\b|\b429\b[^\n]{0,40}\b(?:too many requests|rate)|\bToo Many Requests\b|\bstatus(?: code)?:? 429\b|\bAPI Error: 429\b/i,
		kind: 'rate'
	}
];

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11
};

/** Versatz einer IANA-Zeitzone zu UTC in ms für einen Zeitpunkt */
function tzOffsetMs(timeZone: string, at: Date): number | null {
	try {
		const fmt = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
		const asUtc = Date.UTC(
			Number(parts.year),
			Number(parts.month) - 1,
			Number(parts.day),
			Number(parts.hour),
			Number(parts.minute),
			Number(parts.second)
		);
		return asUtc - Math.floor(at.getTime() / 1000) * 1000;
	} catch {
		return null;
	}
}

/** Wandzeit (Y-M-D h:m in Zeitzone `tz` bzw. lokal) in einen Zeitpunkt umrechnen */
function wallClock(y: number, mo: number, d: number, h: number, mi: number, tz: string | null): Date {
	if (tz) {
		const guess = new Date(Date.UTC(y, mo, d, h, mi));
		const off = tzOffsetMs(tz, guess);
		if (off !== null) {
			const first = new Date(guess.getTime() - off);
			const off2 = tzOffsetMs(tz, first);
			return off2 !== null && off2 !== off ? new Date(guess.getTime() - off2) : first;
		}
	}
	return new Date(y, mo, d, h, mi);
}

/** Datumsanteile in der Zeitzone `tz` (bzw. lokal) */
function partsIn(now: Date, tz: string | null): { y: number; mo: number; d: number } {
	if (tz) {
		const off = tzOffsetMs(tz, now);
		if (off !== null) {
			const t = new Date(now.getTime() + off);
			return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
		}
	}
	return { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate() };
}

function to24h(h: number, ampm: string | undefined): number {
	if (!ampm) return h;
	const pm = ampm.toLowerCase().startsWith('p');
	if (h === 12) return pm ? 12 : 0;
	return pm ? h + 12 : h;
}

/**
 * Rücksetzzeit aus einem Text lesen: Unix-Epoch (`|1700000000`, `resetsAt: …`), ISO-Zeitstempel,
 * relative Angaben („in 2 hours 5 minutes“, „in 3 days“, „in 1h 30m“) und Uhrzeiten („resets 3pm“,
 * „try again at 3:05 PM“, optional mit Zeitzone in Klammern, optional mit Datum „Nov 28“).
 */
export function parseResetTime(text: string, now: Date = new Date()): string | null {
	// Unix-Epoch in Sekunden oder Millisekunden
	const epoch =
		/\|\s*(\d{10,13})\b/.exec(text) ??
		/\bresets?_?(?:at|At)?["'\s:=]+(\d{10,13})\b/i.exec(text) ??
		/\breset(?:s|_at|At)?\D{0,5}(\d{10,13})\b/.exec(text);
	if (epoch?.[1]) {
		const n = Number(epoch[1]);
		const ms = epoch[1].length >= 13 ? n : n * 1000;
		if (ms > now.getTime() - 86_400_000) return new Date(ms).toISOString();
	}

	// ISO 8601
	const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text);
	if (iso) {
		const t = Date.parse(iso[0]);
		if (!Number.isNaN(t)) return new Date(t).toISOString();
	}

	// Relativ: "in 2 hours 3 minutes", "in 1h 30m", "in 45 seconds", "in 3 days"
	const rel =
		/\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b[\s,]*(?:and\s+)?)+)/i.exec(
			text
		);
	if (rel?.[1]) {
		let ms = 0;
		const unitRe = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi;
		let m: RegExpExecArray | null;
		while ((m = unitRe.exec(rel[1])) !== null) {
			const n = Number(m[1]);
			const u = (m[2] ?? '').toLowerCase();
			if (u.startsWith('d')) ms += n * 86_400_000;
			else if (u.startsWith('h')) ms += n * 3_600_000;
			else if (u.startsWith('m')) ms += n * 60_000;
			else ms += n * 1000;
		}
		if (ms > 0) return new Date(now.getTime() + ms).toISOString();
	}

	// Uhrzeit, optional mit Datum und Zeitzone: "resets Nov 28, 3pm (Europe/Berlin)", "try again at 3:05 PM"
	const tm =
		/\b(?:resets?|reset at|try again at|available (?:again )?at|at)\s+(?:on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_\/+-]+|UTC|GMT)\))?/i.exec(
			text
		);
	if (tm && (tm[4] !== undefined || tm[5] !== undefined)) {
		const tz = tm[6] ? (/^(UTC|GMT)$/i.test(tm[6]) ? 'UTC' : tm[6]) : null;
		const hour = to24h(Number(tm[3]), tm[5]?.replace(/\./g, ''));
		const minute = tm[4] ? Number(tm[4]) : 0;
		if (hour <= 23 && minute <= 59) {
			const base = partsIn(now, tz);
			let y = base.y;
			let mo = base.mo;
			let d = base.d;
			const monthIdx = tm[1] ? MONTHS[tm[1].toLowerCase()] : undefined;
			const withDate = monthIdx !== undefined && tm[2] !== undefined;
			if (withDate) {
				mo = monthIdx;
				d = Number(tm[2]);
			}
			let at = wallClock(y, mo, d, hour, minute, tz);
			if (withDate && at.getTime() < now.getTime() - 86_400_000) {
				y += 1;
				at = wallClock(y, mo, d, hour, minute, tz);
			} else if (!withDate && at.getTime() <= now.getTime()) {
				at = wallClock(y, mo, d + 1, hour, minute, tz);
			}
			return at.toISOString();
		}
	}
	return null;
}

/** Limit in einer Textausgabe erkennen (`null` = kein Limit) */
export function detectLimit(
	provider: Provider,
	text: string,
	now: Date = new Date()
): DetectedLimit | null {
	if (!text) return null;
	const sample = text.length > 20_000 ? text.slice(-20_000) : text;
	for (const p of LIMIT_PATTERNS) {
		if (p.providers !== '*' && !p.providers.includes(provider)) continue;
		if (!p.re.test(sample)) continue;
		const resetsAt = p.kind === 'auth' ? null : parseResetTime(sample, now);
		let kind: LimitKind;
		if (p.kind === 'auto') {
			if (resetsAt) {
				const diff = Date.parse(resetsAt) - now.getTime();
				kind = diff <= 15 * 60_000 ? 'rate' : diff > 6 * 3_600_000 ? 'week' : '5h';
			} else kind = p.fallback ?? 'other';
		} else kind = p.kind;
		return { kind, resetsAt };
	}
	return null;
}

/** Claude `rate_limit_event`: Fenster-Typ auf Limit-Art abbilden */
export function claudeWindowKind(type: unknown): LimitKind {
	const t = typeof type === 'string' ? type.toLowerCase() : '';
	if (t.includes('five_hour') || t.includes('5h') || t.includes('session')) return '5h';
	if (t.includes('seven_day') || t.includes('week') || t.includes('opus') || t.includes('sonnet'))
		return 'week';
	if (t.includes('overage')) return 'other';
	return 'rate';
}
