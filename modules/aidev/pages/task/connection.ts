/**
 * Hinweise zu Läufen, die die Verbindung zum Runner verloren haben (`errorKind = 'connection'`: Lease abgelaufen,
 * Runner neu gestartet). Ein solcher Lauf zählt nicht als Versuch; ob der Auftrag automatisch neu eingeplant wird,
 * hängt vom aktuellen Auftragszustand ab (nach zu vielen Verlusten in Folge endet er als `failed`).
 */

/** Zustände, in denen das Backend den Auftrag selbst (wieder) einplant bzw. ausführt */
const AUTO: readonly string[] = ['queued', 'running'];

export interface ConnectionLostState {
	/** Zustand des Auftrags */
	taskStatus: string | null | undefined;
	/** Der betrachtete Lauf ist der neueste des Auftrags */
	latest: boolean;
}

/** Text unter „Verbindung zum Runner verloren“ */
export function connectionLostHint({ taskStatus, latest }: ConnectionLostState): string {
	const base = 'Dieser Lauf zählt nicht als Versuch.';
	if (!latest) return `${base} Der Auftrag wurde danach neu eingeplant.`;
	if (taskStatus && AUTO.includes(taskStatus))
		return `${base} Der Auftrag wird automatisch neu eingeplant, bevorzugt auf einem anderen Agenten.`;
	if (taskStatus === 'failed')
		return `${base} Die automatischen Neustarts sind beendet – bitte den Runner prüfen und den Auftrag mit „Neu starten“ erneut einplanen.`;
	return base;
}

/** „Neu starten“ direkt am Hinweis anbieten: neuester Lauf, Auftrag wird nicht ohnehin automatisch eingeplant */
export function offerRestartAtLostRun(
	{ taskStatus, latest }: ConnectionLostState,
	canRetry: boolean
): boolean {
	return canRetry && latest && !!taskStatus && !AUTO.includes(taskStatus);
}
