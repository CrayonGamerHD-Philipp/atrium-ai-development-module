import { describe, expect, it } from 'vitest';
import {
	claudeRateLimitWindows,
	claudeUsageWindows,
	codexRateLimitWindows,
	codexWindow,
	findCodexRateLimits,
	LimitStore,
	limitHitWindow,
	toIso
} from '../src/providers/limit-snapshot.ts';
import { limitSnapshotSchema, limitWindowSchema } from '../src/protocol.ts';

const now = new Date('2026-11-24T10:00:00.000Z');
const reset = new Date(1795566600 * 1000).toISOString();

describe('toIso', () => {
	it('liest Sekunden, Millisekunden und ISO', () => {
		expect(toIso(1795566600)).toBe(reset);
		expect(toIso(1795566600000)).toBe(reset);
		expect(toIso('1795566600')).toBe(reset);
		expect(toIso('2026-11-25T18:00:00Z')).toBe('2026-11-25T18:00:00.000Z');
	});

	it('liefert null bei Unsinn', () => {
		expect(toIso(0)).toBeNull();
		expect(toIso(-5)).toBeNull();
		expect(toIso(Number.NaN)).toBeNull();
		expect(toIso('morgen')).toBeNull();
		expect(toIso({})).toBeNull();
	});
});

describe('claudeRateLimitWindows', () => {
	it.each([
		['five_hour', '5h'],
		['seven_day', 'week'],
		['seven_day_opus', 'week-opus'],
		['seven_day_sonnet', 'week-sonnet'],
		['overage', 'other'],
		['etwas_neues', 'other']
	] as const)('%s → %s', (type, window) => {
		expect(claudeRateLimitWindows({ status: 'allowed', rateLimitType: type })?.[0]?.window).toBe(window);
	});

	it('rechnet Auslastung in Prozent, Rücksetzzeit in ISO und bildet den Status ab', () => {
		expect(
			claudeRateLimitWindows({
				status: 'allowed_warning',
				rateLimitType: 'seven_day_sonnet',
				resetsAt: 1795566600,
				utilization: 0.85,
				surpassedThreshold: 0.75
			})
		).toEqual([{ window: 'week-sonnet', label: 'seven_day_sonnet', usedPercent: 85, resetsAt: reset, status: 'warning' }]);
		expect(claudeRateLimitWindows({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1795566600000 })).toEqual([
			{ window: '5h', label: 'five_hour', usedPercent: null, resetsAt: reset, status: 'rejected' }
		]);
		expect(claudeRateLimitWindows({ status: 'allowed', rateLimitType: 'five_hour' })?.[0]?.status).toBe('allowed');
		expect(claudeRateLimitWindows({ status: 'seltsam', rateLimitType: 'five_hour' })?.[0]?.status).toBe('unknown');
	});

	it('ergänzt Fenster aus unifiedWindows', () => {
		const w = claudeRateLimitWindows({
			status: 'allowed',
			rateLimitType: 'seven_day',
			unifiedWindows: { seven_day: { utilization: 0.52 }, seven_day_opus: { utilization: 0.1, status: 'allowed' }, kaputt: 5 }
		});
		expect(w).toEqual([
			{ window: 'week', label: 'seven_day', usedPercent: 52, resetsAt: null, status: 'allowed' },
			{ window: 'week-opus', label: 'seven_day_opus', usedPercent: 10, resetsAt: null, status: 'allowed' }
		]);
		for (const x of w ?? []) expect(limitWindowSchema.parse(x)).toEqual(x);
	});

	it('liefert null bei unbekannter oder kaputter Eingabe und wirft nie', () => {
		expect(claudeRateLimitWindows(null)).toBeNull();
		expect(claudeRateLimitWindows('rejected')).toBeNull();
		expect(claudeRateLimitWindows([])).toBeNull();
		expect(claudeRateLimitWindows({})).toBeNull();
		const evil = Object.defineProperty({}, 'status', {
			get() {
				throw new Error('böse');
			},
			enumerable: true
		});
		expect(claudeRateLimitWindows(evil)).toBeNull();
	});
});

describe('claudeUsageWindows (OAuth-Abfrage)', () => {
	it('übernimmt Prozentwerte und überspringt leere Fenster', () => {
		const w = claudeUsageWindows({
			five_hour: { utilization: 37.0, resets_at: '2026-11-25T18:00:00Z' },
			seven_day: { utilization: 100, resets_at: '2026-11-29T00:00:00Z' },
			seven_day_sonnet: null,
			seven_day_opus: { utilization: null, resets_at: null },
			extra_usage: { is_enabled: false }
		});
		expect(w).toEqual([
			{ window: '5h', label: 'five_hour', usedPercent: 37, resetsAt: '2026-11-25T18:00:00.000Z', status: 'allowed' },
			{ window: 'week', label: 'seven_day', usedPercent: 100, resetsAt: '2026-11-29T00:00:00.000Z', status: 'rejected' }
		]);
	});

	it('liefert null ohne bekannte Fenster', () => {
		expect(claudeUsageWindows({})).toBeNull();
		expect(claudeUsageWindows('nichts')).toBeNull();
		expect(claudeUsageWindows({ five_hour: null })).toBeNull();
	});
});

describe('codexRateLimitWindows', () => {
	it('ordnet Fenster nach Dauer zu', () => {
		expect(codexWindow(300)).toBe('5h');
		expect(codexWindow(299)).toBe('5h');
		expect(codexWindow(10080)).toBe('week');
		expect(codexWindow(1440)).toBe('other');
		expect(codexWindow(undefined)).toBe('other');
	});

	it('liest primary/secondary mit resets_in_seconds bzw. resets_at', () => {
		expect(
			codexRateLimitWindows(
				{
					primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 3600 },
					secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1795566600 }
				},
				now
			)
		).toEqual([
			{ window: '5h', label: 'primary', usedPercent: 12.5, resetsAt: '2026-11-24T11:00:00.000Z', status: 'allowed' },
			{ window: 'week', label: 'secondary', usedPercent: 100, resetsAt: reset, status: 'rejected' }
		]);
	});

	it('liefert null bei kaputter Eingabe', () => {
		expect(codexRateLimitWindows(null, now)).toBeNull();
		expect(codexRateLimitWindows({ primary: 'x', secondary: null }, now)).toBeNull();
		expect(codexRateLimitWindows({ primary: { window_minutes: 300 } }, now)).toBeNull();
	});

	it('findet rate_limits in verschachtelten Formen', () => {
		const rl = { primary: { used_percent: 1 } };
		expect(findCodexRateLimits({ rate_limits: rl })).toBe(rl);
		expect(findCodexRateLimits({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } })).toBe(rl);
		expect(findCodexRateLimits({ msg: { info: { rate_limits: rl } } })).toBe(rl);
		expect(findCodexRateLimits({ type: 'turn.completed' })).toBeUndefined();
	});
});

describe('limitHitWindow', () => {
	it('bildet nur 5h und week ab', () => {
		expect(limitHitWindow('5h', reset)).toEqual({ window: '5h', label: '5h', usedPercent: null, resetsAt: reset, status: 'rejected' });
		expect(limitHitWindow('week', null)?.window).toBe('week');
		expect(limitHitWindow('rate', null)).toBeNull();
		expect(limitHitWindow('auth', null)).toBeNull();
	});
});

describe('LimitStore', () => {
	const t = (min: number) => new Date(now.getTime() + min * 60_000);
	const w = (window: '5h' | 'week' | 'other', usedPercent: number | null, label: string = window) => ({
		window,
		label,
		usedPercent,
		resetsAt: '2026-11-24T15:00:00.000Z',
		status: 'allowed' as const
	});

	it('führt Fenster je Konto nach observedAt zusammen', () => {
		const s = new LimitStore();
		expect(s.snapshot('a')).toBeNull();
		s.update('a', [w('5h', 10)], 'stream', t(0));
		s.update('a', [w('week', 30)], 'probe', t(5));
		// ältere Beobachtung überschreibt nicht
		s.update('a', [w('5h', 99)], 'probe', t(-1));
		s.update('b', [w('5h', 70)], 'stream', t(1));
		const snap = s.snapshot('a');
		expect(snap).toEqual({
			observedAt: t(5).toISOString(),
			source: 'probe',
			// älteres Fenster trägt seine eigene Beobachtungszeit
			windows: [{ ...w('5h', 10), observedAt: t(0).toISOString() }, w('week', 30)]
		});
		expect(limitSnapshotSchema.parse(snap)).toEqual(snap);
		expect(s.snapshot('b')?.windows).toEqual([w('5h', 70)]);
		expect(s.lastObserved('a', 'stream')).toBe(t(0).getTime());
		expect(s.lastObserved('a')).toBe(t(5).getTime());
		expect(s.lastObserved('x')).toBeNull();
	});

	it('behält die Auslastung bei Treffern ohne Prozentwert und trennt other nach Bezeichnung', () => {
		const s = new LimitStore();
		s.update('a', [w('5h', 95)], 'stream', t(0));
		s.update('a', [{ ...w('5h', null), status: 'rejected' }], 'error', t(1));
		s.update('a', [w('other', 5, 'primary'), w('other', 6, 'secondary')], 'stream', t(2));
		const snap = s.snapshot('a');
		expect(snap?.windows[0]).toMatchObject({ window: '5h', usedPercent: 95, status: 'rejected' });
		expect(snap?.windows.filter((x) => x.window === 'other')).toHaveLength(2);
	});

	it('überträgt die Beobachtungszeit je Fenster, damit alte Fenster nicht durch neue frisch wirken', () => {
		const s = new LimitStore();
		s.update('a', [w('5h', 10), w('week', 90)], 'probe', t(0));
		// der Stream meldet danach nur noch das 5h-Fenster
		s.update('a', [w('5h', 20)], 'stream', t(60));
		s.update('a', [w('5h', 30)], 'stream', t(120));
		const snap = s.snapshot('a');
		expect(snap?.observedAt).toBe(t(120).toISOString());
		expect(snap?.windows).toEqual([w('5h', 30), { ...w('week', 90), observedAt: t(0).toISOString() }]);
		expect(limitSnapshotSchema.parse(snap)).toEqual(snap);
	});

	it('hält höchstens 10 Fenster', () => {
		const s = new LimitStore();
		for (let i = 0; i < 15; i++) s.update('a', [w('other', i, `f${i}`)], 'stream', t(i));
		const snap = s.snapshot('a');
		expect(snap?.windows).toHaveLength(10);
		expect(limitSnapshotSchema.safeParse(snap).success).toBe(true);
	});
});
