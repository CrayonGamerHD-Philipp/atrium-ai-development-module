import { describe, expect, it } from 'vitest';
import type { ChatAction } from '../../actions';
import type { ChatActionDto, ChatMessageDto, TaskDto, TaskStatus } from '../../schemas';
import {
	actionPrompt,
	actionTaskId,
	canApply,
	canImplement,
	changedFields,
	pendingActions,
	replyLabel
} from '../../pages/project/chat/proposals';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

function msg(over: Partial<ChatMessageDto> = {}): ChatMessageDto {
	return {
		id: 'm1',
		projectId: 'p1',
		taskId: 't1',
		kind: 'agent',
		body: 'Man könnte einen Dark Mode einbauen.',
		author: null,
		createdAt: new Date(2026, 10, 25, 14, 5).toISOString(),
		actions: [],
		...over
	};
}

const task = (status: TaskStatus) => ({ id: 't1', status }) as unknown as TaskDto;

function dto(action: ChatAction, over: Partial<ChatActionDto> = {}): ChatActionDto {
	return {
		index: 0,
		action,
		state: 'pending',
		taskId: null,
		error: null,
		decidedBy: null,
		decidedAt: null,
		...over
	};
}

const create: ChatAction = {
	type: 'create',
	title: 'Dark Mode',
	prompt: 'Baue einen Dark Mode.',
	role: 'implement',
	decompose: false,
	providerHint: null,
	targetPr: null
};

describe('canImplement', () => {
	it('Agent-Antwort eines erledigten Auftrags', () => {
		expect(canImplement(msg(), task('done'))).toBe(true);
		expect(canImplement(msg(), task('review'))).toBe(true);
	});

	it('unbekannter Auftrag gilt als beantwortet', () => {
		expect(canImplement(msg(), undefined)).toBe(true);
	});

	it('nicht bei Fehler, Abbruch, Rückfrage oder laufendem Auftrag', () => {
		for (const s of ['failed', 'cancelled', 'needs-input', 'running', 'queued'] as const)
			expect(canImplement(msg(), task(s))).toBe(false);
	});

	it('nur Agent-Nachrichten mit Auftrag und Text', () => {
		expect(canImplement(msg({ kind: 'user' }), task('done'))).toBe(false);
		expect(canImplement(msg({ kind: 'system' }), task('done'))).toBe(false);
		expect(canImplement(msg({ taskId: null }), undefined)).toBe(false);
		expect(canImplement(msg({ body: '  ' }), task('done'))).toBe(false);
	});
});

describe('pendingActions / actionTaskId', () => {
	it('zählt nur offene Vorschläge', () => {
		const list = [
			dto(create),
			dto(create, { index: 1, state: 'applied', taskId: TASK_ID }),
			dto(create, { index: 2, state: 'rejected' }),
			dto(create, { index: 3 })
		];
		expect(pendingActions(list).map((a) => a.index)).toEqual([0, 3]);
		expect(pendingActions([])).toEqual([]);
	});

	it('angelegter Auftrag nach dem Übernehmen, sonst der betroffene', () => {
		expect(actionTaskId(dto(create))).toBeNull();
		expect(actionTaskId(dto(create, { state: 'applied', taskId: TASK_ID }))).toBe(TASK_ID);
		expect(actionTaskId(dto({ type: 'cancel', taskId: TASK_ID }))).toBe(TASK_ID);
		expect(actionTaskId(dto({ type: 'update', taskId: TASK_ID, priority: 2 }))).toBe(TASK_ID);
	});
});

describe('changedFields / actionPrompt', () => {
	it('geänderte Felder nur bei `update`', () => {
		expect(
			changedFields({ type: 'update', taskId: TASK_ID, title: 'Neu', providerHint: null })
		).toEqual(['Titel', 'Anbieter']);
		expect(changedFields(create)).toEqual([]);
	});

	it('Text bei `create` und geändertem Text, nicht bei `cancel`', () => {
		expect(actionPrompt(create)).toBe('Baue einen Dark Mode.');
		expect(actionPrompt({ type: 'update', taskId: TASK_ID, priority: 1 })).toBeNull();
		expect(actionPrompt({ type: 'update', taskId: TASK_ID, prompt: 'Neu' })).toBe('Neu');
		expect(actionPrompt({ type: 'cancel', taskId: TASK_ID })).toBeNull();
	});
});

describe('replyLabel', () => {
	it('Uhrzeit der Antwort', () => {
		expect(replyLabel(msg())).toBe('Antwort von 14:05');
	});
});

describe('canApply', () => {
	const own = { id: TASK_ID, createdBy: 'u1' } as unknown as TaskDto;
	const foreign = { id: TASK_ID, createdBy: 'u2' } as unknown as TaskDto;
	const cancel: ChatAction = { type: 'cancel', taskId: TASK_ID };
	const creator = { canCreate: true, canManage: false, userId: 'u1' };

	it('neue Aufträge mit task.create', () => {
		expect(canApply(create, undefined, creator)).toBe(true);
		expect(canApply(create, undefined, { ...creator, canCreate: false })).toBe(false);
	});

	it('eigene Aufträge ändern/abbrechen, fremde nur mit task.manage', () => {
		expect(canApply(cancel, own, creator)).toBe(true);
		expect(canApply(cancel, foreign, creator)).toBe(false);
		expect(canApply(cancel, foreign, { ...creator, canManage: true })).toBe(true);
		expect(canApply(cancel, own, { ...creator, userId: null })).toBe(false);
	});

	it('unbekannter Auftrag bleibt entscheidbar, ohne Rechte nie', () => {
		expect(canApply(cancel, undefined, creator)).toBe(true);
		expect(canApply(cancel, undefined, { canCreate: false, canManage: false, userId: 'u1' })).toBe(
			false
		);
	});
});
