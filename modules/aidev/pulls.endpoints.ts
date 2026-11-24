/** Pull Requests eines Projekts: Liste, Abgleich über einen Runner, Mergen. */
import { sql } from 'drizzle-orm';
import { type AnyApiEndpoint, defineEndpoint, errors } from '$lib/sdk/server';
import { mdb, oneOf } from './db';
import { newEffects } from './effects';
import { prDto } from './mappers';
import { publish } from './publish.service';
import { loadPullDtos } from './queries';
import { requireProject } from './projects.service';
import { syncPulls } from './pulls.service';
import { callRunner, projectAndRunner, rpcProjectOf } from './rpc.service';
import { idParams, mergeInput, PERM, prParams, type PullRequestDto } from './schemas';

const tags = ['Modul: aidev – Pull Requests'];

export const pullEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/projects/:id/pulls',
		summary: 'Pull Requests eines Projekts (offene zuerst)',
		tags,
		permission: PERM.projectView,
		params: idParams,
		handler: async ({ params }): Promise<PullRequestDto[]> =>
			mdb().transaction(async (tx) => {
				await requireProject(tx, params.id);
				return loadPullDtos(tx, params.id);
			})
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/pulls/sync',
		summary: 'Pull Requests mit GitHub abgleichen (über einen Runner)',
		tags,
		permission: PERM.projectView,
		rateLimit: { limit: 30, windowSec: 60 },
		params: idParams,
		handler: ({ ctx, params }) => syncPulls(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/pulls/:number/merge',
		summary: 'Pull Request mergen (über einen Runner)',
		tags,
		permission: PERM.projectManage,
		params: prParams,
		body: mergeInput,
		handler: async ({ ctx, params, body }): Promise<PullRequestDto> => {
			const { project, runnerId } = await projectAndRunner(params.id, 'main');
			await callRunner(runnerId, 'gh.pr-merge', rpcProjectOf(project), 'main', {
				number: params.number,
				method: body.method
			});
			const fx = newEffects();
			fx.audits.push({
				action: 'aidev.pull.merged',
				target: params.id,
				metadata: { number: params.number, method: body.method }
			});
			await publish(ctx, fx);
			await syncPulls(ctx, params.id);
			const row = await mdb().transaction((tx) =>
				oneOf(
					tx,
					sql`SELECT * FROM pull_request WHERE project_id = ${params.id} AND number = ${params.number}`
				)
			);
			if (!row) throw errors.notFound('Pull Request nicht gefunden');
			return prDto(row);
		}
	})
];
