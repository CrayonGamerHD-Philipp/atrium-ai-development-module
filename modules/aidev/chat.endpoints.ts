/**
 * Projekt-Chat: Verlauf (neueste zuerst) und neue Nachricht – im Modus `task` wird daraus ein Auftrag, im Modus
 * `question` eine Frage an einen lesenden Agenten; `auto` erkennt Frage/Auftrag regelbasiert (`intent.ts`).
 * „Umsetzen“ (`replyTo`) gibt dem neuen Auftrag eine frühere Antwort samt Frage mit. Aktionsvorschläge eines Agents
 * (`chat_message.actions`) übernimmt oder verwirft ein Mensch über `POST /chat/:id/actions/:index`.
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	defineEndpoint,
	errors,
	isCoreError,
	rowsOf,
	str,
	type RequestContext
} from '$lib/sdk/server';
import { describeChatAction, storedActionsOf, type ChatAction } from './actions';
import { clip, jsonb, mdb, oneOf, type Row, type Tx } from './db';
import { mergeEffects, newEffects, type Effects } from './effects';
import { classifyChatIntent } from './intent';
import { chatDto } from './mappers';
import { publish, userNames } from './publish.service';
import { loadTaskDto } from './queries';
import { requireProject } from './projects.service';
import { cancelTaskAs, createTask, getTask, insertChat, updateTask } from './tasks.service';
import {
	chatActionDecision,
	chatActionParams,
	chatInput,
	chatQuery,
	idParams,
	PERM,
	taskInput,
	type ChatMessageDto,
	type TaskDto,
	type TaskPatch
} from './schemas';

const tags = ['Modul: aidev – Chat'];

/**
 * Bisheriger Frage-/Antwort-Verlauf des Projekts (älteste zuerst) als Kontext für einen neuen Auftrag:
 * die letzten 12 Nachrichten aus Chat-Fragen, je höchstens 2000 und insgesamt 12000 Zeichen.
 * Vor dem Einfügen der neuen Nachricht aufrufen, damit sie nicht selbst im Verlauf steht.
 */
async function chatHistoryContext(tx: Tx, projectId: string): Promise<string> {
	const history = await rowsOf(
		tx,
		sql`SELECT m.kind, m.body FROM chat_message m
			JOIN task t ON t.id = m.task_id
			WHERE m.project_id = ${projectId} AND t.chat_question = true
			AND m.kind IN ('user', 'agent')
			ORDER BY m.created_at DESC, m.id DESC LIMIT 12`
	);
	return history
		.reverse()
		.map((m) => `${m.kind === 'user' ? 'Question' : 'Answer'}: ${String(m.body).slice(0, 2000)}`)
		.join('\n\n')
		.slice(-12000);
}

/** Höchstlänge des Kontextblocks „Referenced answer“ */
const REFERENCE_MAX = 8000;

/** Frage zu einer Agent-Antwort: erste Nutzernachricht zum selben Auftrag */
async function questionOf(tx: Tx, agentMessage: Row): Promise<string | null> {
	const taskId = str(agentMessage.task_id);
	if (!taskId) return null;
	const row = await oneOf(
		tx,
		sql`SELECT body FROM chat_message WHERE task_id = ${taskId} AND kind = 'user'
			ORDER BY created_at, id LIMIT 1`
	);
	return row ? String(row.body) : null;
}

/** Kontextblock mit der Antwort, auf die sich die Person bezieht (Frage + Antwort, gekürzt) */
async function referencedContext(tx: Tx, agentMessage: Row): Promise<string> {
	const question = await questionOf(tx, agentMessage);
	const head = 'Referenced answer (the user refers to this):';
	const q = question ? `Question: ${clip(question, 2000)}\n` : '';
	const budget = Math.max(500, REFERENCE_MAX - head.length - q.length - 10);
	return clip(`${head}\n${q}Answer: ${clip(String(agentMessage.body), budget)}`, REFERENCE_MAX);
}

/** Verlauf und ggf. Kontextblock zu einem `chat_context` verbinden */
const joinContext = (history: string, reference: string) =>
	[history, reference].filter((part) => part.trim()).join('\n\n');

/** Vorschlag ausführen; liefert die ID des angelegten bzw. betroffenen Auftrags */
async function applyChatAction(
	tx: Tx,
	fx: Effects,
	ctx: RequestContext,
	project: Row,
	message: Row,
	action: ChatAction
): Promise<string> {
	if (action.type === 'create') {
		const context = joinContext(
			await chatHistoryContext(tx, String(project.id)),
			await referencedContext(tx, message)
		);
		const id = await createTask(
			tx,
			fx,
			ctx,
			project,
			taskInput.parse({
				title: action.title,
				prompt: action.prompt,
				role: action.role,
				decompose: action.decompose,
				providerHint: action.providerHint,
				targetPr: action.targetPr,
				delivery: 'project'
			})
		);
		await tx.execute(sql`UPDATE task SET chat_context = ${context} WHERE id = ${id}`);
		return id;
	}
	const task = await getTask(tx, action.taskId, true);
	// Aufträge anderer Projekte gelten als unbekannt (Existenz nicht verraten)
	if (!task || String(task.project_id) !== String(project.id)) {
		throw errors.notFound('Auftrag nicht gefunden');
	}
	if (action.type === 'update') {
		const patch: TaskPatch = {};
		if (action.title !== undefined) patch.title = action.title;
		if (action.prompt !== undefined) patch.prompt = action.prompt;
		if (action.priority !== undefined) patch.priority = action.priority;
		if (action.providerHint !== undefined) patch.providerHint = action.providerHint;
		await updateTask(tx, fx, ctx, task, patch);
	} else {
		await cancelTaskAs(tx, fx, ctx, task);
	}
	return String(task.id);
}

export const chatEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/chat',
		summary: 'Chat-Verlauf eines Projekts (neueste zuerst)',
		tags,
		permission: PERM.projectView,
		params: idParams,
		query: chatQuery,
		handler: async ({ params, query }): Promise<ChatMessageDto[]> => {
			const rows = await mdb().transaction(async (tx) => {
				await requireProject(tx, params.id);
				return rowsOf(
					tx,
					sql`SELECT * FROM chat_message WHERE project_id = ${params.id}
						${query.before ? sql`AND created_at < ${query.before}::timestamptz` : sql``}
						ORDER BY created_at DESC, id DESC LIMIT ${query.limit}`
				);
			});
			const names = await userNames(rows.map((r) => r.author_user_id as string | null));
			return rows.map((r) => chatDto(r, names));
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/chat',
		summary: 'Nachricht senden (Modus `task` legt einen Auftrag an, `auto` erkennt Frage/Auftrag)',
		tags,
		permission: PERM.taskCreate,
		params: idParams,
		body: chatInput,
		handler: async ({
			ctx,
			params,
			body
		}): Promise<{
			message: ChatMessageDto;
			task: TaskDto | null;
			mode: 'task' | 'question' | 'note';
		}> => {
			// wirksamer Modus: `auto` wird regelbasiert zu `task` oder `question`
			const mode = body.mode === 'auto' ? classifyChatIntent(body.body).mode : body.mode;
			const fx = newEffects();
			const { row, task } = await mdb().transaction(async (tx) => {
				const project = await requireProject(tx, params.id);
				// „Umsetzen“: Antwort eines Agents in diesem Projekt, auf die sich der Auftrag bezieht
				let reference = '';
				if (mode === 'task' && body.replyTo) {
					const ref = await oneOf(
						tx,
						sql`SELECT * FROM chat_message
							WHERE id = ${body.replyTo} AND project_id = ${params.id} AND kind = 'agent'`
					);
					if (!ref) throw errors.notFound('Nachricht nicht gefunden');
					reference = await referencedContext(tx, ref);
				}
				let taskId: string | null = null;
				if (mode === 'task' || mode === 'question') {
					taskId = await createTask(
						tx,
						fx,
						ctx,
						project,
						taskInput.parse({
							prompt: body.body,
							delivery: body.delivery,
							targetPr: body.targetPr,
							role: mode === 'question' ? 'research' : body.role,
							decompose: mode === 'question' ? false : body.decompose,
							providerHint: body.providerHint
						})
					);
				}
				if (taskId) {
					// Fragen und Aufträge sehen den bisherigen Frage-/Antwort-Verlauf; nur Fragen sind Chat-Fragen
					const context = joinContext(await chatHistoryContext(tx, params.id), reference);
					await tx.execute(
						mode === 'question'
							? sql`UPDATE task SET chat_question = true, chat_context = ${context} WHERE id = ${taskId}`
							: sql`UPDATE task SET chat_context = ${context} WHERE id = ${taskId}`
					);
				}
				const id = await insertChat(tx, fx, {
					projectId: params.id,
					taskId,
					kind: 'user',
					body: body.body,
					authorUserId: ctx.userId
				});
				return {
					row: (await oneOf(tx, sql`SELECT * FROM chat_message WHERE id = ${id}`))!,
					task: taskId ? await loadTaskDto(tx, taskId) : null
				};
			});
			await publish(ctx, fx);
			const names = await userNames([ctx.userId]);
			return { message: chatDto(row, names), task, mode };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/chat/:id/actions/:index',
		summary: 'Aktionsvorschlag eines Agents übernehmen oder verwerfen',
		description:
			'Nur offene Vorschläge (sonst 409). Übernehmen legt einen Auftrag an bzw. ändert oder bricht einen Auftrag desselben Projekts ab (Rechte wie beim direkten Ändern). Erwartete Fehler (z. B. fehlende Rechte, Auftrag beendet) setzen den Vorschlag auf `failed` und liefern die Nachricht trotzdem.',
		tags,
		permission: PERM.taskCreate,
		params: chatActionParams,
		body: chatActionDecision,
		handler: async ({
			ctx,
			params,
			body
		}): Promise<{ message: ChatMessageDto; task: TaskDto | null }> => {
			const fx = newEffects();
			const { row, task } = await mdb().transaction(async (tx) => {
				const message = await oneOf(
					tx,
					sql`SELECT * FROM chat_message WHERE id = ${params.id} FOR UPDATE`
				);
				if (!message || message.kind !== 'agent') throw errors.notFound('Nachricht nicht gefunden');
				const project = await requireProject(tx, String(message.project_id));
				const list = storedActionsOf(message.actions);
				const item = list[params.index];
				if (!item) throw errors.conflict('Diesen Vorschlag gibt es nicht');
				if (item.state !== 'pending') {
					throw errors.conflict('Über diesen Vorschlag wurde bereits entschieden');
				}
				const decided = { decidedBy: ctx.userId ?? null, decidedAt: new Date().toISOString() };
				let taskId: string | null = null;
				if (body.decision === 'reject') {
					list[params.index] = { ...item, ...decided, state: 'rejected' };
				} else {
					const action = item.action;
					const label = describeChatAction(action);
					// eigener Savepoint: ein erwarteter Fehler verwirft nur die Teiländerungen des Vorschlags
					const attempt = newEffects();
					await tx.execute(sql`SAVEPOINT chat_action`);
					let text: string;
					try {
						taskId = await applyChatAction(tx, attempt, ctx, project, message, action);
						await tx.execute(sql`RELEASE SAVEPOINT chat_action`);
						mergeEffects(fx, attempt);
						list[params.index] = { ...item, ...decided, state: 'applied', taskId, error: null };
						const reason = action.type === 'cancel' && action.reason ? ` (${action.reason})` : '';
						text = `Vorschlag übernommen: ${label}${reason}`;
					} catch (e) {
						if (!isCoreError(e)) throw e;
						await tx.execute(sql`ROLLBACK TO SAVEPOINT chat_action`);
						// betroffenen Auftrag nur verlinken, wenn er zu diesem Projekt gehört
						const target = action.type === 'create' ? null : await getTask(tx, action.taskId);
						taskId =
							target && String(target.project_id) === String(project.id) ? String(target.id) : null;
						const error = clip(e.message, 1000);
						list[params.index] = { ...item, ...decided, state: 'failed', taskId, error };
						text = `Vorschlag nicht übernommen: ${label} – ${error}`;
					}
					await insertChat(tx, fx, {
						projectId: String(project.id),
						taskId,
						kind: 'system',
						body: text,
						authorUserId: ctx.userId
					});
				}
				await tx.execute(
					sql`UPDATE chat_message SET actions = ${jsonb(list)} WHERE id = ${message.id}`
				);
				fx.chat.add(String(message.id));
				return {
					row: (await oneOf(tx, sql`SELECT * FROM chat_message WHERE id = ${message.id}`))!,
					task: taskId ? await loadTaskDto(tx, taskId) : null
				};
			});
			await publish(ctx, fx);
			const names = await userNames([str(row.author_user_id)]);
			return { message: chatDto(row, names), task };
		}
	})
];
