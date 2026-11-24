import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from '../src/redact.ts';

describe('Redactor', () => {
	const r = new Redactor(['mein-geheimer-atrium-key-123', 'wert-aus-account-env']);

	it.each([
		['ghp_' + 'a'.repeat(36)],
		['gho_' + 'B1'.repeat(18)],
		['github_pat_11ABCDEFG0' + 'x'.repeat(60)],
		['sk-proj-' + 'Ab3'.repeat(20)],
		['sk-ant-api03-' + 'z'.repeat(40)],
		['AIza' + 'S'.repeat(35)],
		['xoxb-1234567890-abcdefghij'],
		['AKIAIOSFODNN7EXAMPLE']
	])('entfernt %s', (token) => {
		const out = r.redact(`Token: ${token} Ende`);
		expect(out).toBe(`Token: ${REDACTED} Ende`);
	});

	it('behält „Bearer “ und entfernt das Token', () => {
		expect(r.redact('Authorization: Bearer abc.def-ghi_jkl')).toBe(`Authorization: Bearer ${REDACTED}`);
	});

	it('entfernt AWS-Secret in Zuweisungen', () => {
		expect(r.redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(
			`aws_secret_access_key = ${REDACTED}`
		);
	});

	it('entfernt konfigurierte Geheimwerte und Zugangsdaten in URLs', () => {
		expect(r.redact('key=mein-geheimer-atrium-key-123;x=wert-aus-account-env')).toBe(`key=${REDACTED};x=${REDACTED}`);
		expect(r.redact('https://x-access-token:abcd1234@github.com/o/r.git')).toBe(
			`https://x-access-token:${REDACTED}@github.com/o/r.git`
		);
	});

	it('lässt normalen Text unverändert', () => {
		const t = 'Ich habe die Datei sk.ts und den Task-Branch aidev/ghp-fix geändert.';
		expect(r.redact(t)).toBe(t);
	});

	it('bereinigt verschachtelte Werte', () => {
		const out = r.redactDeep({ a: ['ghp_' + 'c'.repeat(36)], b: { c: 1, d: 'wert-aus-account-env' } });
		expect(out).toEqual({ a: [REDACTED], b: { c: 1, d: REDACTED } });
	});

	it('ignoriert zu kurze Geheimwerte (keine Zerstörung normaler Texte)', () => {
		const short = new Redactor(['abc']);
		expect(short.redact('abc abc')).toBe('abc abc');
	});
});
