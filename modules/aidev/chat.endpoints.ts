/** Projekt-Chat: Verlauf (neueste zuerst) und neue Nachricht – im Modus `task` wird daraus ein Auftrag. */
import { sql } from 'drizzle-orm';
import { type AnyApiEndpoint, defineEndpoint, rowsOf } from '$lib/sdk/server';
import { mdb, oneOf } from './db';
import { newEffects } from './effects';
import { chatDto } from './mappers';
import { publish, userNames } from './publish.service';
import { loadTaskDto } from './queries';
import { requireProject } from './projects.service';
import { createTask, insertChat } from './tasks.service';
import {
	chatInput,
	chatQuery,
	idParams,
	PERM,
	taskInput,
	type ChatMessageDto,
	type TaskDto
} from './schemas';

const tags = ['Modul: aidev – Chat'];

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
		summary: 'Nachricht senden (Modus `task` legt einen Auftrag an)',
		tags,
		permission: PERM.taskCreate,
		params: idParams,
		body: chatInput,
		handler: async ({
			ctx,
			params,
			body
		}): Promise<{ message: ChatMessageDto; task: TaskDto | null }> => {
			const fx = newEffects();
			const { row, task } = await mdb().transaction(async (tx) => {
				const project = await requireProject(tx, params.id);
				let taskId: string | null = null;
				if (body.mode === 'task' || body.mode === 'question') {
					taskId = await createTask(
						tx,
						fx,
						ctx,
						project,
						taskInput.parse({
							prompt: body.body,
							delivery: body.delivery,
							role: body.mode === 'question' ? 'research' : body.role,
							decompose: body.mode === 'question' ? false : body.decompose,
							providerHint: body.providerHint
						})
					);
				}
				if (body.mode === 'question' && taskId) {
					const history = await rowsOf(
						tx,
						sql`SELECT m.kind, m.body FROM chat_message m
						JOIN task t ON t.id = m.task_id
						WHERE m.project_id = ${params.id} AND t.chat_question = true
						AND m.kind IN ('user', 'agent')
						ORDER BY m.created_at DESC, m.id DESC LIMIT 12`
					);
					const context = history
						.reverse()
						.map(
							(m) =>
								`${m.kind === 'user' ? 'Question' : 'Answer'}: ${String(m.body).slice(0, 2000)}`
						)
						.join('\n\n')
						.slice(-12000);
					await tx.execute(
						sql`UPDATE task SET chat_question = true, chat_context = ${context} WHERE id = ${taskId}`
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
			return { message: chatDto(row, names), task };
		}
	})
];
