/**
 * Übergabe laufender Läufe an Atrium vor Standby bzw. Herunterfahren des PCs (reine Hilfsfunktionen). Der Ablauf
 * selbst steht in `Executor.handoff`; die Erkennung von Standby/Herunterfahren ist nicht Teil dieser Datei.
 */
import type { Handoff, HandoffReason, RunOffer } from './protocol.ts';
import type { Redactor } from './redact.ts';

export type { HandoffReason };

/** Höchstlänge der Notiz (`handoff.note`) */
export const HANDOFF_NOTE_MAX = 4000;

/** Meldung für `finish.errorMessage` */
export function handoffMessage(reason: HandoffReason): string {
	return reason === 'suspend' ? 'Übergabe: PC geht in den Standby' : 'Übergabe: PC wird heruntergefahren';
}

/**
 * Darf für diesen Lauf ein Zwischenstand gepusht werden? Nur schreibende Läufe mit eigenem Arbeits-Branch – nie
 * Nur-Lese-Läufe, Fragen, `none` oder der Head-Branch eines bestehenden PR (`pr-update`).
 */
export function wipEligible(offer: RunOffer): boolean {
	return (
		!offer.readOnly &&
		offer.question !== true &&
		offer.delivery.mode !== 'none' &&
		offer.delivery.mode !== 'pr-update' &&
		offer.branch !== offer.project.defaultBranch
	);
}

/** Bereinigte Kurzfassung der letzten Agent-Antwort (oder null) */
export function handoffNote(text: string | null | undefined, redactor: Redactor): string | null {
	const t = text ? redactor.redact(text).trim() : '';
	if (!t) return null;
	return t.length > HANDOFF_NOTE_MAX ? `${t.slice(0, HANDOFF_NOTE_MAX - 1)}…` : t;
}

/** `handoff`-Feld für `finish` */
export function handoffInfo(
	reason: HandoffReason,
	wipPushed: boolean,
	headSha: string | null,
	note: string | null
): Handoff {
	const sha = wipPushed && headSha && /^[0-9a-f]{7,40}$/.test(headSha) ? headSha : null;
	return { reason, wipPushed: wipPushed && sha !== null, headSha: sha, note };
}
