import { describe, it, expect } from 'vitest';
import {
	CHAT_ACTIONS_LANG,
	MAX_CHAT_ACTIONS,
	chatActionSchema,
	chatActionsBlockSchema,
	describeChatAction,
	extractChatActions,
	storedActionsOf,
	type ChatAction
} from '../../actions';

const ID = '3f1c2b4a-8d9e-4f6a-b1c2-d3e4f5a6b7c8';
const ID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const block = (json: unknown, fence = '```') =>
	`${fence}${CHAT_ACTIONS_LANG}\n${typeof json === 'string' ? json : JSON.stringify(json, null, 2)}\n${fence}`;

describe('chatActionSchema', () => {
	it('setzt Standardwerte für create', () => {
		const a = chatActionSchema.parse({ type: 'create', title: '  Dark Mode ', prompt: 'Baue ihn' });
		expect(a).toEqual({
			type: 'create',
			title: 'Dark Mode',
			prompt: 'Baue ihn',
			role: 'implement',
			decompose: false,
			providerHint: null,
			targetPr: null
		});
	});

	it('lehnt unzulässige Rollen, Anbieter und Längen ab', () => {
		const base = { type: 'create', title: 'T', prompt: 'P' };
		expect(chatActionSchema.safeParse({ ...base, role: 'orchestrate' }).success).toBe(false);
		expect(chatActionSchema.safeParse({ ...base, providerHint: 'foo' }).success).toBe(false);
		expect(chatActionSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
		expect(chatActionSchema.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
		expect(chatActionSchema.safeParse({ ...base, targetPr: 0 }).success).toBe(false);
	});

	it('verlangt bei update mindestens eine Änderung', () => {
		expect(chatActionSchema.safeParse({ type: 'update', taskId: ID }).success).toBe(false);
		expect(
			chatActionSchema.safeParse({ type: 'update', taskId: ID, reason: 'nur Grund' }).success
		).toBe(false);
		expect(chatActionSchema.safeParse({ type: 'update', taskId: ID, priority: 3 }).success).toBe(
			true
		);
		expect(
			chatActionSchema.safeParse({ type: 'update', taskId: ID, providerHint: null }).success
		).toBe(true);
		expect(chatActionSchema.safeParse({ type: 'update', taskId: ID, priority: 11 }).success).toBe(
			false
		);
		expect(
			chatActionSchema.safeParse({ type: 'update', taskId: 'kein-uuid', priority: 1 }).success
		).toBe(false);
	});

	it('begrenzt den Block auf MAX_CHAT_ACTIONS', () => {
		const one = { type: 'cancel', taskId: ID };
		expect(chatActionsBlockSchema.safeParse({ actions: [] }).success).toBe(false);
		expect(
			chatActionsBlockSchema.safeParse({ actions: Array(MAX_CHAT_ACTIONS).fill(one) }).success
		).toBe(true);
		expect(
			chatActionsBlockSchema.safeParse({ actions: Array(MAX_CHAT_ACTIONS + 1).fill(one) }).success
		).toBe(false);
	});
});

describe('extractChatActions', () => {
	it('liest einen gültigen Block mit allen drei Typen und entfernt ihn', () => {
		const text = [
			'Hier mein Vorschlag:',
			'',
			block({
				actions: [
					{ type: 'create', title: 'Dark Mode', prompt: 'Baue einen Dark Mode', role: 'fix' },
					{ type: 'update', taskId: ID, title: 'Neu', prompt: 'Neuer Text', reason: 'genauer' },
					{ type: 'cancel', taskId: ID2, reason: 'erledigt' }
				]
			}),
			''
		].join('\n');
		const r = extractChatActions(text);
		expect(r.body).toBe('Hier mein Vorschlag:');
		expect(r.invalid).toBe(0);
		expect(r.actions.map((a) => a.type)).toEqual(['create', 'update', 'cancel']);
		expect(r.actions[0]).toMatchObject({ role: 'fix', decompose: false, providerHint: null });
	});

	it('akzeptiert ein nacktes Array und ~~~-Zäune', () => {
		const r = extractChatActions(`Text\n\n${block([{ type: 'cancel', taskId: ID }], '~~~')}`);
		expect(r.actions).toEqual([{ type: 'cancel', taskId: ID }]);
		expect(r.body).toBe('Text');
	});

	it('akzeptiert einen Block ohne schließenden Zaun am Textende', () => {
		const text = `Antwort\n\n\`\`\`${CHAT_ACTIONS_LANG}\n[{"type":"cancel","taskId":"${ID}"}]\n`;
		const r = extractChatActions(text);
		expect(r.actions).toHaveLength(1);
		expect(r.body).toBe('Antwort');
	});

	it('sammelt mehrere Blöcke und entfernt Duplikate', () => {
		const cancel = { type: 'cancel', taskId: ID };
		const text = `A\n\n${block([cancel])}\n\nB\n\n${block({ actions: [cancel, { type: 'update', taskId: ID2, priority: -2 }] })}`;
		const r = extractChatActions(text);
		expect(r.actions).toHaveLength(2);
		expect(r.invalid).toBe(0);
		expect(r.body).toBe('A\n\nB');
	});

	it('zählt ungültiges JSON als einen ungültigen Block', () => {
		const r = extractChatActions(`Text\n${block('{ actions: [kaputt')}`);
		expect(r).toEqual({ body: 'Text', actions: [], invalid: 1 });
		expect(extractChatActions(block('{"foo": 1}')).invalid).toBe(1);
	});

	it('überspringt einzelne ungültige Aktionen und zählt sie', () => {
		const r = extractChatActions(
			block([
				{ type: 'create', title: 'Gut', prompt: 'P' },
				{ type: 'create', title: '', prompt: 'P' },
				{ type: 'update', taskId: ID },
				{ type: 'delete', taskId: ID },
				'Unsinn',
				{ type: 'cancel', taskId: ID }
			])
		);
		expect(r.actions.map((a) => a.type)).toEqual(['create', 'cancel']);
		expect(r.invalid).toBe(4);
		expect(r.body).toBe('');
	});

	it('hält insgesamt höchstens MAX_CHAT_ACTIONS', () => {
		const many = (n: number, offset: number) =>
			Array.from({ length: n }, (_, i) => ({
				type: 'create',
				title: `Auftrag ${offset + i}`,
				prompt: 'P'
			}));
		const r = extractChatActions(`${block(many(7, 0))}\n${block(many(7, 7))}`);
		expect(r.actions).toHaveLength(MAX_CHAT_ACTIONS);
		expect(r.invalid).toBe(4);
		expect((r.actions[9] as Extract<ChatAction, { type: 'create' }>).title).toBe('Auftrag 9');
	});

	it('lässt normale json-Blöcke und Text ohne Block unverändert', () => {
		const text = 'Beispiel:\n\n```json\n{"actions":[{"type":"cancel"}]}\n```\n\n';
		expect(extractChatActions(text)).toEqual({ body: text, actions: [], invalid: 0 });
		expect(extractChatActions('Nur Text  \n\n')).toEqual({
			body: 'Nur Text  \n\n',
			actions: [],
			invalid: 0
		});
		// ein aidev-actions-Beispiel innerhalb eines anderen Blocks zählt nicht
		const nested = '````markdown\n```aidev-actions\n[]\n```\n````';
		expect(extractChatActions(nested).actions).toEqual([]);
		expect(extractChatActions(nested).body).toBe(nested);
	});

	it('erkennt nur genau die Sprache aidev-actions', () => {
		const text = '```aidev-actions-x\n[]\n```';
		expect(extractChatActions(text)).toEqual({ body: text, actions: [], invalid: 0 });
	});

	it('entfernt den Block mitten im Text und behält json-Blöcke', () => {
		const json = '```json\n{"a":1}\n```';
		const text = `Vorher\n\n${block([{ type: 'cancel', taskId: ID }])}\n\nNachher\n\n${json}\n\n\n`;
		const r = extractChatActions(text);
		expect(r.body).toBe(`Vorher\n\nNachher\n\n${json}`);
		expect(r.actions).toHaveLength(1);
	});

	it('wirft nie', () => {
		expect(() => extractChatActions(undefined as unknown as string)).not.toThrow();
		expect(extractChatActions(block('null')).invalid).toBe(1);
	});
});

describe('storedActionsOf', () => {
	const stored = {
		action: { type: 'cancel', taskId: ID },
		state: 'applied',
		taskId: ID,
		error: null,
		decidedBy: 'u1',
		decidedAt: '2026-11-25T10:00:00.000Z'
	};

	it('liefert [] für null und Unsinn', () => {
		expect(storedActionsOf(null)).toEqual([]);
		expect(storedActionsOf(undefined)).toEqual([]);
		expect(storedActionsOf('kein json')).toEqual([]);
		expect(storedActionsOf({ actions: [] })).toEqual([]);
		expect(storedActionsOf(42)).toEqual([]);
	});

	it('behält gültige Einträge, verwirft ungültige und ergänzt Standardwerte', () => {
		const r = storedActionsOf([
			stored,
			{ action: { type: 'nope' }, state: 'pending' },
			{ ...stored, state: 'unbekannt' },
			'Müll',
			{ action: { type: 'create', title: 'T', prompt: 'P' } }
		]);
		expect(r).toHaveLength(2);
		expect(r[0]).toEqual(stored);
		expect(r[1]).toMatchObject({ state: 'pending', taskId: null, error: null, decidedBy: null });
		expect(storedActionsOf(JSON.stringify([stored]))).toEqual([stored]);
	});
});

describe('describeChatAction', () => {
	it('beschreibt alle Typen', () => {
		const [create, update, cancel] = extractChatActions(
			block([
				{ type: 'create', title: 'Dark Mode', prompt: 'P' },
				{ type: 'update', taskId: ID, title: 'T', prompt: 'P', priority: 1 },
				{ type: 'cancel', taskId: ID }
			])
		).actions;
		if (!create || !update || !cancel) throw new Error('Aktionen fehlen');
		expect(describeChatAction(create)).toBe('Neuer Auftrag „Dark Mode“');
		expect(describeChatAction(update)).toBe('Auftrag ändern: Titel, Text, Priorität');
		expect(describeChatAction(cancel)).toBe('Auftrag abbrechen');
	});
});
