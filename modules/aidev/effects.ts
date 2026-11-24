/**
 * Nebenwirkungen einer Transaktion sammeln: Live-Ereignisse, Befehle an Runner, Audit-Einträge, Scheduler-Anstoß.
 * Innerhalb der Transaktion nur sammeln – ausgeführt wird nach dem Commit (`publish.service.ts`), damit keine
 * Core-Services in einer offenen Modul-Transaktion laufen und nichts gesendet wird, was zurückgerollt wurde.
 */
import type { RunnerCommand } from './protocol';

export interface AuditEntry {
	action: string;
	target?: string;
	metadata?: Record<string, unknown>;
}

export interface Effects {
	/** geänderte Aufträge (→ `task`-Ereignis) */
	tasks: Set<string>;
	/** gelöschte Aufträge (→ `task-deleted`) */
	deletedTasks: { projectId: string; taskId: string }[];
	/** geänderte Läufe (→ `run`-Ereignis) */
	runs: Set<string>;
	/** geänderte Projekte (→ `project`-Ereignis) */
	projects: Set<string>;
	/** neue Chat-Nachrichten (→ `chat`) */
	chat: Set<string>;
	/** geänderte Pull Requests `projectId:number` (→ `pr`) */
	pulls: Set<string>;
	/** Befehle an Runner (über den Runner-Hub) */
	commands: { runnerId: string; command: RunnerCommand }[];
	audits: AuditEntry[];
	/** Übersicht (Runner, Konten, aktive Läufe) neu verteilen */
	overview: boolean;
	/** Scheduler anstoßen */
	dispatch: boolean;
}

export function newEffects(): Effects {
	return {
		tasks: new Set(),
		deletedTasks: [],
		runs: new Set(),
		projects: new Set(),
		chat: new Set(),
		pulls: new Set(),
		commands: [],
		audits: [],
		overview: false,
		dispatch: false
	};
}

export function sendCommand(fx: Effects, runnerId: string | null, command: RunnerCommand): void {
	if (runnerId) fx.commands.push({ runnerId, command });
}
