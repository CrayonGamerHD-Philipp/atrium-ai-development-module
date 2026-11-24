/**
 * Gesammelte Nebenwirkungen (`Effects`) nach dem Commit ausführen: Befehle an Runner, Live-Ereignisse an die
 * Projekt-Streams, Audit, Übersicht, Scheduler-Anstoß. Wirft nie (Fehler werden geloggt).
 */
import { sql } from 'drizzle-orm';
import { bestEffort, core, inList, rowsOf, type RequestContext } from '$lib/sdk/server';
import { mdb } from './db';
import type { Effects } from './effects';
import {
	broadcastOverview,
	broadcastProject,
	broadcastRun,
	broadcastTask,
	projectHub,
	sendToRunner
} from './live';
import { chatDto, prDto, runSummaryDto } from './mappers';
import { loadProjectDtos, loadTaskDtos, RUN_SELECT } from './queries';
import { requestDispatch } from './scheduler.service';

/** Anzeigenamen von Konten (Systemkontext, nach der Transaktion) */
export async function userNames(
	ids: Iterable<string | null | undefined>
): Promise<Map<string, string>> {
	const unique = [...new Set(ids)].filter((v): v is string => !!v);
	const map = new Map<string, string>();
	if (!unique.length) return map;
	const users = await core.users.byIds(core.auth.systemContext('aidev'), unique);
	for (const u of users.values()) map.set(u.id, u.name);
	return map;
}

async function liveEvents(fx: Effects): Promise<void> {
	if (!projectHub.openObjects().length) return;
	const pullKeys = [...fx.pulls].map((k) => {
		const i = k.indexOf(':');
		return { projectId: k.slice(0, i), number: Number(k.slice(i + 1)) };
	});
	const data = await mdb().transaction(async (tx) => ({
		tasks: await loadTaskDtos(tx, [...fx.tasks]),
		runs: fx.runs.size
			? await rowsOf(tx, sql`${RUN_SELECT} WHERE r.id IN (${inList([...fx.runs])})`)
			: [],
		chat: fx.chat.size
			? await rowsOf(
					tx,
					sql`SELECT * FROM chat_message WHERE id IN (${inList([...fx.chat])}) ORDER BY created_at, id`
				)
			: [],
		pulls: pullKeys.length
			? await rowsOf(
					tx,
					sql`SELECT * FROM pull_request WHERE ${sql.join(
						pullKeys.map((p) => sql`(project_id = ${p.projectId} AND number = ${p.number})`),
						sql` OR `
					)}`
				)
			: [],
		projects: fx.projects.size
			? await loadProjectDtos(tx, sql`id IN (${inList([...fx.projects])})`)
			: []
	}));
	for (const project of data.projects) broadcastProject(project.id, { type: 'project', project });
	for (const task of data.tasks) broadcastTask(task);
	for (const r of data.runs) {
		broadcastRun(String(r.project_id), { ...runSummaryDto(r), taskId: String(r.task_id) });
	}
	for (const p of data.pulls) broadcastProject(String(p.project_id), { type: 'pr', pr: prDto(p) });
	if (data.chat.length) {
		const names = await userNames(data.chat.map((m) => m.author_user_id as string | null));
		for (const m of data.chat) {
			broadcastProject(String(m.project_id), { type: 'chat', message: chatDto(m, names) });
		}
	}
}

export async function publish(ctx: RequestContext | null, fx: Effects): Promise<void> {
	for (const { runnerId, command } of fx.commands) sendToRunner(runnerId, command);
	for (const d of fx.deletedTasks) {
		broadcastProject(d.projectId, { type: 'task-deleted', taskId: d.taskId });
	}
	await bestEffort('aidev.live.publish', () => liveEvents(fx), { ctx });
	const actor = ctx ?? core.auth.systemContext('aidev');
	for (const a of fx.audits) {
		await bestEffort(
			'aidev.audit',
			() => core.audit.logFromContext(actor, a.action, { target: a.target, metadata: a.metadata }),
			{ ctx: actor, target: a.target ?? null }
		);
	}
	if (fx.overview) broadcastOverview();
	if (fx.dispatch) requestDispatch();
}
