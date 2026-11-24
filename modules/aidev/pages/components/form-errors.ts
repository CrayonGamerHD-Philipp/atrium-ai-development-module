/** Zod-Fehler und Server-Validierungsfehler auf Felder abbilden */
import { ApiClientError } from '$lib/sdk/client';
import type { ZodError } from 'zod';

export type FieldErrors = Record<string, string>;

export function zodErrors(error: ZodError): FieldErrors {
	const out: FieldErrors = {};
	for (const issue of error.issues) {
		const key = String(issue.path[0] ?? '');
		if (key && !out[key]) out[key] = issue.message;
	}
	return out;
}

/** `ApiClientError.details` (Zod-Issues des Servers) → Feldfehler; leer, wenn nichts passt */
export function serverErrors(e: unknown): FieldErrors {
	const out: FieldErrors = {};
	if (!(e instanceof ApiClientError) || !e.details) return out;
	const d = e.details as unknown;
	const issues: unknown[] = Array.isArray(d)
		? d
		: d && typeof d === 'object' && Array.isArray((d as { issues?: unknown[] }).issues)
			? ((d as { issues: unknown[] }).issues ?? [])
			: [];
	for (const i of issues) {
		if (!i || typeof i !== 'object') continue;
		const path = (i as { path?: unknown[] }).path;
		const msg = (i as { message?: string }).message;
		const key = Array.isArray(path) ? String(path[path[0] === 'body' ? 1 : 0] ?? '') : '';
		if (key && msg && !out[key]) out[key] = msg;
	}
	return out;
}
