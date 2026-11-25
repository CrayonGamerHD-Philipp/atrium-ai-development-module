/**
 * Aktionsvorschläge von Agents im Projekt-Chat (reine Logik, nur `zod` – wird auch vom Browser-UI importiert).
 * Ein Agent beendet seine Antwort mit einem Code-Block in der Sprache `aidev-actions`, z. B.
 *
 * ```aidev-actions
 * { "actions": [{ "type": "create", "title": "Dark Mode", "prompt": "Baue einen Dark Mode …" }] }
 * ```
 *
 * Atrium entfernt den Block aus dem sichtbaren Text, speichert die gültigen Aktionen als Vorschlag an der
 * Chatnachricht, und ein Mensch übernimmt oder verwirft sie.
 */
import { z } from 'zod';
import { providerSchema, roleSchema } from './protocol';

/** Sprache des Code-Blocks mit Aktionsvorschlägen */
export const CHAT_ACTIONS_LANG = 'aidev-actions';

/** Höchstzahl an Aktionen pro Chatnachricht */
export const MAX_CHAT_ACTIONS = 10;

/** Rollen, die ein Agent für neue Aufträge vorschlagen darf */
const chatActionRoleSchema = roleSchema.extract(['research', 'implement', 'review', 'fix']);

const titleSchema = z.string().trim().min(1).max(200);
const promptSchema = z.string().trim().min(1).max(20000);
const reasonSchema = z.string().trim().max(500);

const createActionSchema = z.object({
	type: z.literal('create'),
	title: titleSchema,
	prompt: promptSchema,
	role: chatActionRoleSchema.default('implement'),
	decompose: z.boolean().default(false),
	providerHint: providerSchema.nullable().default(null),
	targetPr: z.number().int().positive().nullable().default(null)
});

const updateActionSchema = z
	.object({
		type: z.literal('update'),
		taskId: z.string().uuid(),
		title: titleSchema.optional(),
		prompt: promptSchema.optional(),
		priority: z.number().int().min(-10).max(10).optional(),
		providerHint: providerSchema.nullable().optional(),
		reason: reasonSchema.optional()
	})
	.refine(
		(a) =>
			a.title !== undefined ||
			a.prompt !== undefined ||
			a.priority !== undefined ||
			a.providerHint !== undefined,
		{ message: 'Mindestens eine Änderung (Titel, Text, Priorität, Anbieter) angeben' }
	);

const cancelActionSchema = z.object({
	type: z.literal('cancel'),
	taskId: z.string().uuid(),
	reason: reasonSchema.optional()
});

/** Eine vorgeschlagene Plattformaktion: Auftrag anlegen, ändern oder abbrechen */
export const chatActionSchema = z.discriminatedUnion('type', [
	createActionSchema,
	updateActionSchema,
	cancelActionSchema
]);
export type ChatAction = z.infer<typeof chatActionSchema>;

/** Inhalt eines `aidev-actions`-Blocks */
export const chatActionsBlockSchema = z.object({
	actions: z.array(chatActionSchema).min(1).max(MAX_CHAT_ACTIONS)
});

/** Öffnender Zaun: ``` oder ~~~ (mind. 3), bis zu 3 Leerzeichen Einrückung, danach die Info-Zeile */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Schließender Zaun passend zum öffnenden (gleiches Zeichen, mind. gleich lang, ohne Info-Zeile) */
function isClosingFence(line: string, fence: string): boolean {
	const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	const close = m?.[1] ?? '';
	return close !== '' && close[0] === fence[0] && close.length >= fence.length;
}

/** JSON eines Blocks → Liste der Rohaktionen, `null` bei ungültigem JSON oder falscher Form */
function rawActionsOf(json: string): unknown[] | null {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	if (Array.isArray(data)) return data;
	if (data && typeof data === 'object' && Array.isArray((data as { actions?: unknown }).actions)) {
		return (data as { actions: unknown[] }).actions;
	}
	return null;
}

/**
 * Sucht alle Code-Blöcke mit genau der Sprache `aidev-actions` (``` oder ~~~, auch ohne schließenden Zaun am
 * Textende), prüft jede Aktion einzeln und entfernt die Blöcke aus dem Text. Ungültige Aktionen (und Blöcke mit
 * ungültigem JSON, je 1) zählen in `invalid`; Duplikate werden still entfernt, Aktionen über `MAX_CHAT_ACTIONS`
 * hinaus zählen ebenfalls als `invalid`. Andere Code-Blöcke (z. B. ```json) bleiben unverändert. Wirft nie.
 */
export function extractChatActions(text: string): {
	body: string;
	actions: ChatAction[];
	invalid: number;
} {
	const source = typeof text === 'string' ? text : '';
	const lines = source.split('\n');
	const kept: string[] = [];
	const actions: ChatAction[] = [];
	const seen = new Set<string>();
	let invalid = 0;
	let found = false;
	/** Zeile ohne `\r` (CRLF), leer außerhalb des Texts */
	const at = (n: number) => (lines[n] ?? '').replace(/\r$/, '');

	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_OPEN.exec(at(i));
		const fence = open?.[1] ?? '';
		const info = open?.[2] ?? '';
		// Backtick-Zäune dürfen keine Backticks in der Info-Zeile haben (CommonMark)
		if (!fence || (fence.startsWith('`') && info.includes('`'))) {
			kept.push(lines[i] ?? '');
			continue;
		}
		const lang = info.trim().split(/\s+/)[0] ?? '';
		let end = i + 1;
		while (end < lines.length && !isClosingFence(at(end), fence)) end++;

		if (lang !== CHAT_ACTIONS_LANG) {
			// fremden Block samt Inhalt unverändert übernehmen
			kept.push(...lines.slice(i, Math.min(end + 1, lines.length)));
			i = end;
			continue;
		}

		found = true;
		const raw = rawActionsOf(lines.slice(i + 1, end).join('\n'));
		if (raw === null) {
			invalid++;
		} else {
			for (const item of raw) {
				const parsed = chatActionSchema.safeParse(item);
				if (!parsed.success) {
					invalid++;
					continue;
				}
				const key = JSON.stringify(parsed.data);
				if (seen.has(key)) continue;
				if (actions.length >= MAX_CHAT_ACTIONS) {
					invalid++;
					continue;
				}
				seen.add(key);
				actions.push(parsed.data);
			}
		}
		// doppelte Leerzeile an der Schnittstelle vermeiden
		const prevBlank = kept.length === 0 || (kept[kept.length - 1] ?? '').trim() === '';
		if (prevBlank && end + 1 < lines.length && at(end + 1).trim() === '') end++;
		i = end;
	}

	if (!found) return { body: source, actions: [], invalid: 0 };
	return { body: kept.join('\n').trimEnd(), actions, invalid };
}

/** Zustand eines gespeicherten Vorschlags */
export type ChatActionState = 'pending' | 'applied' | 'rejected' | 'failed';
export const chatActionStateSchema = z.enum(['pending', 'applied', 'rejected', 'failed']);

/** Gespeicherter Vorschlag an einer Chatnachricht */
export interface StoredChatAction {
	action: ChatAction;
	state: ChatActionState;
	/** angelegter bzw. betroffener Auftrag (nach dem Übernehmen) */
	taskId: string | null;
	/** Fehlermeldung bei `failed` */
	error: string | null;
	/** Benutzer-ID der Entscheidung */
	decidedBy: string | null;
	/** ISO-Zeitpunkt der Entscheidung */
	decidedAt: string | null;
}

/** Zum sicheren Lesen des gespeicherten JSON (fehlende Felder → Standardwerte) */
export const storedChatActionSchema = z.object({
	action: chatActionSchema,
	state: chatActionStateSchema.default('pending'),
	taskId: z.string().nullable().default(null),
	error: z.string().nullable().default(null),
	decidedBy: z.string().nullable().default(null),
	decidedAt: z.string().nullable().default(null)
});

/** Gespeicherte Vorschläge aus Roh-JSON (auch als String); ungültige Einträge entfallen, sonst `[]` */
export function storedActionsOf(raw: unknown): StoredChatAction[] {
	let data = raw;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(data)) return [];
	const out: StoredChatAction[] = [];
	for (const item of data) {
		const parsed = storedChatActionSchema.safeParse(item);
		if (parsed.success) out.push(parsed.data);
	}
	return out;
}

/** Kurzbeschreibung auf Deutsch für UI und Systemnachrichten */
export function describeChatAction(a: ChatAction): string {
	switch (a.type) {
		case 'create':
			return `Neuer Auftrag „${a.title}“`;
		case 'update': {
			const fields: string[] = [];
			if (a.title !== undefined) fields.push('Titel');
			if (a.prompt !== undefined) fields.push('Text');
			if (a.priority !== undefined) fields.push('Priorität');
			if (a.providerHint !== undefined) fields.push('Anbieter');
			return `Auftrag ändern: ${fields.join(', ')}`;
		}
		case 'cancel':
			return 'Auftrag abbrechen';
	}
}
