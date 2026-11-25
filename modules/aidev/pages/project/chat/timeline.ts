/**
 * Reine Hilfslogik für den Chat-Verlauf: Gruppierung aufeinanderfolgender Nachrichten, Tagestrenner
 * („Heute“/„Gestern“) und Zustand des zugehörigen Auftrags für den Antwort-Indikator.
 */
import { FINAL_TASK_STATUSES, type ChatMessageDto, type TaskDto } from '../../../schemas';

/** Höchstabstand zweier Nachrichten derselben Gruppe */
export const GROUP_GAP_MS = 5 * 60_000;

export interface TimelineItem {
	message: ChatMessageDto;
	/** Erste Nachricht einer Gruppe (zeigt Avatar, Name, Zeit) */
	first: boolean;
	/** Letzte Nachricht einer Gruppe (Abstand zur nächsten Gruppe) */
	last: boolean;
	/** Tagestrenner vor dieser Nachricht (Beschriftung), sonst `null` */
	day: string | null;
}

/** Lokaler Kalendertag (`YYYY-MM-DD`) – nicht UTC, damit der Trenner zur Uhrzeit des Nutzers passt */
export function localDayKey(date: Date): string {
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${m}-${d}`;
}

/** „Heute“, „Gestern“ oder Wochentag mit Datum (Jahr nur, wenn nicht das aktuelle) */
export function dayLabel(iso: string, now = new Date()): string {
	const date = new Date(iso);
	const key = localDayKey(date);
	if (key === localDayKey(now)) return 'Heute';
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (key === localDayKey(yesterday)) return 'Gestern';
	return date.toLocaleDateString('de-DE', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
	});
}

/** Uhrzeit „14:05“ */
export function clockTime(iso: string): string {
	return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Gehören zwei aufeinanderfolgende Nachrichten zur selben Gruppe? (gleiche Art + Autor, gleicher Tag, < 5 Min.) */
export function sameGroup(prev: ChatMessageDto, next: ChatMessageDto): boolean {
	if (prev.kind === 'system' || next.kind === 'system') return false;
	if (prev.kind !== next.kind) return false;
	if ((prev.author?.id ?? null) !== (next.author?.id ?? null)) return false;
	const a = new Date(prev.createdAt);
	const b = new Date(next.createdAt);
	if (localDayKey(a) !== localDayKey(b)) return false;
	const gap = b.getTime() - a.getTime();
	return gap >= 0 && gap < GROUP_GAP_MS;
}

/** Verlauf (älteste zuerst) → Einträge mit Gruppen- und Tagesinformation */
export function buildTimeline(messages: ChatMessageDto[], now = new Date()): TimelineItem[] {
	return messages.map((message, i) => {
		const prev = messages[i - 1];
		const next = messages[i + 1];
		const newDay =
			!prev || localDayKey(new Date(prev.createdAt)) !== localDayKey(new Date(message.createdAt));
		return {
			message,
			first: !prev || !sameGroup(prev, message),
			last: !next || !sameGroup(message, next),
			day: newDay ? dayLabel(message.createdAt, now) : null
		};
	});
}

export type Activity =
	{ kind: 'working'; task: TaskDto; label: string } | { kind: 'needs-input'; task: TaskDto };

/**
 * Antwort-Indikator: Auftrag der letzten Nutzernachricht, solange er nicht abgeschlossen ist.
 * Ohne Auftrag (z. B. Notiz) oder im Endzustand → `null`.
 */
export function activityFor(
	messages: ChatMessageDto[],
	tasksById: Map<string, TaskDto>
): Activity | null {
	let lastUser: ChatMessageDto | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.kind === 'user') {
			lastUser = messages[i];
			break;
		}
	}
	const task = lastUser?.taskId ? tasksById.get(lastUser.taskId) : undefined;
	if (!task || FINAL_TASK_STATUSES.includes(task.status)) return null;
	if (task.status === 'needs-input') return { kind: 'needs-input', task };
	const label =
		task.status === 'running'
			? 'Agent arbeitet'
			: task.status === 'queued'
				? 'Agent startet gleich'
				: task.status === 'review'
					? 'Ergebnis wird geprüft'
					: task.status === 'blocked'
						? 'Auftrag wartet auf Abhängigkeiten'
						: 'Auftrag ist vorbereitet';
	return { kind: 'working', task, label };
}
