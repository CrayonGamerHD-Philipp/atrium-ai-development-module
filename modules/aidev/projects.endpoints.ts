/** Projekte (GitHub-Repos): Liste, Anlegen, Ändern, Archivieren, Prüfen über einen Runner, Live-Stream. */
import { sql } from 'drizzle-orm';
import { type AnyApiEndpoint, defineEndpoint, errors } from '$lib/sdk/server';
import { MAX_STREAMS_PER_USER, mdb } from './db';
import { newEffects } from './effects';
import { projectHub } from './live';
import { repoCheckResult } from './protocol';
import { loadProjectDto, loadProjectDtos } from './queries';
import { publish } from './publish.service';
import { callRunner, parseResult, projectAndRunner, rpcProjectOf } from './rpc.service';
import {
	assertNoDuplicate,
	assertRunnerExists,
	requireProject,
	requireRepo
} from './projects.service';
import {
	idParams,
	liveQuery,
	PERM,
	projectInput,
	projectPatch,
	type ProjectDto,
	type ProjectLiveEvent
} from './schemas';

const tags = ['Modul: aidev – Projekte'];

export const projectEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/projects',
		summary: 'Projekte (nicht archiviert)',
		tags,
		permission: PERM.projectView,
		handler: async (): Promise<ProjectDto[]> =>
			mdb().transaction((tx) => loadProjectDtos(tx, sql`archived_at IS NULL`))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects',
		summary: 'Projekt anlegen',
		description:
			'`repo` als `owner/repo`, `https://github.com/owner/repo(.git)` oder `git@github.com:owner/repo.git`. Doppelte Repos → 409.',
		tags,
		permission: PERM.projectManage,
		body: projectInput,
		handler: async ({ ctx, body }): Promise<ProjectDto> => {
			const repo = requireRepo(body.repo);
			const fx = newEffects();
			const id = crypto.randomUUID();
			const dto = await mdb().transaction(async (tx) => {
				await assertNoDuplicate(tx, repo.owner, repo.name);
				await assertRunnerExists(tx, body.preferredRunnerId);
				await tx.execute(
					sql`INSERT INTO project (id, name, repo_owner, repo_name, default_branch, commit_policy,
							max_parallel, setup_cmd, test_cmd, instructions, preferred_runner_id, created_by)
						VALUES (${id}, ${body.name}, ${repo.owner}, ${repo.name}, ${body.defaultBranch},
							${body.commitPolicy}, ${body.maxParallel}, ${body.setupCmd}, ${body.testCmd},
							${body.instructions}, ${body.preferredRunnerId}, ${ctx.userId})`
				);
				return (await loadProjectDto(tx, id))!;
			});
			fx.audits.push({
				action: 'aidev.project.created',
				target: id,
				metadata: { repo: `${repo.owner}/${repo.name}`, commitPolicy: body.commitPolicy }
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id',
		summary: 'Projekt',
		tags,
		permission: PERM.projectView,
		params: idParams,
		handler: async ({ params }): Promise<ProjectDto> => {
			const dto = await mdb().transaction((tx) => loadProjectDto(tx, params.id));
			if (!dto) throw errors.notFound('Projekt nicht gefunden');
			return dto;
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/projects/:id',
		summary: 'Projekt ändern',
		tags,
		permission: PERM.projectManage,
		params: idParams,
		body: projectPatch,
		handler: async ({ ctx, params, body }): Promise<ProjectDto> => {
			const fx = newEffects();
			const dto = await mdb().transaction(async (tx) => {
				const p = await requireProject(tx, params.id, true);
				if (body.preferredRunnerId !== undefined) {
					await assertRunnerExists(tx, body.preferredRunnerId);
				}
				await tx.execute(
					sql`UPDATE project SET
							name = ${body.name ?? String(p.name)},
							default_branch = ${body.defaultBranch ?? String(p.default_branch)},
							commit_policy = ${body.commitPolicy ?? String(p.commit_policy)},
							max_parallel = ${body.maxParallel ?? Number(p.max_parallel)},
							setup_cmd = ${body.setupCmd ?? String(p.setup_cmd)},
							test_cmd = ${body.testCmd ?? String(p.test_cmd)},
							instructions = ${body.instructions ?? String(p.instructions)},
							preferred_runner_id = ${body.preferredRunnerId === undefined ? (p.preferred_runner_id as string | null) : body.preferredRunnerId},
							updated_at = now()
						WHERE id = ${params.id}`
				);
				return (await loadProjectDto(tx, params.id))!;
			});
			fx.projects.add(params.id);
			fx.dispatch = true;
			fx.audits.push({
				action: 'aidev.project.updated',
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			await publish(ctx, fx);
			return dto;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/projects/:id',
		summary: 'Projekt archivieren',
		description:
			'Setzt `archivedAt`; wartende Aufträge werden nicht mehr eingeplant, laufende enden regulär.',
		tags,
		permission: PERM.projectManage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const fx = newEffects();
			await mdb().transaction(async (tx) => {
				await requireProject(tx, params.id, true);
				await tx.execute(
					sql`UPDATE project SET archived_at = COALESCE(archived_at, now()), updated_at = now()
						WHERE id = ${params.id}`
				);
			});
			fx.projects.add(params.id);
			fx.overview = true;
			fx.audits.push({ action: 'aidev.project.archived', target: params.id });
			await publish(ctx, fx);
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/check',
		summary: 'Repo-Zugriff über einen Runner prüfen',
		tags,
		permission: PERM.projectManage,
		params: idParams,
		handler: async ({ params }) => {
			const { project, runnerId } = await projectAndRunner(params.id, 'main');
			const result = parseResult(
				repoCheckResult,
				await callRunner(runnerId, 'repo.check', rpcProjectOf(project), 'main')
			);
			return {
				ok: result.ok,
				message: result.message,
				defaultBranch: result.defaultBranch,
				canPush: result.canPush
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/live',
		summary: 'Live-Ereignisse eines Projekts (Server-Sent Events)',
		description:
			'`text/event-stream` mit `ProjectLiveEvent` (`hello`, `task`, `task-deleted`, `run`, `run-events`, `chat`, `pr`, `project`, `access`, `revoked`), Heartbeat alle 20 s. Verpasste Lauf-Ereignisse über `GET /runs/:id/events?afterSeq=` nachladen.',
		tags,
		permission: PERM.projectView,
		params: idParams,
		query: liveQuery,
		handler: async ({ ctx, params, query, request }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			if (
				!projectHub.get(params.id, query.client) &&
				projectHub.streamCount(ctx.userId) >= MAX_STREAMS_PER_USER
			) {
				throw errors.rateLimited();
			}
			await mdb().transaction((tx) => requireProject(tx, params.id));
			return projectHub.open({
				ctx,
				request,
				objectId: params.id,
				client: query.client,
				level: 'view',
				peer: null,
				onOpen: async (push) => {
					push({ type: 'hello', projectId: params.id } satisfies ProjectLiveEvent);
				}
			});
		}
	})
];
