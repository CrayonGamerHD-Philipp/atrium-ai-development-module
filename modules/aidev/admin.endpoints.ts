/** Übersicht (inkl. Live), Runner, Anbieter-Konten und Routing/Grenzwerte. */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	num,
	str,
	toIsoOrNull
} from '$lib/sdk/server';
import { loadSettings, MAX_STREAMS_PER_USER, mdb, oneOf } from './db';
import { newEffects } from './effects';
import { OVERVIEW_ID, overviewHub, runnerHub } from './live';
import { publish } from './publish.service';
import { deleteRunner, patchRunner } from './runners.service';
import { loadAccountDtos, loadOverview, loadRunnerDtos } from './usage.service';
import {
	accountPatch,
	idParams,
	liveQuery,
	PERM,
	routingPut,
	runnerPatch,
	SETTING_LIMITS,
	SETTING_ROUTING,
	type AccountDto,
	type OverviewDto,
	type OverviewLiveEvent,
	type RoutingPut,
	type RunnerDto
} from './schemas';

const tags = ['Modul: aidev – Verwaltung'];

async function accountDto(id: string): Promise<AccountDto> {
	const [dto] = await mdb().transaction((tx) => loadAccountDtos(tx, sql`a.id = ${id}`));
	if (!dto) throw errors.notFound('Konto nicht gefunden');
	return dto;
}

export const adminEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/overview',
		summary: 'Übersicht: Runner, Konten, Aufträge, aktive Läufe',
		tags,
		permission: PERM.projectView,
		handler: async (): Promise<OverviewDto> => mdb().transaction((tx) => loadOverview(tx))
	}),
	defineEndpoint({
		method: 'GET',
		path: '/overview/live',
		summary: 'Übersicht live (Server-Sent Events)',
		description: '`text/event-stream` mit `hello`, `overview` (entprellt) und `revoked`.',
		tags,
		permission: PERM.projectView,
		query: liveQuery,
		handler: async ({ ctx, query, request }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			if (
				!overviewHub.get(OVERVIEW_ID, query.client) &&
				overviewHub.streamCount(ctx.userId) >= MAX_STREAMS_PER_USER
			) {
				throw errors.rateLimited();
			}
			return overviewHub.open({
				ctx,
				request,
				objectId: OVERVIEW_ID,
				client: query.client,
				level: 'view',
				peer: null,
				onOpen: async (push) => {
					push({ type: 'hello' } satisfies OverviewLiveEvent);
					const overview = await mdb().transaction((tx) => loadOverview(tx));
					push({ type: 'overview', overview } satisfies OverviewLiveEvent);
				}
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/runners',
		summary: 'Runner mit Konten',
		tags,
		permission: PERM.runnerManage,
		handler: async (): Promise<RunnerDto[]> => mdb().transaction((tx) => loadRunnerDtos(tx))
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/runners/:id',
		summary: 'Runner freigeben, sperren, umbenennen, Slots setzen',
		description:
			'Sperren beendet offene und laufende Läufe des Runners (sie werden neu eingeplant) und trennt die Verbindung.',
		tags,
		permission: PERM.runnerManage,
		params: idParams,
		body: runnerPatch,
		handler: async ({ ctx, params, body }): Promise<RunnerDto> => {
			const fx = newEffects();
			const result = await mdb().transaction((tx) => patchRunner(tx, fx, params.id, body));
			await publish(ctx, fx);
			if (result.changedStatus === 'disabled') {
				runnerHub.closeObject(params.id, { type: 'revoked' });
			}
			const [dto] = await mdb().transaction((tx) => loadRunnerDtos(tx, sql`rn.id = ${params.id}`));
			return dto!;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/runners/:id',
		summary: 'Runner entfernen',
		description:
			'Löscht Runner und Konten (inkl. Verbrauch); Läufe bleiben ohne Runner erhalten. Mit demselben API-Key meldet er sich neu (`pending`) an.',
		tags,
		permission: PERM.runnerManage,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const fx = newEffects();
			await mdb().transaction((tx) => deleteRunner(tx, fx, params.id));
			await publish(ctx, fx);
			runnerHub.closeObject(params.id, { type: 'revoked' });
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/accounts',
		summary: 'Anbieter-Konten mit Verbrauch und Auslastung',
		tags,
		permission: PERM.projectView,
		handler: async (): Promise<AccountDto[]> => mdb().transaction((tx) => loadAccountDtos(tx))
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/accounts/:id',
		summary: 'Konto einstellen',
		tags,
		permission: PERM.accountManage,
		params: idParams,
		body: accountPatch,
		handler: async ({ ctx, params, body }): Promise<AccountDto> => {
			await mdb().transaction(async (tx) => {
				const a = await oneOf(
					tx,
					sql`SELECT * FROM provider_account WHERE id = ${params.id} FOR UPDATE`
				);
				if (!a) throw errors.notFound('Konto nicht gefunden');
				const anchor = body.weekAnchor === undefined ? toIsoOrNull(a.week_anchor) : body.weekAnchor;
				await tx.execute(
					sql`UPDATE provider_account SET
							label = ${body.label ?? String(a.label)},
							enabled = ${body.enabled ?? a.enabled === true},
							max_concurrency = ${body.maxConcurrency ?? num(a.max_concurrency)},
							budget_5h_units = ${body.budget5hUnits ?? num(a.budget_5h_units)},
							budget_week_units = ${body.budgetWeekUnits ?? num(a.budget_week_units)},
							calibrated_5h_units = ${body.budget5hUnits !== undefined ? null : str(a.calibrated_5h_units) === null ? null : num(a.calibrated_5h_units)},
							calibrated_week_units = ${body.budgetWeekUnits !== undefined ? null : str(a.calibrated_week_units) === null ? null : num(a.calibrated_week_units)},
							week_anchor = ${anchor}::timestamptz,
							context_k = ${body.contextK ?? num(a.context_k)},
							default_model = ${body.defaultModel ?? String(a.default_model)}
						WHERE id = ${params.id}`
				);
			});
			const fx = newEffects();
			fx.overview = true;
			fx.dispatch = true;
			fx.audits.push({
				action: 'aidev.account.updated',
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			await publish(ctx, fx);
			return accountDto(params.id);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/accounts/:id/clear-cooldown',
		summary: 'Wartezeit eines Kontos aufheben',
		tags,
		permission: PERM.accountManage,
		params: idParams,
		handler: async ({ ctx, params }): Promise<AccountDto> => {
			const row = await mdb().transaction((tx) =>
				oneOf(
					tx,
					sql`UPDATE provider_account SET cooldown_until = NULL, cooldown_reason = NULL,
							cooldown_strikes = 0
						WHERE id = ${params.id} RETURNING id`
				)
			);
			if (!row) throw errors.notFound('Konto nicht gefunden');
			const fx = newEffects();
			fx.overview = true;
			fx.dispatch = true;
			fx.audits.push({
				action: 'aidev.account.updated',
				target: params.id,
				metadata: { fields: ['cooldown'] }
			});
			await publish(ctx, fx);
			return accountDto(params.id);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/routing',
		summary: 'Verteilung der Rollen und Grenzwerte',
		tags,
		permission: PERM.projectView,
		handler: async (): Promise<RoutingPut> => loadSettings()
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/routing',
		summary: 'Verteilung der Rollen und Grenzwerte speichern',
		tags,
		permission: PERM.settingsManage,
		body: routingPut,
		handler: async ({ ctx, body }): Promise<RoutingPut> => {
			await core.permissions.require(ctx, PERM.settingsManage);
			await core.settings.setMany(ctx, {
				[SETTING_ROUTING]: body.routing,
				[SETTING_LIMITS]: body.limits
			});
			const fx = newEffects();
			fx.dispatch = true;
			fx.audits.push({
				action: 'aidev.routing.updated',
				metadata: { roles: Object.keys(body.routing) }
			});
			await publish(ctx, fx);
			return loadSettings();
		}
	})
];
