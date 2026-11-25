/** Reine Datums-Helfer ohne API-Client (auch in Unit-Tests importierbar) */
import { intlLocale } from '$lib/sdk/i18n';

/** Zeitzone wie in `$lib/sdk/i18n` (`absolute`/`clock` formatieren ebenfalls in Europe/Berlin) */
export const DISPLAY_TIME_ZONE = 'Europe/Berlin';

const DAY_MS = 24 * 60 * 60 * 1000;

function locale(): string {
	try {
		return intlLocale() || 'de-DE';
	} catch {
		return 'de-DE';
	}
}

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, zone: string, opts: Intl.DateTimeFormatOptions) {
	const l = locale();
	const k = `${key}:${l}:${zone}`;
	let f = cache.get(k);
	if (!f) {
		f = new Intl.DateTimeFormat(l, { ...opts, timeZone: zone });
		cache.set(k, f);
	}
	return f;
}

/** Kalendertag eines Zeitpunkts in der Zeitzone als Zahl (Tage seit 1970) – für „heute“/„morgen“ */
function dayNumber(d: Date, zone: string): number {
	const parts = fmt('ymd', zone, {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric'
	}).formatToParts(d);
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS);
}

function yearOf(d: Date, zone: string): string {
	return fmt('y', zone, { year: 'numeric' }).format(d);
}

export interface DayClockParts {
	/** „heute“, „morgen“ oder „Mo., 01.12.“ / „Mo., 01.12.2027“ */
	day: string;
	/** „14:30“ */
	time: string;
	/** `day` ist „heute“ bzw. „morgen“ (ohne Datum) */
	relative: boolean;
}

/**
 * Zerlegt einen Zeitpunkt in Tag und Uhrzeit, bezogen auf den Kalendertag in `timeZone` (Standard Europe/Berlin):
 * „heute“ / „morgen“, sonst Wochentag kurz + Datum (Jahr nur, wenn es nicht das aktuelle ist). Leer/ungültig → null.
 */
export function dayClockParts(
	iso: string | null | undefined,
	now: number | Date = Date.now(),
	timeZone: string = DISPLAY_TIME_ZONE
): DayClockParts | null {
	if (!iso) return null;
	const d = new Date(iso);
	const n = now instanceof Date ? now : new Date(now);
	if (Number.isNaN(d.getTime()) || Number.isNaN(n.getTime())) return null;
	const time = fmt('hm', timeZone, { hour: '2-digit', minute: '2-digit' }).format(d);
	const diff = dayNumber(d, timeZone) - dayNumber(n, timeZone);
	if (diff === 0) return { day: 'heute', time, relative: true };
	if (diff === 1) return { day: 'morgen', time, relative: true };
	const sameYear = yearOf(d, timeZone) === yearOf(n, timeZone);
	const day = fmt(sameYear ? 'wdm' : 'wdmy', timeZone, {
		weekday: 'short',
		day: '2-digit',
		month: '2-digit',
		...(sameYear ? {} : { year: 'numeric' })
	}).format(d);
	return { day, time, relative: false };
}

/** Zeitpunkt → „heute 14:30“, „morgen 09:00“, „Mo., 01.12. 09:00“ (Jahr nur, wenn nicht aktuell); leer/ungültig → '' */
export function dayClock(
	iso: string | null | undefined,
	now: number | Date = Date.now(),
	timeZone: string = DISPLAY_TIME_ZONE
): string {
	const p = dayClockParts(iso, now, timeZone);
	return p ? `${p.day} ${p.time}` : '';
}

/** Wie `dayClock`, aber als Satzteil: „heute um 14:30“, „am Mo., 01.12. um 09:00“; leer/ungültig → '' */
export function atDayClock(
	iso: string | null | undefined,
	now: number | Date = Date.now(),
	timeZone: string = DISPLAY_TIME_ZONE
): string {
	const p = dayClockParts(iso, now, timeZone);
	if (!p) return '';
	return `${p.relative ? p.day : `am ${p.day}`} um ${p.time}`;
}
