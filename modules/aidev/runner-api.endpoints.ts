/**
 * Runner-Schnittstelle (`/api/v1/modules/aidev/runner/...`, Protokoll siehe `protocol.ts`). Nur API-Keys mit
 * `aidev.runner.connect`; Runner-Identität = API-Key (`ctx.actor.id` ↔ `runner.api_key_id`). Läufe und
 * Terminal-Sitzungen anderer Runner sind unsichtbar (404).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	defineEndpoint,
	errors,
	secureFileResponse,
	type RequestContext
} from '$lib/sdk/server';
import { attachmentBytes, getAttachment, taskHasAttachment } from './attachments.service';
import { loadSettings, mdb, oneOf, type Row, type Tx } from './db';
import { newEffects, type Effects } from './effects';
import { runnerHub, terminalEvent, terminalClosed, broadcastProject } from './live';
import {
	checkpointInput,
	eventsInput,
	finishInput,
	heartbeatInput,
	leasesInput,
	limitInput,
	ptyExitInput,
	ptyOutputInput,
	registerInput,
	rejectInput,
	rpcResponseInput,
	usageInput,
	type RunnerCommand
} from './protocol';
import { publish } from './publish.service';
import { resolveRpc } from './rpc.service';
import {
	checkLeases,
	heartbeat,
	registerRunner,
	requireRunner,
	runnerOnline
} from './runners.service';
import {
	acceptRun,
	finishRun,
	recordCheckpoint,
	recordEvents,
	recordLimit,
	recordUsage,
	rejectRun
} from './runs.service';
import { pendingOffers } from './scheduler.service';
import { idParams, PERM, sidParams } from './schemas';

const tags = ['Modul: aidev – Runner'];
const permission = PERM.runnerConnect;
const reqParams = z.object({ reqId: z.string().uuid() });
const attachmentParams = z.object({ id: z.string().uuid(), aid: z.string().uuid() });
const streamQuery = z.object({
	client: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,64}$/)
		.optional()
});

/** Runner laden, Arbeit in einer Transaktion, danach Nebenwirkungen */
async function asRunner<T>(
	ctx: RequestContext,
	fn: (tx: Tx, fx: Effects, runner: Row) => Promise<T>
): Promise<T> {
	const fx = newEffects();
	const result = await mdb().transaction(async (tx) => fn(tx, fx, await requireRunner(tx, ctx)));
	await publish(ctx, fx);
	return result;
}

async function ownSession(tx: Tx, runnerId: string, sid: string): Promise<Row> {
	const s = await oneOf(
		tx,
		sql`SELECT * FROM workspace_session WHERE id = ${sid} AND runner_id = ${runnerId}`
	);
	if (!s) throw errors.notFound('Sitzung nicht gefunden');
	return s;
}

export const runnerApiEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/runner/register',
		summary: 'Runner anmelden bzw. aktualisieren',
		description:
			'Legt den Runner zum API-Key an (Status `pending`, Freigabe durch die Verwaltung) oder aktualisiert Name, Version und Fähigkeiten. Konten werden je Schlüssel übernommen; nicht mehr gemeldete gelten als abgemeldet. `maxSlots` wird übernommen, sobald der Runner einen anderen Wert als bei der letzten Anmeldung meldet; sonst bleibt ein von der Verwaltung gesetzter Wert erhalten.',
		tags,
		permission,
		rateLimit: { limit: 60, windowSec: 60 },
		body: registerInput,
		handler: async ({ ctx, body }) => {
			const fx = newEffects();
			const result = await mdb().transaction((tx) => registerRunner(tx, fx, ctx, body));
			await publish(ctx, fx);
			return result;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/runner/stream',
		summary: 'Befehlsstrom des Runners (Server-Sent Events)',
		description:
			'`text/event-stream` mit `RunnerCommand`-Ereignissen: zuerst `hello`, danach offene Angebote erneut, dann laufend `offer`, `cancel`, `rpc`, `pty-*`, `revoked`. Heartbeat-Kommentar alle 15 s.',
		tags,
		permission,
		rateLimit: { limit: 60, windowSec: 60 },
		query: streamQuery,
		handler: async ({ ctx, query, request }) => {
			const runner = await mdb().transaction((tx) => requireRunner(tx, ctx));
			const runnerId = String(runner.id);
			const subject = `runner:${runnerId}`;
			const client = query.client ?? 'main';
			const existing = runnerHub.get(runnerId, client);
			if (!existing && runnerHub.streamCount(subject) >= 3) throw errors.rateLimited();
			return runnerHub.open({
				ctx,
				request,
				objectId: runnerId,
				client,
				subject,
				level: 'connected',
				peer: { runnerId },
				onOpen: async (push) => {
					const status = String(runner.status) as 'pending' | 'approved' | 'disabled';
					push({ type: 'hello', runnerId, status } satisfies RunnerCommand);
					if (status === 'approved') {
						const settings = await loadSettings();
						const offers = await mdb().transaction((tx) => pendingOffers(tx, runnerId, settings));
						for (const offer of offers) push({ type: 'offer', offer } satisfies RunnerCommand);
					}
					await runnerOnline(runnerId);
				}
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/heartbeat',
		summary: 'Lebenszeichen, Slots und Läufe melden',
		description:
			'Verlängert die Lease der gemeldeten laufenden Läufe (Server-Runner 90 s, PC-Runner 60 s, je Runner einstellbar) und liefert die Läufe, die der Runner abbrechen soll. `handover`: Übergabe läuft (keine neuen Angebote).',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		body: heartbeatInput,
		handler: async ({ ctx, body }) => {
			const fx = newEffects();
			const result = await mdb().transaction((tx) => heartbeat(tx, fx, ctx, body));
			await publish(ctx, fx);
			return result;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/leases',
		summary: 'Leases prüfen (Fencing)',
		description:
			'Prüft je Lauf, ob er noch diesem Runner gehört, angeboten bzw. laufend ist, seine Lease gilt und das Fencing-Token aktuell ist. Der Runner fragt nach dem Aufwachen und vor jedem Push; ungültige Läufe verwirft er, ohne zu pushen. Verlängert nichts.',
		tags,
		permission,
		rateLimit: { limit: 1200, windowSec: 60 },
		body: leasesInput,
		handler: ({ ctx, body }) =>
			asRunner(ctx, (tx, _fx, runner) => checkLeases(tx, String(runner.id), body))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/checkpoint',
		summary: 'WIP-Checkpoint melden',
		description:
			'Zwischenstand eines laufenden Laufs liegt als Commit unter `refs/aidev/wip/<runId>`. Ein späterer Lauf setzt nach einem Ausfall darauf fort. Übernommener Lauf bzw. veraltetes Fencing-Token → 409.',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		params: idParams,
		body: checkpointInput,
		handler: ({ ctx, params, body }) =>
			asRunner(ctx, (tx, fx, runner) =>
				recordCheckpoint(tx, fx, String(runner.id), params.id, body)
			)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/runner/pending',
		summary: 'Offene Angebote dieses Runners',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		handler: async ({ ctx }) => {
			const settings = await loadSettings();
			return mdb().transaction(async (tx) => {
				const runner = await requireRunner(tx, ctx);
				if (runner.status !== 'approved') return [];
				return pendingOffers(tx, String(runner.id), settings);
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/accept',
		summary: 'Angebot annehmen',
		tags,
		permission,
		rateLimit: { limit: 1200, windowSec: 60 },
		params: idParams,
		handler: ({ ctx, params }) =>
			asRunner(ctx, (tx, fx, runner) => acceptRun(tx, fx, String(runner.id), params.id))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/reject',
		summary: 'Angebot ablehnen',
		description: 'Der Auftrag wird ohne dieses Konto neu eingeplant; der Versuch zählt nicht.',
		tags,
		permission,
		rateLimit: { limit: 1200, windowSec: 60 },
		params: idParams,
		body: rejectInput,
		handler: ({ ctx, params, body }) =>
			asRunner(ctx, (tx, fx, runner) =>
				rejectRun(tx, fx, String(runner.id), params.id, body.reason)
			)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/events',
		summary: 'Lauf-Ereignisse hochladen',
		description:
			'Idempotent über `seq` (doppelte werden ignoriert), Texte werden gekürzt, über der Obergrenze je Lauf verworfen. Verlängert die Lease. Mit `fence`: übernommener Lauf bzw. veraltetes Fencing-Token → 409.',
		tags,
		permission,
		rateLimit: { limit: 3000, windowSec: 60 },
		params: idParams,
		body: eventsInput,
		handler: async ({ ctx, params, body }) => {
			const { limits } = await loadSettings();
			const res = await mdb().transaction(async (tx) => {
				const runner = await requireRunner(tx, ctx);
				return recordEvents(tx, String(runner.id), params.id, body.events, limits, body.fence);
			});
			if (res.inserted.length) {
				broadcastProject(String(res.run.project_id), {
					type: 'run-events',
					runId: params.id,
					taskId: String(res.run.task_id),
					events: res.inserted
				});
			}
			return { accepted: res.inserted.length, dropped: res.dropped };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/usage',
		summary: 'Verbrauch eines Laufs melden',
		tags,
		permission,
		rateLimit: { limit: 1200, windowSec: 60 },
		params: idParams,
		body: usageInput,
		handler: ({ ctx, params, body }) =>
			asRunner(ctx, (tx, fx, runner) => recordUsage(tx, fx, String(runner.id), params.id, body))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/limit',
		summary: 'Limit-Treffer melden',
		description:
			'Setzt eine Wartezeit für das Konto (bis `resetsAt`, sonst Backoff 15 → 30 → 60 → 120 min) und kalibriert bei 5-h-/Wochenlimits das Budget.',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		params: idParams,
		body: limitInput,
		handler: ({ ctx, params, body }) =>
			asRunner(ctx, (tx, fx, runner) => recordLimit(tx, fx, String(runner.id), params.id, body))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/runs/:id/finish',
		summary: 'Lauf abschließen',
		description:
			'Ergebnis eines Laufs (Status, Sitzung, Commits, PR, Zusammenfassung, Plan, Fehler). Bestimmt den Folgezustand des Auftrags; Wiederholungen nach dem Abschluss ändern nichts mehr.',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		params: idParams,
		body: finishInput,
		handler: ({ ctx, params, body }) =>
			asRunner(ctx, (tx, fx, runner) => finishRun(tx, fx, String(runner.id), params.id, body))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/runner/runs/:id/attachments/:aid',
		summary: 'Anhang eines Laufs herunterladen',
		description:
			'Bytes eines Anhangs aus `offer.attachments` (binär, `content-disposition: attachment`, `nosniff`). Nur für den Runner des angebotenen bzw. laufenden Laufs und nur Anhänge des Auftrags oder seiner Elternkette; sonst 404. Die Prüfsumme steht im Angebot (`sha256`).',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		params: attachmentParams,
		handler: async ({ ctx, params }) => {
			const { row, bytes } = await mdb().transaction(async (tx) => {
				const runner = await requireRunner(tx, ctx);
				const run = await oneOf(
					tx,
					sql`SELECT task_id FROM run WHERE id = ${params.id} AND runner_id = ${runner.id}
						AND status IN ('offered', 'running')`
				);
				if (!run || !(await taskHasAttachment(tx, String(run.task_id), params.aid))) {
					throw errors.notFound('Anhang nicht gefunden');
				}
				const row = (await getAttachment(tx, params.aid))!;
				return { row, bytes: await attachmentBytes(tx, params.aid) };
			});
			return secureFileResponse(bytes, {
				contentType: String(row.mime),
				size: bytes.byteLength,
				name: String(row.name),
				download: true,
				cache: 'no-store'
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/rpc/:reqId',
		summary: 'Antwort auf einen RPC-Befehl',
		tags,
		permission,
		rateLimit: { limit: 3000, windowSec: 60 },
		params: reqParams,
		body: rpcResponseInput,
		handler: async ({ ctx, params, body }) => {
			const runner = await mdb().transaction((tx) => requireRunner(tx, ctx));
			if (!resolveRpc(String(runner.id), params.reqId, body)) {
				throw errors.notFound('Anfrage unbekannt oder abgelaufen');
			}
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/pty/:sid/output',
		summary: 'Terminal-Ausgabe weiterleiten',
		tags,
		permission,
		rateLimit: { limit: 6000, windowSec: 60 },
		params: sidParams,
		body: ptyOutputInput,
		handler: async ({ ctx, params, body }) => {
			const session = await mdb().transaction(async (tx) => {
				const runner = await requireRunner(tx, ctx);
				return ownSession(tx, String(runner.id), params.sid);
			});
			if (session.closed_at) return { ok: false };
			terminalEvent(params.sid, { type: 'output', seq: body.seq, data: body.data });
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/runner/pty/:sid/exit',
		summary: 'Terminal beendet',
		tags,
		permission,
		rateLimit: { limit: 600, windowSec: 60 },
		params: sidParams,
		body: ptyExitInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const runner = await requireRunner(tx, ctx);
				await ownSession(tx, String(runner.id), params.sid);
				await tx.execute(
					sql`UPDATE workspace_session SET closed_at = COALESCE(closed_at, now()) WHERE id = ${params.sid}`
				);
			});
			terminalEvent(params.sid, { type: 'exit', code: body.code });
			terminalClosed(params.sid);
			return { ok: true };
		}
	})
];
