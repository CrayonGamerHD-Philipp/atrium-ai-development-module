/**
 * Übergaben im Auftragsverlauf und Anzeige-Zustand der Runner (reine Logik, keine Server-Importe).
 *
 * Ein Lauf gilt als übergeben, wenn ein PC-Runner ihn geordnet abgegeben hat (`run.handoff`: Standby,
 * Herunterfahren, manuell) oder wenn die Verbindung verloren ging (`lost` mit `error_kind = connection`). Den
 * übernehmenden Runner liefert der nächste spätere Lauf desselben Auftrags, der angenommen wurde bzw. läuft.
 */

export const HANDOVER_REASONS = ['suspend', 'shutdown', 'manual', 'connection'] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];
export type RunnerKindValue = 'server' | 'desktop';

/** Übergabe eines Laufs an den nächsten (für `RunDto.handover`) */
export interface RunHandoverDto {
	reason: HandoverReason;
	fromRunner: string;
	fromKind: RunnerKindValue;
	/** Übernehmender Runner (`null` = noch nicht neu vergeben) */
	toRunner: string | null;
	toKind: RunnerKindValue | null;
	/** Zwischenstand (WIP-Ref) wurde gesichert */
	wipPushed: boolean;
}

/** Minimale Lauf-Sicht für `handoversOf` */
export interface HandoverRun {
	id: string;
	status: string;
	errorKind: string | null;
	runnerName: string;
	runnerKind: RunnerKindValue;
	startedAt: string | null;
	createdAt: string;
	/** `run.handoff` (jsonb) */
	handoff: { reason?: unknown; wipPushed?: unknown } | null;
	/** Checkpoint vorhanden (`run.wip_sha`) */
	hasWip: boolean;
}

const LABELS: Record<HandoverReason, string> = {
	suspend: 'Standby',
	shutdown: 'Herunterfahren',
	manual: 'manuelle Übergabe',
	connection: 'Verbindungsverlust'
};

export function handoverReasonLabel(reason: HandoverReason): string {
	return LABELS[reason];
}

function kindLabel(kind: RunnerKindValue | null): string {
	return kind === 'desktop' ? 'PC-Runner' : 'Server-Runner';
}

/** „Übergeben von PC-Runner X an Server-Runner Y (Grund: Standby)“ */
export function handoverText(h: RunHandoverDto): string {
	const from = `${kindLabel(h.fromKind)} ${h.fromRunner || '(unbekannt)'}`;
	const to = h.toRunner ? ` an ${kindLabel(h.toKind)} ${h.toRunner}` : '';
	return `Übergeben von ${from}${to} (Grund: ${LABELS[h.reason]})`;
}

function reasonOf(run: HandoverRun): HandoverReason | null {
	const r = run.handoff?.reason;
	if (r === 'suspend' || r === 'shutdown' || r === 'manual') return r;
	if (run.status === 'lost' && run.errorKind === 'connection') return 'connection';
	return null;
}

/**
 * Übergaben je Lauf-ID. Reihenfolge der Eingabe egal; „nächster Lauf“ = frühester späterer Lauf (nach
 * `createdAt`), der gestartet wurde oder gerade angeboten/laufend ist.
 */
export function handoversOf(runs: readonly HandoverRun[]): Map<string, RunHandoverDto> {
	const sorted = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	const out = new Map<string, RunHandoverDto>();
	sorted.forEach((run, i) => {
		const reason = reasonOf(run);
		if (!reason) return;
		const next = sorted
			.slice(i + 1)
			.find((r) => r.startedAt !== null || r.status === 'offered' || r.status === 'running');
		out.set(run.id, {
			reason,
			fromRunner: run.runnerName,
			fromKind: run.runnerKind,
			toRunner: next?.runnerName ?? null,
			toKind: next?.runnerKind ?? null,
			wipPushed: run.handoff?.wipPushed === true || run.hasWip
		});
	});
	return out;
}

// ---------------------------------------------------------------- Anzeige-Zustand der Runner

export type RunnerStateValue =
	'active' | 'handover' | 'standby' | 'offline' | 'returned' | 'pending' | 'disabled';

export interface RunnerStateInput {
	status: string;
	online: boolean;
	handoverReason: string | null;
	returnedAt: number | null;
	now: number;
	/** Anzeige „zurück“ so lange nach der Rückkehr (ms) */
	returnedShowMs: number;
}

/** Zustand für die Runner-Seite: Freigabe vor Übergabe vor Erreichbarkeit */
export function runnerStateOf(i: RunnerStateInput): RunnerStateValue {
	if (i.status === 'pending') return 'pending';
	if (i.status === 'disabled') return 'disabled';
	if (i.handoverReason) {
		if (i.online) return 'handover';
		return i.handoverReason === 'suspend' ? 'standby' : 'offline';
	}
	if (!i.online) return 'offline';
	if (i.returnedAt !== null && i.now - i.returnedAt < i.returnedShowMs) return 'returned';
	return 'active';
}

// ---------------------------------------------------------------- Versionen

/** `1.2.3`, `1.2.3-beta.1` → Vergleich (negativ: a < b). Ungültige Teile zählen als 0. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core = '', pre = ''] = v.trim().replace(/^v/, '').split('-', 2);
		return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d !== 0) return d;
	}
	// Vorabversion < Release
	if (x.pre && !y.pre) return -1;
	if (!x.pre && y.pre) return 1;
	return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0;
}

/** Ist `current` älter als `latest`? Entwicklungsstände (`-dev`) und leere Versionen gelten nie als veraltet. */
export function isUpdateAvailable(current: string, latest: string): boolean {
	if (!current || !latest || current.endsWith('-dev')) return false;
	return compareVersions(current, latest) < 0;
}
