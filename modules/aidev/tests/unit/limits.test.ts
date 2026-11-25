import { describe, it, expect } from 'vitest';
import {
	LIMIT_STALE_MS,
	analyzeLimits,
	forecastExhaustion,
	isStale,
	isWindowStale,
	median,
	parseSnapshot,
	rejectedUntil,
	reportedUtil,
	suggestBudget,
	type LimitSample
} from '../../limits';
import { WEEK_MS, type AccountState } from '../../scheduler';
import type { LimitSnapshot, LimitWindow } from '../../protocol';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

function state(over: Partial<AccountState> = {}): AccountState {
	return {
		id: 'acc-a',
		runnerId: 'runner-1',
		provider: 'claude',
		enabled: true,
		loggedIn: true,
		runnerOnline: true,
		runnerFreeSlots: 4,
		running: 0,
		maxConcurrency: 2,
		cooldownUntil: null,
		budget5h: 0,
		budgetWeek: 0,
		used5h: 0,
		usedWeek: 0,
		weekStart: NOW - WEEK_MS / 2,
		contextK: 200,
		defaultModel: '',
		...over
	};
}

function win(over: Partial<LimitWindow> = {}): LimitWindow {
	return {
		window: '5h',
		label: '',
		usedPercent: 40,
		resetsAt: iso(NOW + 2 * HOUR),
		status: 'allowed',
		...over
	};
}

function snap(windows: LimitWindow[], observedAt = NOW - MIN): LimitSnapshot {
	return { observedAt: iso(observedAt), source: 'stream', windows };
}

function sample(over: Partial<LimitSample> = {}): LimitSample {
	return {
		window: '5h',
		ts: NOW - HOUR,
		usedPercent: 20,
		resetsAt: NOW + 2 * HOUR,
		unitsInWindow: 0,
		...over
	};
}

describe('isStale / parseSnapshot', () => {
	it('älter als 30 Minuten gilt als veraltet', () => {
		expect(isStale(snap([], NOW - LIMIT_STALE_MS), NOW)).toBe(false);
		expect(isStale(snap([], NOW - LIMIT_STALE_MS - 1), NOW)).toBe(true);
	});

	it('prüft gespeicherte Werte (Objekt, Text, ungültig)', () => {
		const s = snap([win()]);
		expect(parseSnapshot(s)).toEqual(s);
		expect(parseSnapshot(JSON.stringify(s))).toEqual(s);
		expect(parseSnapshot(null)).toBeNull();
		expect(parseSnapshot('{kaputt')).toBeNull();
		expect(parseSnapshot({ observedAt: 'gestern', source: 'stream', windows: [] })).toBeNull();
	});
});

describe('median / suggestBudget', () => {
	it('Median gerader und ungerader Länge', () => {
		expect(median([])).toBeNull();
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	it('Einheiten / (Prozent/100), Median, gerundet, erst ab 10 %', () => {
		const samples = [
			sample({ usedPercent: 50, unitsInWindow: 1000 }), // 2000
			sample({ usedPercent: 25, unitsInWindow: 600 }), // 2400
			sample({ usedPercent: 30, unitsInWindow: 700 }), // 2333.3
			sample({ usedPercent: 5, unitsInWindow: 10 }), // < 10 % → ignoriert
			sample({ usedPercent: null, unitsInWindow: 10 }),
			sample({ usedPercent: 40, unitsInWindow: 0 }), // ohne Verbrauch → ignoriert
			sample({ window: 'week', usedPercent: 10, unitsInWindow: 5000 })
		];
		expect(suggestBudget(samples, '5h')).toBe(2333);
		expect(suggestBudget(samples, 'week')).toBe(50000);
		expect(suggestBudget([sample({ usedPercent: 9.9, unitsInWindow: 100 })], '5h')).toBeNull();
	});
});

describe('forecastExhaustion', () => {
	const reset = NOW + 10 * HOUR;

	it('linear fortgeschrieben bei steigender Nutzung', () => {
		// 10 % pro Stunde, zuletzt 60 % → 100 % in 4 Stunden
		const at = forecastExhaustion(
			[
				{ ts: NOW - 2 * HOUR, usedPercent: 40 },
				{ ts: NOW - HOUR, usedPercent: 50 },
				{ ts: NOW, usedPercent: 60 }
			],
			reset
		);
		expect(at).toBe(NOW + 4 * HOUR);
	});

	it('null bei fallender/gleicher Nutzung, zu wenigen Punkten, ohne Reset oder nach dem Reset', () => {
		const flat = [
			{ ts: NOW - HOUR, usedPercent: 50 },
			{ ts: NOW, usedPercent: 50 }
		];
		expect(forecastExhaustion(flat, reset)).toBeNull();
		expect(
			forecastExhaustion(
				[
					{ ts: NOW - HOUR, usedPercent: 60 },
					{ ts: NOW, usedPercent: 50 }
				],
				reset
			)
		).toBeNull();
		expect(forecastExhaustion([{ ts: NOW, usedPercent: 50 }], reset)).toBeNull();
		const rising = [
			{ ts: NOW - HOUR, usedPercent: 10 },
			{ ts: NOW, usedPercent: 11 }
		];
		expect(forecastExhaustion(rising, null)).toBeNull();
		// 1 %/h → 100 % erst nach 89 h, Reset schon in 10 h
		expect(forecastExhaustion(rising, reset)).toBeNull();
	});

	it('bereits erschöpft → Zeitpunkt des jüngsten Punkts', () => {
		expect(
			forecastExhaustion(
				[
					{ ts: NOW - HOUR, usedPercent: 90 },
					{ ts: NOW, usedPercent: 101 }
				],
				reset
			)
		).toBe(NOW);
	});

	it('bereits erschöpft auch mit nur einem Punkt oder ohne Anstieg', () => {
		expect(forecastExhaustion([{ ts: NOW, usedPercent: 100 }], reset)).toBe(NOW);
		expect(
			forecastExhaustion(
				[
					{ ts: NOW - HOUR, usedPercent: 100 },
					{ ts: NOW, usedPercent: 100 }
				],
				reset
			)
		).toBe(NOW);
		// erschöpft, aber Reset bereits vorbei → keine Aussage
		expect(forecastExhaustion([{ ts: NOW, usedPercent: 100 }], NOW)).toBeNull();
	});
});

describe('analyzeLimits', () => {
	it('Schätzung nur für 5h/week mit bekanntem Budget, Prognose aus Proben der aktuellen Periode', () => {
		const reset = NOW + 3 * HOUR;
		const s = snap(
			[
				win({ window: '5h', usedPercent: 60, resetsAt: iso(reset) }),
				win({ window: 'week', usedPercent: 30, resetsAt: iso(NOW + 3 * 24 * HOUR) }),
				win({ window: 'week-opus', usedPercent: 10, resetsAt: null })
			],
			NOW
		);
		const samples = [
			sample({ ts: NOW - 2 * HOUR, usedPercent: 40, resetsAt: reset, unitsInWindow: 400 }),
			sample({ ts: NOW - HOUR, usedPercent: 50, resetsAt: reset + MIN, unitsInWindow: 500 }),
			// frühere Periode: zählt nicht für die Prognose (aber für den Budgetvorschlag)
			sample({ ts: NOW - 6 * HOUR, usedPercent: 99, resetsAt: NOW - HOUR, unitsInWindow: 990 })
		];
		const dto = analyzeLimits(
			s,
			state({ budget5h: 1000, used5h: 700, budgetWeek: 0 }),
			samples,
			NOW
		);
		expect(dto).toMatchObject({
			observedAt: iso(NOW),
			source: 'stream',
			stale: false,
			suggestedBudget5hUnits: 1000,
			suggestedBudgetWeekUnits: null
		});
		const [h5, week, opus] = dto.windows;
		expect(h5).toMatchObject({ window: '5h', usedPercent: 60, estimatedUtil: 0.7 });
		// 10 %/h ab 60 % → 100 % nach 4 h, Reset schon nach 3 h → keine Erschöpfung
		expect(h5!.exhaustsAt).toBeNull();
		expect(week).toMatchObject({ window: 'week', estimatedUtil: null, exhaustsAt: null });
		expect(opus).toMatchObject({ window: 'week-opus', estimatedUtil: null, exhaustsAt: null });
	});

	it('Prognose vor dem Reset, veraltete Daten markiert', () => {
		const reset = NOW + 5 * HOUR;
		const s = snap([win({ usedPercent: 60, resetsAt: iso(reset) })], NOW - 40 * MIN);
		const dto = analyzeLimits(
			s,
			state(),
			[sample({ ts: NOW - 40 * MIN - 2 * HOUR, usedPercent: 20, resetsAt: reset })],
			NOW
		);
		expect(dto.stale).toBe(true);
		// 20 %/h ab 60 % → +2 h
		expect(dto.windows[0]!.exhaustsAt).toBe(iso(NOW - 40 * MIN + 2 * HOUR));
		expect(dto.windows[0]!.estimatedUtil).toBeNull();
	});

	it('Fenster mit eigener, älterer Beobachtungszeit einzeln als veraltet markiert', () => {
		const s = snap(
			[
				win(),
				win({ window: 'week', resetsAt: iso(NOW + 24 * HOUR), observedAt: iso(NOW - 3 * HOUR) })
			],
			NOW
		);
		const dto = analyzeLimits(s, state(), [], NOW);
		expect(dto.stale).toBe(false);
		expect(dto.windows.map((w) => w.stale)).toEqual([false, true]);
	});
});

describe('isWindowStale', () => {
	it('eigene Zeit, höchstens die des Schnappschusses; sonst die des Schnappschusses', () => {
		const s = snap([], NOW - MIN);
		expect(isWindowStale(win(), s, NOW)).toBe(false);
		expect(isWindowStale(win({ observedAt: iso(NOW - 31 * MIN) }), s, NOW)).toBe(true);
		// eigene Zeit nach dem Schnappschuss zählt nicht
		expect(isWindowStale(win({ observedAt: iso(NOW) }), snap([], NOW - 31 * MIN), NOW)).toBe(true);
	});
});

describe('reportedUtil / rejectedUntil', () => {
	it('5h und Maximum der Wochenfenster, nur aktuell und mit künftigem Reset', () => {
		const s = snap([
			win({ window: '5h', usedPercent: 42 }),
			win({ window: 'week', usedPercent: 30, resetsAt: iso(NOW + 24 * HOUR) }),
			win({ window: 'week-sonnet', usedPercent: 85, resetsAt: iso(NOW + 24 * HOUR) }),
			win({ window: 'week-opus', usedPercent: 99, resetsAt: iso(NOW - MIN) }), // abgelaufen
			win({ window: 'other', usedPercent: 100 })
		]);
		expect(reportedUtil(s, NOW)).toEqual({ u5h: 0.42, uWeek: 0.85 });
		expect(reportedUtil(snap([win({ resetsAt: null })]), NOW)).toEqual({ u5h: null, uWeek: null });
		expect(reportedUtil(snap([win()], NOW - 31 * MIN), NOW)).toEqual({ u5h: null, uWeek: null });
		expect(reportedUtil(null, NOW)).toEqual({ u5h: null, uWeek: null });
	});

	it('veraltete Einzelfenster bleiben unberücksichtigt', () => {
		const s = snap([
			win({ window: '5h', usedPercent: 42 }),
			win({
				window: 'week',
				usedPercent: 95,
				resetsAt: iso(NOW + 24 * HOUR),
				observedAt: iso(NOW - 2 * HOUR)
			})
		]);
		expect(reportedUtil(s, NOW)).toEqual({ u5h: 0.42, uWeek: null });
	});

	it('abgelehntes Fenster mit künftigem Reset wirkt wie eine Wartezeit', () => {
		const later = NOW + 5 * HOUR;
		expect(
			rejectedUntil(
				snap([
					win({ status: 'rejected', resetsAt: iso(NOW + HOUR) }),
					win({ window: 'week', status: 'rejected', resetsAt: iso(later) }),
					win({ window: 'other', status: 'rejected', resetsAt: iso(NOW + 9 * HOUR) })
				]),
				NOW
			)
		).toBe(later);
		expect(
			rejectedUntil(snap([win({ status: 'rejected', resetsAt: iso(NOW - 1) })]), NOW)
		).toBeNull();
		expect(rejectedUntil(snap([win({ status: 'warning' })]), NOW)).toBeNull();
		expect(rejectedUntil(null, NOW)).toBeNull();
	});

	it('veraltete Ablehnung sperrt nicht bis zum künftigen Reset', () => {
		const week = win({ window: 'week', status: 'rejected', resetsAt: iso(NOW + 3 * 24 * HOUR) });
		// gesamter Stand veraltet (vor zwei Tagen gemeldet)
		expect(rejectedUntil(snap([week], NOW - 2 * 24 * HOUR), NOW)).toBeNull();
		// nur das Wochenfenster veraltet, das 5h-Fenster aktuell
		expect(
			rejectedUntil(snap([win(), { ...week, observedAt: iso(NOW - 2 * 24 * HOUR) }]), NOW)
		).toBeNull();
	});
});
