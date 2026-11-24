import { describe, expect, it } from 'vitest';
import { detectLimit, parseResetTime } from '../src/providers/limits.ts';

const now = new Date('2026-11-24T10:00:00.000Z');

describe('parseResetTime', () => {
	it('liest Unix-Epoch (Sekunden und Millisekunden)', () => {
		expect(parseResetTime('Claude AI usage limit reached|1795566600', now)).toBe(new Date(1795566600 * 1000).toISOString());
		expect(parseResetTime('resetsAt: 1795566600000', now)).toBe(new Date(1795566600000).toISOString());
	});

	it('liest ISO-Zeitstempel', () => {
		expect(parseResetTime('limit, resets at 2026-11-25T08:00:00Z', now)).toBe('2026-11-25T08:00:00.000Z');
		expect(parseResetTime('until 2026-11-25T09:30:00+01:00', now)).toBe('2026-11-25T08:30:00.000Z');
	});

	it('liest relative Angaben', () => {
		expect(parseResetTime('try again in 2 hours 15 minutes', now)).toBe('2026-11-24T12:15:00.000Z');
		expect(parseResetTime('try again in 1h 30m.', now)).toBe('2026-11-24T11:30:00.000Z');
		expect(parseResetTime('Please retry in 41s.', now)).toBe('2026-11-24T10:00:41.000Z');
		expect(parseResetTime('resets in 3 days', now)).toBe('2026-11-27T10:00:00.000Z');
	});

	it('liest Uhrzeiten mit Zeitzone (heute bzw. morgen)', () => {
		// 3pm Berlin = 14:00 UTC (Winterzeit) → heute
		expect(parseResetTime("You've hit your limit · resets 3pm (Europe/Berlin)", now)).toBe('2026-11-24T14:00:00.000Z');
		// 9am UTC liegt vor 10:00 → morgen
		expect(parseResetTime('5-hour limit reached ∙ resets 9am (UTC)', now)).toBe('2026-11-25T09:00:00.000Z');
		expect(parseResetTime('try again at 3:05 PM (UTC)', now)).toBe('2026-11-24T15:05:00.000Z');
		expect(parseResetTime('Opus limit reached ∙ resets Nov 28, 5pm (UTC)', now)).toBe('2026-11-28T17:00:00.000Z');
	});

	it('liefert null ohne erkennbare Zeit', () => {
		expect(parseResetTime('usage limit reached', now)).toBeNull();
	});
});

describe('detectLimit', () => {
	it.each([
		// Rücksetzung in 2 h → 5-Stunden-Fenster, in 14,5 h → Wochenlimit
		['claude', 'Claude AI usage limit reached|1795521600', '5h'],
		['claude', 'Claude AI usage limit reached|1795566600', 'week'],
		['claude', '5-hour limit reached ∙ resets 3pm', '5h'],
		['claude', 'Weekly limit reached ∙ resets Nov 28, 5pm', 'week'],
		['claude', "You've hit your limit · resets 3pm (Europe/Berlin)", '5h'],
		['claude', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'rate'],
		['claude', 'Invalid API key · Please run /login', 'auth'],
		['codex', "You've hit your usage limit. Try again in 2 hours 15 minutes.", '5h'],
		['codex', "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again in 4 days.", 'week'],
		['codex', 'stream error: exceeded retry limit, last status: 429 Too Many Requests', 'rate'],
		['openai-api', 'insufficient_quota: You exceeded your current quota', 'other'],
		['gemini', '[API Error: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}] Please retry in 41s.', 'rate'],
		['gemini', 'Quota exceeded for quota metric requests per day', 'other']
	] as const)('%s: %s → %s', (provider, text, kind) => {
		expect(detectLimit(provider, text, now)?.kind).toBe(kind);
	});

	it.each([
		['claude', 'Ich habe das Rate-Limiting im Code ergänzt (rateLimit.ts).'],
		['codex', 'Tests: 429 passed'],
		['gemini', 'Alles erledigt.'],
		['claude', '']
	] as const)('kein Limit bei normaler Ausgabe: %s', (provider, text) => {
		expect(detectLimit(provider, text, now)).toBeNull();
	});

	it('liefert die Rücksetzzeit mit', () => {
		const d = detectLimit('claude', 'Claude AI usage limit reached|1795566600', now);
		expect(d?.resetsAt).toBe(new Date(1795566600 * 1000).toISOString());
	});
});
