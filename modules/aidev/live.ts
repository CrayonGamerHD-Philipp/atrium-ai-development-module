/**
 * Live-Verbindungen (SSE über den SDK-Hub `createLiveHub`), alle im Prozess (eine App-Instanz):
 * - `projectHub`  (objectId = Projekt-ID): Browser, `ProjectLiveEvent`
 * - `overviewHub` (objectId = `all`): Browser, `OverviewLiveEvent`
 * - `terminalHub` (objectId = Sitzungs-ID): Browser, `TerminalLiveEvent` (nur Eigentümer*in der Sitzung)
 * - `runnerHub`   (objectId = Runner-ID): Runner, `RunnerCommand` (Befehle Atrium → Runner)
 */
import { sql } from 'drizzle-orm';
import { core, createLiveHub, logBestEffort, type RequestContext } from '$lib/sdk/server';
import { mdb, oneOf } from './db';
import type { RunnerCommand } from './protocol';
import { rejectAllRpc } from './rpc.service';
import { runnerDisconnected } from './runners.service';
import { stopScheduler } from './scheduler.service';
import { loadOverview } from './usage.service';
import {
	PERM,
	type OverviewLiveEvent,
	type ProjectLiveEvent,
	type TaskDto,
	type RunSummaryDto,
	type TerminalLiveEvent
} from './schemas';
import { MAX_STREAMS_PER_USER } from './db';

export const OVERVIEW_ID = 'all';

export const projectHub = createLiveHub<'view', null>({
	name: 'aidev-project',
	maxStreamsPerUser: MAX_STREAMS_PER_USER,
	async resolveLevel(ctx, projectId) {
		if (!core.permissions.has(ctx, PERM.projectView)) return null;
		const row = await mdb().transaction((tx) =>
			oneOf(tx, sql`SELECT id FROM project WHERE id = ${projectId}`)
		);
		return row ? 'view' : null;
	}
});

export const overviewHub = createLiveHub<'view', null>({
	name: 'aidev-overview',
	maxStreamsPerUser: MAX_STREAMS_PER_USER,
	async resolveLevel(ctx) {
		return core.permissions.has(ctx, PERM.projectView) ? 'view' : null;
	}
});

/** Prüft, ob der Kontext (API-Key) noch zum Runner passt und der Runner nicht gesperrt ist */
export async function runnerConnectLevel(
	ctx: RequestContext,
	runnerId: string
): Promise<'connected' | null> {
	if (ctx.actor.type !== 'api_key' || !ctx.actor.id) return null;
	if (!core.permissions.has(ctx, PERM.runnerConnect)) return null;
	const row = await mdb().transaction((tx) =>
		oneOf(tx, sql`SELECT api_key_id, status FROM runner WHERE id = ${runnerId}`)
	);
	if (!row || row.status === 'disabled' || String(row.api_key_id) !== ctx.actor.id) return null;
	return 'connected';
}

export const runnerHub = createLiveHub<'connected', { runnerId: string }>({
	name: 'aidev-runner',
	// je Runner (Subjekt `runner:<id>`) wenige Verbindungen; dieselbe Kennung löst die alte ab
	maxStreamsPerUser: 3,
	heartbeatMs: 15_000,
	resolveLevel: runnerConnectLevel,
	onLeave(sub, remaining) {
		if (remaining > 0) return;
		void runnerDisconnected(sub.objectId).catch((e: unknown) =>
			logBestEffort('aidev.runner.disconnect', e, { target: sub.objectId })
		);
	}
});

/** Ist ein Runner gerade per SSE verbunden? */
export const runnerConnected = (runnerId: string) => runnerHub.subscribers(runnerId).length > 0;

export function sendToRunner(runnerId: string, command: RunnerCommand): boolean {
	if (!runnerConnected(runnerId)) return false;
	runnerHub.broadcast(runnerId, command);
	return true;
}

export async function terminalLevel(ctx: RequestContext, sid: string): Promise<'owner' | null> {
	if (!ctx.userId || !core.permissions.has(ctx, PERM.terminal)) return null;
	const row = await mdb().transaction((tx) =>
		oneOf(
			tx,
			sql`SELECT user_id FROM workspace_session
				WHERE id = ${sid} AND kind = 'terminal' AND closed_at IS NULL`
		)
	);
	return row && String(row.user_id) === ctx.userId ? 'owner' : null;
}

export const terminalHub = createLiveHub<'owner', null>({
	name: 'aidev-terminal',
	maxStreamsPerUser: MAX_STREAMS_PER_USER,
	resolveLevel: terminalLevel
});

// ---------------------------------------------------------------- Terminal-Puffer

/** Ausgabe, bevor die erste Browser-Verbindung steht (Eingabeaufforderung), höchstens so viele Zeichen */
const TERMINAL_BUFFER_CHARS = 256_000;
const terminalBuffers = new Map<string, { events: TerminalLiveEvent[]; chars: number }>();

export function terminalStarted(sid: string): void {
	terminalBuffers.set(sid, { events: [], chars: 0 });
}

export function terminalEvent(sid: string, event: TerminalLiveEvent): void {
	if (terminalHub.subscribers(sid).length) {
		terminalHub.broadcast(sid, event);
		return;
	}
	const buf = terminalBuffers.get(sid);
	if (!buf) return;
	const size = event.type === 'output' ? event.data.length : 0;
	if (buf.chars + size > TERMINAL_BUFFER_CHARS) return;
	buf.events.push(event);
	buf.chars += size;
}

/** Gepufferte Ausgabe übernehmen (einmalig, danach live) */
export function takeTerminalBuffer(sid: string): TerminalLiveEvent[] {
	const buf = terminalBuffers.get(sid);
	terminalBuffers.delete(sid);
	return buf?.events ?? [];
}

export function terminalClosed(sid: string, event?: TerminalLiveEvent): void {
	terminalBuffers.delete(sid);
	terminalHub.closeObject(sid, event);
}

// ---------------------------------------------------------------- Verteilen

export function broadcastProject(projectId: string, event: ProjectLiveEvent): void {
	projectHub.broadcast(projectId, event);
}

export function broadcastTask(task: TaskDto): void {
	projectHub.broadcast(task.projectId, { type: 'task', task } satisfies ProjectLiveEvent);
}

export function broadcastRun(projectId: string, run: RunSummaryDto & { taskId: string }): void {
	projectHub.broadcast(projectId, { type: 'run', run } satisfies ProjectLiveEvent);
}

const OVERVIEW_DEBOUNCE_MS = 500;
let overviewTimer: ReturnType<typeof setTimeout> | null = null;

/** Übersicht entprellt (500 ms) an alle offenen Übersichten verteilen */
export function broadcastOverview(): void {
	if (overviewTimer || !overviewHub.subscribers(OVERVIEW_ID).length) return;
	overviewTimer = setTimeout(() => {
		overviewTimer = null;
		if (!overviewHub.subscribers(OVERVIEW_ID).length) return;
		void mdb()
			.transaction((tx) => loadOverview(tx))
			.then((overview) =>
				overviewHub.broadcast(OVERVIEW_ID, {
					type: 'overview',
					overview
				} satisfies OverviewLiveEvent)
			)
			.catch((e: unknown) => logBestEffort('aidev.overview.broadcast', e));
	}, OVERVIEW_DEBOUNCE_MS);
}

/** Alle Verbindungen schließen (Modul deaktiviert, Daten ersetzt) */
export function closeAllLive(): void {
	if (overviewTimer) clearTimeout(overviewTimer);
	overviewTimer = null;
	stopScheduler();
	rejectAllRpc();
	terminalBuffers.clear();
	const revoked = { type: 'revoked' } as const;
	projectHub.closeAll(revoked);
	overviewHub.closeAll(revoked);
	terminalHub.closeAll(revoked);
	runnerHub.closeAll(revoked);
}
