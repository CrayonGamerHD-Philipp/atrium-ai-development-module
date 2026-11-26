/**
 * Datenbank- und Grundhelfer des Moduls `aidev`: Modul-Datenbank, JSON-Spalten, Kurz-IDs, Zeitkonstanten
 * und die Einstellungen (Routing, Grenzwerte). Core-Services (`core.settings`) nur AUSSERHALB von Transaktionen.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, moduleDb, rowsOf, type Row, type Tx } from '$lib/sdk/server';
import {
	DEFAULT_LIMITS,
	DEFAULT_ROUTING,
	MODULE_ID,
	SETTING_LIMITS,
	SETTING_ROUTING,
	limitsSchema,
	routingSchema,
	type Limits,
	type Routing
} from './schemas';

export type { Row, Tx };

export const mdb = () => moduleDb(MODULE_ID);

/** Lease eines laufenden Laufs (Heartbeat verlängert) */
export const LEASE_SEC = 90;
/** Frist, bis ein angebotener Lauf angenommen sein muss */
export const OFFER_LEASE_SEC = 60;
/** Heartbeat-Abstand des Runners */
export const HEARTBEAT_SEC = 15;
/** Ohne Heartbeat seit dieser Zeit gilt ein Runner als offline */
export const RUNNER_STALE_SEC = 60;
/** Höchstzahl gleichzeitiger Live-Verbindungen je Person und Hub */
export const MAX_STREAMS_PER_USER = 20;

/**
 * Kürzere Lease für Runner auf dem PC des Nutzers (`kind = 'desktop'`): Geht der PC ohne Übergabe in den Standby,
 * übernimmt ein Server-Runner schneller (Heartbeat alle `HEARTBEAT_SEC` → drei verpasste Heartbeats).
 */
export const DESKTOP_LEASE_SEC = 45;

/** Wirksame Lease (Sekunden) eines laufenden Laufs je Runner-Art (unbekannt/fehlend → Server) */
export function leaseSecOf(kind: unknown): number {
	return kind === 'desktop' ? DESKTOP_LEASE_SEC : LEASE_SEC;
}

/**
 * Ohne Heartbeat seit dieser Zeit gilt ein PC-Runner als offline – so lang wie seine Lease: Läuft die Lease ab,
 * wird der neu eingeplante Lauf nicht erneut dem (vermutlich schlafenden) PC angeboten.
 */
export const DESKTOP_STALE_SEC = DESKTOP_LEASE_SEC;

/** Wert als `jsonb`-Parameter */
export const jsonb = (v: unknown): SQL => sql`${JSON.stringify(v)}::jsonb`;

/** jsonb-Spalte (Treiber liefern geparst, ältere Pfade evtl. als Text) */
export function jsonOf<T>(v: unknown, fallback: T): T {
	if (v === null || v === undefined) return fallback;
	if (typeof v === 'string') {
		try {
			return JSON.parse(v) as T;
		} catch {
			return fallback;
		}
	}
	return v as T;
}

/** String-Liste aus einer jsonb-Spalte */
export function stringList(v: unknown): string[] {
	const arr = jsonOf<unknown>(v, []);
	return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
}

/** Kurzform einer UUID für Branch-Namen */
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8);

/** Erste Zeile einer Abfrage oder `null` */
export async function oneOf(tx: Tx, query: SQL): Promise<Row | null> {
	return (await rowsOf(tx, query))[0] ?? null;
}

export interface AidevSettings {
	routing: Routing;
	limits: Limits;
}

/** Routing und Grenzwerte (ungültige gespeicherte Werte → Standard). NICHT in einer Transaktion aufrufen. */
export async function loadSettings(): Promise<AidevSettings> {
	const values = await core.settings.getMany([SETTING_ROUTING, SETTING_LIMITS]);
	const routing = routingSchema.safeParse(values[SETTING_ROUTING]);
	const limits = limitsSchema.safeParse(values[SETTING_LIMITS]);
	return {
		routing: routing.success ? routing.data : DEFAULT_ROUTING,
		limits: limits.success ? limits.data : DEFAULT_LIMITS
	};
}

/** Text auf eine Höchstlänge kürzen (mit Auslassungszeichen) */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
