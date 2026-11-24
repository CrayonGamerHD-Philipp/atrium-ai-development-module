/**
 * Arbeitskopien auf den Runnern (Atrium als Relay, der Browser erreicht Runner nie direkt): Dateien lesen und
 * schreiben, Git-Status, Terminal (pty über den Runner-Hub, Ausgabe über den Terminal-Hub).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AnyApiEndpoint, defineEndpoint, errors, type RequestContext } from '$lib/sdk/server';
import { MAX_STREAMS_PER_USER, mdb, oneOf, type Row, type Tx } from './db';
import { newEffects } from './effects';
import {
	sendToRunner,
	takeTerminalBuffer,
	terminalClosed,
	terminalHub,
	terminalStarted
} from './live';
import { fsListResult, fsReadResult, gitStatusResult } from './protocol';
import { publish } from './publish.service';
import { callRunner, parseResult, projectAndRunner, rpcProjectOf } from './rpc.service';
import {
	fileDeleteInput,
	fileWriteInput,
	idParams,
	PERM,
	sidParams,
	terminalInput,
	terminalOpenInput,
	terminalResize,
	workspaceQuery,
	type FileDto,
	type FsListDto,
	type TerminalDto,
	type TerminalLiveEvent
} from './schemas';

const tags = ['Modul: aidev – Arbeitskopie'];
const terminalLiveQuery = z.object({
	client: z
		.string()
		.regex(/^[A-Za-z0-9_-]{8,64}$/)
		.optional()
});

/** Offene Terminal-Sitzung der aufrufenden Person (fremd/geschlossen → 404) */
async function ownSession(tx: Tx, ctx: RequestContext, sid: string): Promise<Row> {
	const s = await oneOf(
		tx,
		sql`SELECT * FROM workspace_session WHERE id = ${sid} AND kind = 'terminal' AND closed_at IS NULL`
	);
	if (!s || !ctx.userId || String(s.user_id) !== ctx.userId) {
		throw errors.notFound('Terminal-Sitzung nicht gefunden');
	}
	return s;
}

async function fileOp(
	projectId: string,
	target: string,
	op: 'fs.list' | 'fs.read' | 'fs.write' | 'fs.delete' | 'git.status',
	args: Record<string, unknown>
): Promise<unknown> {
	const { project, runnerId } = await projectAndRunner(projectId, target);
	return callRunner(runnerId, op, rpcProjectOf(project), target, args);
}

export const workspaceEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/files',
		summary: 'Verzeichnis einer Arbeitskopie',
		description: '`target` = `main` (Haupt-Branch) oder `run:<id>` (Worktree eines Laufs).',
		tags,
		permission: PERM.files,
		params: idParams,
		query: workspaceQuery,
		handler: async ({ params, query }): Promise<FsListDto> =>
			parseResult(
				fsListResult,
				await fileOp(params.id, query.target, 'fs.list', { path: query.path })
			)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/file',
		summary: 'Datei einer Arbeitskopie lesen',
		tags,
		permission: PERM.files,
		params: idParams,
		query: workspaceQuery,
		handler: async ({ params, query }): Promise<FileDto> => {
			if (!query.path) throw errors.validation([{ path: ['path'], message: 'Pfad fehlt' }]);
			return parseResult(
				fsReadResult,
				await fileOp(params.id, query.target, 'fs.read', { path: query.path })
			);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/projects/:id/file',
		summary: 'Datei einer Arbeitskopie schreiben',
		tags,
		permission: PERM.files,
		params: idParams,
		body: fileWriteInput,
		handler: async ({ ctx, params, body }) => {
			await fileOp(params.id, body.target, 'fs.write', { path: body.path, content: body.content });
			const fx = newEffects();
			fx.audits.push({
				action: 'aidev.workspace.file-written',
				target: params.id,
				metadata: { target: body.target, path: body.path, op: 'write', bytes: body.content.length }
			});
			await publish(ctx, fx);
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/projects/:id/file',
		summary: 'Datei einer Arbeitskopie löschen',
		tags,
		permission: PERM.files,
		params: idParams,
		query: fileDeleteInput,
		handler: async ({ ctx, params, query }) => {
			await fileOp(params.id, query.target, 'fs.delete', { path: query.path });
			const fx = newEffects();
			fx.audits.push({
				action: 'aidev.workspace.file-written',
				target: params.id,
				metadata: { target: query.target, path: query.path, op: 'delete' }
			});
			await publish(ctx, fx);
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/git/status',
		summary: 'Git-Status einer Arbeitskopie',
		tags,
		permission: PERM.files,
		params: idParams,
		query: workspaceQuery,
		handler: async ({ params, query }) =>
			parseResult(gitStatusResult, await fileOp(params.id, query.target, 'git.status', {}))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/terminal',
		summary: 'Terminal auf einem Runner öffnen',
		description:
			'Legt eine Terminal-Sitzung an und öffnet auf dem Runner eine Shell in der Arbeitskopie. Ausgabe über `GET /terminal/:sid/live`.',
		tags,
		permission: PERM.terminal,
		rateLimit: { limit: 30, windowSec: 60 },
		params: idParams,
		body: terminalOpenInput,
		handler: async ({ ctx, params, body }): Promise<TerminalDto> => {
			const { project, runnerId } = await projectAndRunner(params.id, body.target, { pty: true });
			const sid = crypto.randomUUID();
			await mdb().transaction((tx) =>
				tx.execute(
					sql`INSERT INTO workspace_session (id, runner_id, project_id, target, user_id, kind)
						VALUES (${sid}, ${runnerId}, ${params.id}, ${body.target}, ${ctx.userId}, 'terminal')`
				)
			);
			terminalStarted(sid);
			const sent = sendToRunner(runnerId, {
				type: 'pty-open',
				sid,
				project: rpcProjectOf(project),
				target: body.target,
				cols: body.cols,
				rows: body.rows
			});
			if (!sent) {
				await mdb().transaction((tx) =>
					tx.execute(sql`UPDATE workspace_session SET closed_at = now() WHERE id = ${sid}`)
				);
				terminalClosed(sid);
				throw errors.unavailable('Kein Runner erreichbar');
			}
			const fx = newEffects();
			fx.audits.push({
				action: 'aidev.workspace.terminal-opened',
				target: sid,
				metadata: { projectId: params.id, runnerId, target: body.target }
			});
			await publish(ctx, fx);
			return { sid, runnerId, target: body.target };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/terminal/:sid/live',
		summary: 'Terminal-Ausgabe (Server-Sent Events)',
		description:
			'`text/event-stream` mit `TerminalLiveEvent` (`hello`, `output`, `exit`, `error`, `revoked`). Nur für die Person, die das Terminal geöffnet hat.',
		tags,
		permission: PERM.terminal,
		params: sidParams,
		query: terminalLiveQuery,
		handler: async ({ ctx, params, query, request }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			const client = query.client ?? `term-${params.sid.slice(0, 8)}`;
			if (
				!terminalHub.get(params.sid, client) &&
				terminalHub.streamCount(ctx.userId) >= MAX_STREAMS_PER_USER
			) {
				throw errors.rateLimited();
			}
			await mdb().transaction((tx) => ownSession(tx, ctx, params.sid));
			return terminalHub.open({
				ctx,
				request,
				objectId: params.sid,
				client,
				level: 'owner',
				peer: null,
				onOpen: async (push) => {
					push({ type: 'hello', sid: params.sid } satisfies TerminalLiveEvent);
					for (const e of takeTerminalBuffer(params.sid)) push(e);
				}
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/terminal/:sid/input',
		summary: 'Eingabe ans Terminal',
		tags,
		permission: PERM.terminal,
		rateLimit: { limit: 6000, windowSec: 60 },
		params: sidParams,
		body: terminalInput,
		handler: async ({ ctx, params, body }) => {
			const s = await mdb().transaction((tx) => ownSession(tx, ctx, params.sid));
			const ok = sendToRunner(String(s.runner_id), {
				type: 'pty-input',
				sid: params.sid,
				data: body.data
			});
			if (!ok) throw errors.unavailable('Kein Runner erreichbar');
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/terminal/:sid/resize',
		summary: 'Terminalgröße ändern',
		tags,
		permission: PERM.terminal,
		rateLimit: { limit: 600, windowSec: 60 },
		params: sidParams,
		body: terminalResize,
		handler: async ({ ctx, params, body }) => {
			const s = await mdb().transaction((tx) => ownSession(tx, ctx, params.sid));
			const ok = sendToRunner(String(s.runner_id), {
				type: 'pty-resize',
				sid: params.sid,
				cols: body.cols,
				rows: body.rows
			});
			if (!ok) throw errors.unavailable('Kein Runner erreichbar');
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/terminal/:sid',
		summary: 'Terminal schließen',
		tags,
		permission: PERM.terminal,
		params: sidParams,
		handler: async ({ ctx, params }) => {
			const s = await mdb().transaction(async (tx) => {
				const row = await ownSession(tx, ctx, params.sid);
				await tx.execute(
					sql`UPDATE workspace_session SET closed_at = now() WHERE id = ${params.sid}`
				);
				return row;
			});
			sendToRunner(String(s.runner_id), { type: 'pty-close', sid: params.sid });
			terminalClosed(params.sid, { type: 'exit', code: null });
			return { ok: true };
		}
	})
];
