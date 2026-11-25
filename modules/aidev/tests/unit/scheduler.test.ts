import { describe, it, expect } from 'vitest';
import {
	HARD_LIMIT_5H,
	HARD_LIMIT_WEEK,
	WEEK_MS,
	accountAvailable,
	limitUtilization,
	backoffMs,
	calibrateBudget,
	findCycle,
	planAssignments,
	scoreAccount,
	unitsOf,
	utilization,
	weekStartOf,
	type AccountState,
	type PlanInput,
	type ProjectState,
	type TaskCandidate
} from '../../scheduler';
import type { Routing } from '../../schemas';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0); // Mittwoch, 25.11.2026 12:00 UTC

function account(over: Partial<AccountState> = {}): AccountState {
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

function task(over: Partial<TaskCandidate> = {}): TaskCandidate {
	return {
		id: 't1',
		projectId: 'p1',
		role: 'implement',
		priority: 0,
		createdAt: 1000,
		requiredContextK: 0,
		providerHint: null,
		excludedAccountIds: [],
		sessionAccountId: null,
		estimatedUnits: 0,
		...over
	};
}

function project(over: Partial<ProjectState> = {}): ProjectState {
	return { id: 'p1', running: 0, maxParallel: 10, preferredRunnerId: null, ...over };
}

const ROUTING: Routing = {
	orchestrate: [{ provider: 'claude', weight: 8 }],
	research: [
		{ provider: 'codex', weight: 9 },
		{ provider: 'claude', weight: 3 }
	],
	implement: [
		{ provider: 'claude', weight: 9, model: 'opus' },
		{ provider: 'codex', weight: 7 },
		{ provider: 'gemini', weight: 0 }
	],
	review: [{ provider: 'gemini', weight: 8 }],
	fix: [{ provider: 'claude', weight: 8 }],
	resolve: []
};

function plan(over: Partial<PlanInput>): PlanInput {
	return { tasks: [], accounts: [], projects: [project()], routing: ROUTING, now: NOW, ...over };
}

describe('unitsOf', () => {
	it('summiert Tokens mit gewichtetem Cache-Lesen', () => {
		expect(
			unitsOf({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 20 })
		).toBe(270);
		expect(
			unitsOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 15, cacheWriteTokens: 0 })
		).toBe(2);
	});
	it('behandelt negative Werte und NaN als 0', () => {
		expect(
			unitsOf({ inputTokens: -5, outputTokens: NaN, cacheReadTokens: -100, cacheWriteTokens: 3 })
		).toBe(3);
	});
	it('liefert ganze Zahlen', () => {
		const u = unitsOf({
			inputTokens: 1.4,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0
		});
		expect(Number.isInteger(u)).toBe(true);
	});
});

describe('utilization', () => {
	it('Budget 0 ergibt 0', () => {
		expect(utilization(account({ used5h: 500, usedWeek: 900 }))).toEqual({ u5h: 0, uWeek: 0 });
	});
	it('berechnet Anteile, auch über 1', () => {
		const u = utilization(account({ budget5h: 100, used5h: 50, budgetWeek: 100, usedWeek: 150 }));
		expect(u.u5h).toBe(0.5);
		expect(u.uWeek).toBe(1.5);
	});
	it('negativer Verbrauch wird auf 0 begrenzt', () => {
		expect(utilization(account({ budget5h: 100, used5h: -10 })).u5h).toBe(0);
	});
});

describe('accountAvailable', () => {
	it('verfügbares Konto', () => {
		expect(accountAvailable(account(), NOW)).toBe(true);
	});
	it.each([
		['deaktiviert', { enabled: false }],
		['abgemeldet', { loggedIn: false }],
		['Runner offline', { runnerOnline: false }],
		['keine freien Slots', { runnerFreeSlots: 0 }],
		['Parallelität ausgeschöpft', { running: 2, maxConcurrency: 2 }],
		['Cooldown läuft', { cooldownUntil: NOW + 1 }]
	] as [string, Partial<AccountState>][])('%s → nicht verfügbar', (_, over) => {
		expect(accountAvailable(account(over), NOW)).toBe(false);
	});
	it('Cooldown genau jetzt abgelaufen → verfügbar', () => {
		expect(accountAvailable(account({ cooldownUntil: NOW }), NOW)).toBe(true);
	});
	it('5-h-Auslastung exakt an der Grenze ist noch verfügbar, darüber nicht', () => {
		expect(accountAvailable(account({ budget5h: 100, used5h: HARD_LIMIT_5H * 100 }), NOW)).toBe(
			true
		);
		expect(accountAvailable(account({ budget5h: 100, used5h: 96 }), NOW)).toBe(false);
	});
	it('Wochengrenze 0.98', () => {
		expect(
			accountAvailable(account({ budgetWeek: 100, usedWeek: HARD_LIMIT_WEEK * 100 }), NOW)
		).toBe(true);
		expect(accountAvailable(account({ budgetWeek: 100, usedWeek: 99 }), NOW)).toBe(false);
	});
	it('unbekanntes Budget (0) ist nie ausgeschöpft', () => {
		expect(accountAvailable(account({ used5h: 1e9, usedWeek: 1e9 }), NOW)).toBe(true);
	});
});

describe('scoreAccount', () => {
	it('Grundformel ohne Budget', () => {
		const s = scoreAccount(task(), account(), ROUTING, NOW);
		expect(s).not.toBeNull();
		expect(s!.score).toBeCloseTo(0.9);
		expect(s!.model).toBe('opus');
	});
	it('berücksichtigt Auslastung, Tempo und laufende Läufe', () => {
		// halbe Woche verstrichen, Woche zu 20 % verbraucht → pace 0.3; 5 h zu 40 % → load 0.4
		const a = account({
			budget5h: 100,
			used5h: 40,
			budgetWeek: 100,
			usedWeek: 20,
			running: 1,
			maxConcurrency: 2
		});
		const s = scoreAccount(task(), a, ROUTING, NOW)!;
		expect(s.score).toBeCloseTo(0.9 * 0.6 + 0.5 * 0.3 - 0.3 * 0.5);
	});
	it('Tempo wird auf [−1, 1] begrenzt und nur mit Wochenbudget gewertet', () => {
		const a = account({ budgetWeek: 100, usedWeek: 0, weekStart: NOW });
		// verstrichen 0, uWeek 0 → pace 0
		expect(scoreAccount(task(), a, ROUTING, NOW)!.score).toBeCloseTo(0.9);
		const b = account({ budget5h: 100, used5h: 50 });
		expect(scoreAccount(task(), b, ROUTING, NOW)!.score).toBeCloseTo(0.45);
	});
	it('nicht verfügbar → null', () => {
		expect(scoreAccount(task(), account({ enabled: false }), ROUTING, NOW)).toBeNull();
	});
	it('ausgeschlossenes Konto → null', () => {
		expect(scoreAccount(task({ excludedAccountIds: ['acc-a'] }), account(), ROUTING, NOW)).toBe(
			null
		);
	});
	it('zu kleiner Kontext → null', () => {
		expect(scoreAccount(task({ requiredContextK: 300 }), account(), ROUTING, NOW)).toBeNull();
		expect(scoreAccount(task({ requiredContextK: 200 }), account(), ROUTING, NOW)).not.toBeNull();
	});
	it('Anbieter fehlt im Routing oder hat Gewicht 0 → null', () => {
		expect(scoreAccount(task(), account({ provider: 'openai-api' }), ROUTING, NOW)).toBeNull();
		expect(scoreAccount(task(), account({ provider: 'gemini' }), ROUTING, NOW)).toBeNull();
		expect(scoreAccount(task({ role: 'resolve' }), account(), ROUTING, NOW)).toBeNull();
	});
	it('providerHint: nur dieser Anbieter, Gewicht aus Routing bzw. 5', () => {
		expect(scoreAccount(task({ providerHint: 'codex' }), account(), ROUTING, NOW)).toBeNull();
		const codex = scoreAccount(
			task({ providerHint: 'codex' }),
			account({ provider: 'codex' }),
			ROUTING,
			NOW
		)!;
		expect(codex.score).toBeCloseTo(0.7);
		const api = scoreAccount(
			task({ providerHint: 'openai-api' }),
			account({ provider: 'openai-api', defaultModel: 'gpt-x' }),
			ROUTING,
			NOW
		)!;
		expect(api.score).toBeCloseTo(0.5);
		expect(api.model).toBe('gpt-x');
	});
	it('Sitzungsbonus und bevorzugter Runner', () => {
		const base = scoreAccount(task(), account(), ROUTING, NOW)!.score;
		const session = scoreAccount(task({ sessionAccountId: 'acc-a' }), account(), ROUTING, NOW)!;
		expect(session.score).toBeCloseTo(base + 0.25);
		const pref = scoreAccount(task(), account(), ROUTING, NOW, 'runner-1')!;
		expect(pref.score).toBeCloseTo(base + 0.1);
		expect(scoreAccount(task(), account(), ROUTING, NOW, 'runner-2')!.score).toBeCloseTo(base);
	});
	it('Modell: Routing, sonst Standardmodell, sonst null', () => {
		const codex = account({ provider: 'codex' });
		expect(scoreAccount(task(), codex, ROUTING, NOW)!.model).toBeNull();
		expect(scoreAccount(task(), { ...codex, defaultModel: 'gpt-5' }, ROUTING, NOW)!.model).toBe(
			'gpt-5'
		);
	});
});

describe('planAssignments', () => {
	it('verteilt mehrere Aufgaben über Vorbuchung auf verschiedene Konten', () => {
		const a = account({ id: 'acc-a', runnerId: 'r1', budget5h: 1000, budgetWeek: 10000 });
		const b = account({ id: 'acc-b', runnerId: 'r2', budget5h: 1000, budgetWeek: 10000 });
		const res = planAssignments(
			plan({
				accounts: [a, b],
				tasks: [
					task({ id: 't1', estimatedUnits: 400 }),
					task({ id: 't2', createdAt: 2000, estimatedUnits: 400 })
				]
			})
		);
		expect(res.map((r) => [r.taskId, r.accountId])).toEqual([
			['t1', 'acc-a'],
			['t2', 'acc-b']
		]);
		expect(res[0]!.model).toBe('opus');
		expect(res[0]!.runnerId).toBe('r1');
	});
	it('freie Runner-Slots gelten für alle Konten desselben Runners', () => {
		const a = account({ id: 'acc-a', runnerId: 'r1', runnerFreeSlots: 1 });
		const b = account({ id: 'acc-b', runnerId: 'r1', runnerFreeSlots: 1, provider: 'codex' });
		const res = planAssignments(
			plan({ accounts: [a, b], tasks: [task({ id: 't1' }), task({ id: 't2', createdAt: 2000 })] })
		);
		expect(res).toHaveLength(1);
		expect(res[0]!.accountId).toBe('acc-a');
	});
	it('Parallelität des Kontos wird mitgezählt', () => {
		const a = account({ id: 'acc-a', maxConcurrency: 1 });
		const res = planAssignments(
			plan({ accounts: [a], tasks: [task({ id: 't1' }), task({ id: 't2', createdAt: 2000 })] })
		);
		expect(res.map((r) => r.taskId)).toEqual(['t1']);
	});
	it('Projektgrenze zählt neue Zuteilungen mit', () => {
		const accounts = [
			account({ id: 'acc-a', runnerId: 'r1' }),
			account({ id: 'acc-b', runnerId: 'r2' }),
			account({ id: 'acc-c', runnerId: 'r3' })
		];
		const tasks = [
			task({ id: 't1' }),
			task({ id: 't2', createdAt: 2000 }),
			task({ id: 't3', createdAt: 3000 }),
			task({ id: 'x1', projectId: 'p2', createdAt: 4000 })
		];
		const res = planAssignments(
			plan({
				accounts,
				tasks,
				projects: [project({ running: 1, maxParallel: 2 }), project({ id: 'p2' })]
			})
		);
		expect(res.map((r) => r.taskId)).toEqual(['t1', 'x1']);
	});
	it('Projekt am Limit erhält nichts', () => {
		const res = planAssignments(
			plan({
				accounts: [account()],
				tasks: [task()],
				projects: [project({ running: 3, maxParallel: 3 })]
			})
		);
		expect(res).toEqual([]);
	});
	it('sortiert nach Priorität, dann Alter, dann id', () => {
		const a = account({ id: 'acc-a', maxConcurrency: 1 });
		const tasks = [
			task({ id: 'old', createdAt: 1 }),
			task({ id: 'prio', priority: 5, createdAt: 99 }),
			task({ id: 'b', createdAt: 1 })
		];
		expect(planAssignments(plan({ accounts: [a], tasks }))[0]!.taskId).toBe('prio');
		const tasks2 = [task({ id: 'b', createdAt: 1 }), task({ id: 'a', createdAt: 1 })];
		expect(planAssignments(plan({ accounts: [a], tasks: tasks2 }))[0]!.taskId).toBe('a');
	});
	it('Gleichstand: geringere Auslastung, dann id', () => {
		const a = account({ id: 'acc-z', runnerId: 'r1' });
		const b = account({ id: 'acc-y', runnerId: 'r2' });
		expect(planAssignments(plan({ accounts: [a, b], tasks: [task()] }))[0]!.accountId).toBe(
			'acc-y'
		);
	});
	it('Gewicht schlägt Auslastung nicht, wenn das Konto deutlich voller ist', () => {
		const claude = account({ id: 'acc-c', runnerId: 'r1', budget5h: 100, used5h: 90 });
		const codex = account({ id: 'acc-x', runnerId: 'r2', provider: 'codex', budget5h: 100 });
		expect(
			planAssignments(plan({ accounts: [claude, codex], tasks: [task()] }))[0]!.accountId
		).toBe('acc-x');
	});
	it('providerHint, excluded und Sitzungsbonus', () => {
		const claude = account({ id: 'acc-c', runnerId: 'r1' });
		const codex = account({ id: 'acc-x', runnerId: 'r2', provider: 'codex' });
		const accounts = [claude, codex];
		expect(
			planAssignments(plan({ accounts, tasks: [task({ providerHint: 'codex' })] }))[0]!.accountId
		).toBe('acc-x');
		expect(
			planAssignments(plan({ accounts, tasks: [task({ excludedAccountIds: ['acc-c'] })] }))[0]!
				.accountId
		).toBe('acc-x');
		expect(
			planAssignments(plan({ accounts, tasks: [task({ sessionAccountId: 'acc-x' })] }))[0]!
				.accountId
		).toBe('acc-x');
		expect(planAssignments(plan({ accounts, tasks: [task({ providerHint: 'gemini' })] }))).toEqual(
			[]
		);
	});
	it('bevorzugter Runner des Projekts gibt den Ausschlag', () => {
		const a = account({ id: 'acc-a', runnerId: 'r1' });
		const b = account({ id: 'acc-b', runnerId: 'r2' });
		const res = planAssignments(
			plan({ accounts: [a, b], tasks: [task()], projects: [project({ preferredRunnerId: 'r2' })] })
		);
		expect(res[0]!.accountId).toBe('acc-b');
	});
	it('Vorbuchung kann ein Konto über die harte Grenze bringen', () => {
		const a = account({ id: 'acc-a', budget5h: 1000, maxConcurrency: 5 });
		const res = planAssignments(
			plan({
				accounts: [a],
				tasks: [
					task({ id: 't1', estimatedUnits: 960 }),
					task({ id: 't2', createdAt: 2000, estimatedUnits: 10 })
				]
			})
		);
		expect(res.map((r) => r.taskId)).toEqual(['t1']);
	});
	it('verändert die Eingaben nicht und ist deterministisch', () => {
		const input = plan({
			accounts: [
				account({ id: 'acc-a', runnerId: 'r1', budget5h: 1000 }),
				account({ id: 'acc-b', runnerId: 'r2', provider: 'codex', budget5h: 1000 })
			],
			tasks: [
				task({ id: 't1', estimatedUnits: 100 }),
				task({ id: 't2', createdAt: 2000, estimatedUnits: 100 }),
				task({ id: 't3', createdAt: 3000, estimatedUnits: 100, role: 'research' })
			]
		});
		const snapshot = structuredClone(input);
		const r1 = planAssignments(input);
		expect(input).toEqual(snapshot);
		const r2 = planAssignments(structuredClone(snapshot));
		expect(r2).toEqual(r1);
		const reversed = { ...snapshot, tasks: [...snapshot.tasks].reverse() };
		expect(planAssignments(reversed)).toEqual(r1);
	});
});

describe('calibrateBudget', () => {
	it('ohne Vorwert übernimmt den Verbrauch', () => {
		expect(calibrateBudget(null, 1000)).toBe(1000);
		expect(calibrateBudget(0, 1000)).toBe(1000);
		expect(calibrateBudget(-5, 1000)).toBe(1000);
	});
	it('EWMA mit Rundung', () => {
		expect(calibrateBudget(1000, 2000)).toBe(1300);
		expect(calibrateBudget(1000, 2001, 0.5)).toBe(1501);
	});
	it('Verbrauch ≤ 0 behält den Vorwert', () => {
		expect(calibrateBudget(1234, 0)).toBe(1234);
		expect(calibrateBudget(null, -1)).toBe(0);
	});
});

describe('backoffMs', () => {
	const MIN = 60_000;
	it('15 → 30 → 60 → 120 min', () => {
		expect(backoffMs(0)).toBe(15 * MIN);
		expect(backoffMs(1)).toBe(30 * MIN);
		expect(backoffMs(2)).toBe(60 * MIN);
		expect(backoffMs(3)).toBe(120 * MIN);
		expect(backoffMs(10)).toBe(120 * MIN);
	});
	it('negative Werte wie 0', () => {
		expect(backoffMs(-1)).toBe(15 * MIN);
	});
});

describe('weekStartOf', () => {
	it('ohne Anker: Montag 00:00 UTC', () => {
		expect(weekStartOf(null, NOW)).toBe(Date.UTC(2026, 10, 23));
		// Montag genau 00:00 ist selbst der Beginn
		expect(weekStartOf(null, Date.UTC(2026, 10, 23))).toBe(Date.UTC(2026, 10, 23));
		// Sonntag 23:59 gehört zur Vorwoche
		expect(weekStartOf(null, Date.UTC(2026, 10, 29, 23, 59))).toBe(Date.UTC(2026, 10, 23));
	});
	it('Anker in der Vergangenheit', () => {
		const anchor = Date.UTC(2026, 0, 1, 9, 30);
		const ws = weekStartOf(anchor, NOW);
		expect(ws).toBeLessThanOrEqual(NOW);
		expect(NOW - ws).toBeLessThan(WEEK_MS);
		expect((ws - anchor) % WEEK_MS).toBe(0);
		expect(weekStartOf(anchor, anchor)).toBe(anchor);
	});
	it('Anker in der Zukunft wird nach hinten gerechnet', () => {
		const anchor = NOW + 3 * WEEK_MS + 1000;
		const ws = weekStartOf(anchor, NOW);
		expect(ws).toBe(anchor - 4 * WEEK_MS);
		expect(ws).toBeLessThanOrEqual(NOW);
		expect(NOW - ws).toBeLessThan(WEEK_MS);
	});
});

describe('findCycle', () => {
	it('kein Zyklus → null', () => {
		const g = new Map([
			['a', []],
			['b', ['a']],
			['c', ['a', 'b']]
		]);
		expect(findCycle(g)).toBeNull();
	});
	it('findet einen Zyklus', () => {
		const g = new Map([
			['a', ['b']],
			['b', ['a']]
		]);
		expect(findCycle(g)).toEqual(['a', 'b', 'a']);
	});
	it('längerer Zyklus hinter einem azyklischen Teil', () => {
		const g = new Map([
			['x', []],
			['a', ['x', 'b']],
			['b', ['c']],
			['c', ['a']]
		]);
		expect(findCycle(g)).toEqual(['a', 'b', 'c', 'a']);
	});
	it('Selbstbezug', () => {
		expect(findCycle(new Map([['a', ['a']]]))).toEqual(['a', 'a']);
	});
	it('unbekannte Vorgänger werden ignoriert', () => {
		expect(findCycle(new Map([['a', ['gibt-es-nicht']]]))).toBeNull();
	});
});

describe('gemeldete Limits', () => {
	it('Ausschluss nach max(Schätzung, Meldung)', () => {
		// eigene Schätzung 50 %, Meldung 97 % → ausgeschlossen
		const a = account({ budget5h: 100, used5h: 50, reported: { u5h: 0.97, uWeek: null } });
		expect(limitUtilization(a)).toEqual({ u5h: 0.97, uWeek: 0 });
		expect(accountAvailable(a, NOW)).toBe(false);
		// Meldung niedriger als Schätzung → Schätzung zählt
		const b = account({ budget5h: 100, used5h: 96, reported: { u5h: 0.2, uWeek: null } });
		expect(accountAvailable(b, NOW)).toBe(false);
		// Woche ohne bekanntes Budget, Meldung 99 %
		expect(accountAvailable(account({ reported: { u5h: null, uWeek: 0.99 } }), NOW)).toBe(false);
		expect(accountAvailable(account({ reported: { u5h: 0.5, uWeek: 0.9 } }), NOW)).toBe(true);
		// ohne Meldung (ältere Runner) unverändert
		expect(accountAvailable(account({ reported: { u5h: null, uWeek: null } }), NOW)).toBe(true);
	});

	it('abgelehntes Fenster wirkt wie eine Wartezeit', () => {
		expect(accountAvailable(account({ rejectedUntil: NOW + 1000 }), NOW)).toBe(false);
		expect(accountAvailable(account({ rejectedUntil: NOW }), NOW)).toBe(true);
		expect(accountAvailable(account({ rejectedUntil: null }), NOW)).toBe(true);
		const t = task();
		expect(scoreAccount(t, account({ rejectedUntil: NOW + 1000 }), ROUTING, NOW)).toBeNull();
	});
});
