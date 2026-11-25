import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageDto, TaskDto, TaskStatus } from '../../schemas';
import {
	activityFor,
	buildTimeline,
	dayLabel,
	GROUP_GAP_MS,
	localDayKey,
	sameGroup
} from '../../pages/project/chat/timeline';
import { CHAT_MODES, isChatMode, modeInfo, storage } from '../../pages/project/chat/modes';

/** Lokale Zeit → ISO (unabhängig von der Zeitzone der Testumgebung) */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
	new Date(y, mo - 1, d, h, mi).toISOString();

let seq = 0;
function msg(over: Partial<ChatMessageDto> = {}): ChatMessageDto {
	seq++;
	return {
		id: `m${seq}`,
		projectId: 'p1',
		taskId: null,
		kind: 'user',
		body: 'Hallo',
		author: { id: 'u1', name: 'Anna' },
		createdAt: at(2026, 11, 25),
		...over
	};
}

const task = (id: string, status: TaskStatus) => ({ id, status }) as unknown as TaskDto;

describe('localDayKey / dayLabel', () => {
	const now = new Date(2026, 10, 25, 15, 0);

	it('liefert den lokalen Kalendertag', () => {
		expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
	});

	it('„Heute“ und „Gestern“', () => {
		expect(dayLabel(at(2026, 11, 25, 0, 1), now)).toBe('Heute');
		expect(dayLabel(at(2026, 11, 24, 23, 59), now)).toBe('Gestern');
	});

	it('Gestern über den Monatswechsel', () => {
		expect(dayLabel(at(2026, 11, 30), new Date(2026, 11, 1, 9))).toBe('Gestern');
	});

	it('älter: Datum ohne Jahr, anderes Jahr mit Jahr', () => {
		expect(dayLabel(at(2026, 11, 20), now)).not.toMatch(/2026/);
		expect(dayLabel(at(2025, 11, 20), now)).toMatch(/2025/);
	});
});

describe('sameGroup', () => {
	it('gleicher Autor innerhalb von 5 Minuten', () => {
		const a = msg({ createdAt: at(2026, 11, 25, 10, 0) });
		const b = msg({ createdAt: at(2026, 11, 25, 10, 4) });
		expect(sameGroup(a, b)).toBe(true);
	});

	it('trennt nach Abstand, Autor, Art, System und Tageswechsel', () => {
		const a = msg({ createdAt: at(2026, 11, 25, 10, 0) });
		const late = msg({ createdAt: new Date(Date.parse(a.createdAt) + GROUP_GAP_MS).toISOString() });
		expect(sameGroup(a, late)).toBe(false);
		expect(sameGroup(a, msg({ ...a, id: 'x', author: { id: 'u2', name: 'Ben' } }))).toBe(false);
		expect(sameGroup(a, msg({ ...a, id: 'y', kind: 'agent', author: null }))).toBe(false);
		expect(sameGroup(a, msg({ ...a, id: 'z', kind: 'system', author: null }))).toBe(false);
		const night = msg({ createdAt: at(2026, 11, 24, 23, 58) });
		const morning = msg({ createdAt: at(2026, 11, 25, 0, 1) });
		expect(sameGroup(night, morning)).toBe(false);
	});

	it('Agent-Nachrichten ohne Autor bilden eine Gruppe', () => {
		const a = msg({ kind: 'agent', author: null, createdAt: at(2026, 11, 25, 10, 0) });
		const b = msg({ kind: 'agent', author: null, createdAt: at(2026, 11, 25, 10, 1) });
		expect(sameGroup(a, b)).toBe(true);
	});
});

describe('buildTimeline', () => {
	it('setzt first/last und Tagestrenner', () => {
		const now = new Date(2026, 10, 25, 15, 0);
		const list = [
			msg({ createdAt: at(2026, 11, 24, 10, 0) }),
			msg({ createdAt: at(2026, 11, 25, 10, 0) }),
			msg({ createdAt: at(2026, 11, 25, 10, 2) }),
			msg({ kind: 'agent', author: null, createdAt: at(2026, 11, 25, 10, 3) })
		];
		const t = buildTimeline(list, now);
		expect(t.map((i) => i.day)).toEqual(['Gestern', 'Heute', null, null]);
		expect(t.map((i) => [i.first, i.last])).toEqual([
			[true, true],
			[true, false],
			[false, true],
			[true, true]
		]);
	});

	it('leerer Verlauf', () => {
		expect(buildTimeline([])).toEqual([]);
	});
});

describe('activityFor', () => {
	it('ohne Auftrag oder im Endzustand → null', () => {
		expect(activityFor([], new Map())).toBeNull();
		expect(activityFor([msg()], new Map())).toBeNull();
		const m = msg({ taskId: 't1' });
		expect(activityFor([m], new Map([['t1', task('t1', 'done')]]))).toBeNull();
	});

	it('richtet sich nach der letzten Nutzernachricht', () => {
		const tasks = new Map([
			['t1', task('t1', 'running')],
			['t2', task('t2', 'queued')]
		]);
		const list = [
			msg({ taskId: 't1' }),
			msg({ taskId: 't2' }),
			msg({ kind: 'agent', author: null })
		];
		expect(activityFor(list, tasks)).toMatchObject({
			kind: 'working',
			label: 'Agent startet gleich'
		});
	});

	it('Rückfrage und Beschriftungen', () => {
		const run = (status: TaskStatus) =>
			activityFor([msg({ taskId: 't' })], new Map([['t', task('t', status)]]));
		expect(run('needs-input')).toMatchObject({ kind: 'needs-input' });
		expect(run('running')).toMatchObject({ label: 'Agent arbeitet' });
		expect(run('review')).toMatchObject({ label: 'Ergebnis wird geprüft' });
		expect(run('blocked')).toMatchObject({ label: 'Auftrag wartet auf Abhängigkeiten' });
		expect(run('draft')).toMatchObject({ label: 'Auftrag ist vorbereitet' });
	});
});

describe('Chat-Modi', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('isChatMode / modeInfo', () => {
		expect(CHAT_MODES.map((m) => m.value)).toEqual(['auto', 'task', 'question', 'note']);
		expect(isChatMode('note')).toBe(true);
		expect(isChatMode('orchestrate')).toBe(false);
		expect(isChatMode(null)).toBe(false);
		expect(modeInfo('question').label).toBe('Frage');
	});

	it('storage nutzt localStorage', () => {
		const data = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k)
		});
		storage.set('a', '1');
		expect(storage.get('a')).toBe('1');
		storage.remove('a');
		expect(storage.get('a')).toBeNull();
	});

	it('storage wirft nicht, wenn localStorage fehlt oder voll ist', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('gesperrt');
			},
			setItem: () => {
				throw new Error('voll');
			},
			removeItem: () => {
				throw new Error('gesperrt');
			}
		});
		expect(storage.get('a')).toBeNull();
		expect(() => storage.set('a', '1')).not.toThrow();
		expect(() => storage.remove('a')).not.toThrow();
	});
});
