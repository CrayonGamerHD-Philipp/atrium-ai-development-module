/**
 * Reine Hilfslogik für Aktionsvorschläge und „Umsetzen“ im Chat: welche Antworten umgesetzt werden können,
 * offene Vorschläge zählen, betroffenen Auftrag bestimmen und Kurztexte für die Karten.
 */
import type { ChatAction } from '../../../actions';
import type { ChatActionDto, ChatMessageDto, TaskDto, TaskStatus } from '../../../schemas';
import { clockTime } from './timeline';

/** Vorbelegter Text für „Umsetzen“ */
export const IMPLEMENT_TEXT = 'Setze den Vorschlag aus dieser Antwort um.';

/** Zustände eines Auftrags, deren Antwort sich umsetzen lässt (erfolgreich beantwortet bzw. erledigt) */
const ANSWERED: readonly TaskStatus[] = ['done', 'review'];

/**
 * Bekommt eine Nachricht den Knopf „Umsetzen“? Nur Agent-Antworten mit Auftrag und Text. Ist der Auftrag bekannt,
 * muss er erfolgreich abgeschlossen sein (keine Fehler-, Abbruch- oder Rückfrage-Nachrichten). Unbekannte Aufträge
 * (z. B. nicht geladen) gelten als beantwortet – der Server prüft beim Senden selbst.
 */
export function canImplement(message: ChatMessageDto, task: TaskDto | undefined): boolean {
	if (message.kind !== 'agent' || !message.taskId || !message.body.trim()) return false;
	return !task || ANSWERED.includes(task.status);
}

/** Offene (noch nicht entschiedene) Vorschläge */
export function pendingActions(actions: readonly ChatActionDto[]): ChatActionDto[] {
	return actions.filter((a) => a.state === 'pending');
}

/** Auftrag, auf den sich ein Vorschlag bezieht: nach dem Übernehmen der angelegte, sonst der geänderte */
export function actionTaskId(a: ChatActionDto): string | null {
	if (a.taskId) return a.taskId;
	return a.action.type === 'create' ? null : a.action.taskId;
}

/** Überschrift der Karte nach Art des Vorschlags */
export const ACTION_KIND_LABELS: Record<ChatAction['type'], string> = {
	create: 'Neuer Auftrag',
	update: 'Auftrag ändern',
	cancel: 'Auftrag abbrechen'
};

/** Geänderte Felder eines `update`-Vorschlags (z. B. „Titel, Priorität“), sonst `[]` */
export function changedFields(a: ChatAction): string[] {
	if (a.type !== 'update') return [];
	const fields: string[] = [];
	if (a.title !== undefined) fields.push('Titel');
	if (a.prompt !== undefined) fields.push('Text');
	if (a.priority !== undefined) fields.push('Priorität');
	if (a.providerHint !== undefined) fields.push('Anbieter');
	return fields;
}

/** Text, der aufklappbar angezeigt wird (Auftragstext bzw. neuer Text), sonst `null` */
export function actionPrompt(a: ChatAction): string | null {
	if (a.type === 'cancel') return null;
	return a.prompt ?? null;
}

/** Beschriftung des Bezugs-Chips: „Antwort von 14:05“ */
export function replyLabel(message: Pick<ChatMessageDto, 'createdAt'>): string {
	return `Antwort von ${clockTime(message.createdAt)}`;
}

/** Rechte der angemeldeten Person (nur zum Ein-/Ausblenden, der Server prüft selbst) */
export interface DecideRights {
	canCreate: boolean;
	canManage: boolean;
	userId: string | null;
}

/**
 * Darf die Person über den Vorschlag entscheiden? Neue Aufträge mit `task.create`; Ändern/Abbrechen eigener
 * Aufträge mit `task.create`, fremder nur mit `task.manage` (wie `assertCanEditTask`). Ein unbekannter Auftrag
 * (nicht geladen oder nicht im Projekt) bleibt entscheidbar – der Server lehnt ihn dann als `failed` ab.
 * Verwerfen ist immer möglich, wenn die Person überhaupt Aufträge geben darf.
 */
export function canApply(a: ChatAction, task: TaskDto | undefined, rights: DecideRights): boolean {
	if (!rights.canCreate && !rights.canManage) return false;
	if (a.type === 'create') return rights.canCreate;
	if (rights.canManage || !task) return true;
	return rights.canCreate && !!rights.userId && task.createdBy === rights.userId;
}
