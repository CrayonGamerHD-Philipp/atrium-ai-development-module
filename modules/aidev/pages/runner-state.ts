// Anzeige für Runner-Art, -Zustand und Übergaben (Runner-Seite, Auftragsverlauf)
import type { RunnerDto } from '../schemas';

export const KIND_LABEL: Record<RunnerDto['kind'], string> = {
	desktop: 'PC-Runner',
	server: 'Server-Runner'
};

type Tone = 'success' | 'warning' | 'info' | 'outline' | 'destructive';

export const STATE_LABEL: Record<RunnerDto['state'], { label: string; tone: Tone; hint: string }> =
	{
		active: { label: 'Aktiv', tone: 'success', hint: 'Verbunden, bekommt Aufträge' },
		handover: {
			label: 'Wird übergeben',
			tone: 'warning',
			hint: 'Übergibt laufende Aufträge an einen Server-Runner (Standby, Herunterfahren oder Pause) und bekommt keine neuen'
		},
		standby: {
			label: 'Standby',
			tone: 'outline',
			hint: 'Nach einer Übergabe im Standby – Aufträge laufen auf Server-Runnern weiter'
		},
		offline: { label: 'Offline', tone: 'outline', hint: 'Kein Lebenszeichen' },
		returned: {
			label: 'Zurück',
			tone: 'secondary',
			hint: 'Kürzlich aus Standby bzw. Funkstille zurück – bekommt wieder neue Aufträge, laufende bleiben, wo sie sind'
		},
		pending: {
			label: 'Wartet auf Freigabe',
			tone: 'warning',
			hint: 'In Atrium noch nicht freigegeben'
		},
		disabled: { label: 'Gesperrt', tone: 'outline', hint: 'Gesperrt – bekommt keine Aufträge' }
	};

export const HANDOVER_REASON_LABEL: Record<NonNullable<RunnerDto['handoverReason']>, string> = {
	suspend: 'Standby',
	shutdown: 'Herunterfahren',
	manual: 'manuell bzw. pausiert'
};
