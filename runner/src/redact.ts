/**
 * Entfernt Geheimnisse aus allen Texten, bevor sie Atrium erreichen (Ereignisse, Fehlermeldungen, RPC-Antworten,
 * Terminal-Ausgabe). Ersetzt werden bekannte Token-Formate sowie alle konfigurierten Geheimwerte.
 */

export const REDACTED = '[entfernt]';

/** Muster bekannter Token-Formate. Gruppe 1 (falls vorhanden) bleibt erhalten (z. B. „Bearer “). */
const PATTERNS: RegExp[] = [
	// Anthropic vor allgemeinem `sk-`
	/sk-ant-[A-Za-z0-9_-]{8,}/g,
	// OpenAI u. a. (`sk-…`, `sk-proj-…`)
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	// GitHub (klassisch, OAuth, App, Refresh) und fine-grained PAT
	/\bgh[opsur]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	// Google API-Keys
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	// Slack
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	// AWS Access Key IDs
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	// AWS Secret Keys in Zuweisungen
	/((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{30,}/g,
	// Authorization-Header
	/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
	// Zugangsdaten in URLs (https://user:token@host)
	/(\bhttps?:\/\/[^\s:@/]+:)[^\s@/]{4,}(?=@)/g
];

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
	private secrets: RegExp | null;

	/** `secrets`: zusätzliche Klartextwerte (API-Key des Runners, Werte aus `account.env`, …) */
	constructor(secrets: Iterable<string> = []) {
		const list = [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length >= 6))].sort(
			(a, b) => b.length - a.length
		);
		this.secrets = list.length ? new RegExp(list.map(escapeRegExp).join('|'), 'g') : null;
	}

	redact(text: string): string {
		if (!text) return text;
		let out = text;
		if (this.secrets) out = out.replace(this.secrets, REDACTED);
		for (const re of PATTERNS) {
			out = out.replace(re, (match: string, keep?: unknown) =>
				typeof keep === 'string' && match.startsWith(keep) ? keep + REDACTED : REDACTED
			);
		}
		return out;
	}

	/** Alle Zeichenketten in einem JSON-artigen Wert ersetzen (Schlüssel bleiben) */
	redactDeep<T>(value: T): T {
		return this.walk(value, 0) as T;
	}

	private walk(value: unknown, depth: number): unknown {
		if (typeof value === 'string') return this.redact(value);
		if (depth > 40 || value === null || typeof value !== 'object') return value;
		if (Array.isArray(value)) return value.map((v) => this.walk(v, depth + 1));
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, depth + 1);
		return out;
	}
}
