// Chat-Modi für den Composer: Beschriftung, Symbol und Ein-Satz-Erklärung (reine Daten fürs UI)
import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
import Hammer from '@lucide/svelte/icons/hammer';
import Sparkles from '@lucide/svelte/icons/sparkles';
import StickyNote from '@lucide/svelte/icons/sticky-note';

export type ChatMode = 'auto' | 'task' | 'question' | 'note';

export interface ChatModeInfo {
	value: ChatMode;
	label: string;
	hint: string;
	icon: typeof Sparkles;
	placeholder: string;
}

export const CHAT_MODES: ChatModeInfo[] = [
	{
		value: 'auto',
		label: 'Automatisch',
		hint: 'Erkennt selbst, ob du etwas fragst oder einen Auftrag gibst.',
		icon: Sparkles,
		placeholder: 'Nachricht schreiben …'
	},
	{
		value: 'task',
		label: 'Auftrag',
		hint: 'Ein Agent setzt es um und liefert die Änderungen aus.',
		icon: Hammer,
		placeholder: 'Auftrag beschreiben …'
	},
	{
		value: 'question',
		label: 'Frage',
		hint: 'Wird lesend beantwortet, ohne den Code zu ändern.',
		icon: CircleQuestionMark,
		placeholder: 'Frage stellen …'
	},
	{
		value: 'note',
		label: 'Notiz',
		hint: 'Bleibt nur im Verlauf, es startet kein Agent.',
		icon: StickyNote,
		placeholder: 'Notiz schreiben …'
	}
];

export function isChatMode(v: unknown): v is ChatMode {
	return CHAT_MODES.some((m) => m.value === v);
}

export function modeInfo(mode: ChatMode): ChatModeInfo {
	return CHAT_MODES.find((m) => m.value === mode) ?? CHAT_MODES[0]!;
}

/** localStorage ohne Fehler (z. B. privater Modus oder voller Speicher) */
export const storage = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Einstellung gilt dann nur für diese Sitzung
		}
	},
	remove(key: string) {
		try {
			localStorage.removeItem(key);
		} catch {
			// ignorieren
		}
	}
};
