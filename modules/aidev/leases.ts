/**
 * Leases und Fencing (reine Logik, keine Server-Importe): Ein Lauf gilt für seinen Runner nur, solange er angeboten
 * bzw. laufend ist, seine Lease nicht abgelaufen ist und sein Fencing-Token (`run.fence`) dem aktuellen Token des
 * Auftrags (`task.lease_epoch`) entspricht. Jedes neue Angebot erhöht das Token des Auftrags – damit verliert ein
 * aufgewachter PC-Runner, dessen Lauf inzwischen ein Server-Runner übernommen hat, jede Berechtigung.
 */

/** Zeile mit den Feldern für die Prüfung (Lauf plus `lease_epoch` des Auftrags) */
export type LeaseRow = Record<string, unknown>;

/**
 * Grund, warum ein Lauf für diesen Runner nicht (mehr) gültig ist, oder `null`. `row` braucht `status`,
 * `runner_id`, `fence`, `lease_epoch` (Auftrag) und optional `expired`.
 */
export function leaseProblem(
	row: LeaseRow | null,
	runnerId: string,
	fence?: number
): string | null {
	if (!row || String(row.runner_id) !== runnerId)
		return 'Lauf gehört nicht (mehr) zu diesem Runner';
	if (row.status !== 'offered' && row.status !== 'running') {
		return row.status === 'lost'
			? 'Lauf wurde übernommen (Lease abgelaufen)'
			: `Lauf ist beendet (${String(row.status)})`;
	}
	if (row.expired === true) return 'Lease abgelaufen';
	return fenceProblem(row, fence);
}

/** Veraltetes Fencing-Token? (`fence` fehlt = ältere Runner → nicht prüfen) */
export function fenceProblem(row: LeaseRow, fence?: number): string | null {
	if (fence === undefined) return null;
	const own = row.fence === null || row.fence === undefined ? null : Number(row.fence);
	const current =
		row.lease_epoch === null || row.lease_epoch === undefined ? null : Number(row.lease_epoch);
	if (own !== null && own !== fence) return 'Veraltetes Fencing-Token';
	if (current !== null && own !== null && current !== own) return 'Auftrag wurde neu vergeben';
	return null;
}
