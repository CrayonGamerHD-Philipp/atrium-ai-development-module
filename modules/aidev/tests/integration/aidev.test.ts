/**
 * Modul `aidev`: Runner-Protokoll und Steuerzentrale gegen PGlite.
 * Anmelden → Freigabe → Projekt + Auftrag → Angebot (pending) → Annahme → Ereignisse (doppelte seq ignoriert) →
 * Verbrauch → Abschluss mit PR (Auftrag `review`, pull_request); Lease-Ablauf → Job → neu eingeplant;
 * Limit → Wartezeit → zweites Konto übernimmt; Orchestrierung → Teilaufträge mit Abhängigkeiten → Ausliefern;
 * Zyklus im Plan abgelehnt; Konflikt → Konfliktlösung; Rechte; SSE (Projekt, Runner) inkl. RPC über den Stream.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
	adminContext,
	apiCall,
	contextForUser,
	core,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	handleApiRequest,
	registerCoreApi,
	registerModule,
	resetAllForTests,
	runJobNow,
	syncModules,
	systemContext,
	useTestDatabase,
	type ApiResult
} from '$testing';
import aidevModule from '$modules/aidev/module';
import { closeAllLive } from '$modules/aidev/live';
import { dispatch, startScheduler, whenDispatchIdle } from '$modules/aidev/scheduler.service';
import type { RunOffer, RunnerCommand } from '$modules/aidev/protocol';
import {
	DEFAULT_LIMITS,
	DEFAULT_ROUTING,
	type AccountDto,
	type ChatMessageDto,
	type ProjectDto,
	type PullRequestDto,
	type RunEventDto,
	type RunnerDto,
	type Routing,
	type TaskDetailDto,
	type TaskDto
} from '$modules/aidev/schemas';
import type { RequestContext } from '$lib/sdk/types';

const M = '/modules/aidev';
const keys: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;
let projectId: string;
let runnerId: string;

const q = <T>(query: ReturnType<typeof sql>) =>
	core.database
		.forModule('aidev')
		.transaction(async (tx) => (await tx.execute(query)) as unknown as { rows: T[] })
		.then((r) => r.rows);

function ok<T>(res: ApiResult<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

const call = <T = unknown>(who: string, method: string, path: string, json?: unknown) =>
	apiCall<T>(keys[who]!, method, `${M}${path}`, json);

async function technicalKey(name: string, roleId: string, scopes: string[]) {
	const id = await createUser(admin, {
		name,
		email: `${name}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	const ctx = (await contextForUser(id))!.ctx;
	keys[name] = (await createApiKey(ctx, { name, scopes })).key;
}

const register = (who: string, accounts: string[]) =>
	call<{ runnerId: string; status: string; heartbeatSec: number }>(
		who,
		'POST',
		'/runner/register',
		{
			protocol: 1,
			name: `Runner ${who}`,
			version: '0.1.0',
			maxSlots: 4,
			capabilities: { git: true, gh: true, pty: true, os: 'linux' },
			accounts: accounts.map((key) => ({
				key,
				provider: 'fake',
				label: key,
				loggedIn: true,
				models: []
			}))
		}
	);

const heartbeat = (who: string, runIds: string[] = []) =>
	call<{ status: string; cancel: string[] }>(who, 'POST', '/runner/heartbeat', {
		slotsUsed: runIds.length,
		runIds
	});

/** Scheduler laufen lassen und offene Angebote des Runners holen */
async function offers(who = 'runner'): Promise<RunOffer[]> {
	await whenDispatchIdle();
	await dispatch();
	await whenDispatchIdle();
	return ok<RunOffer[]>(await call(who, 'GET', '/runner/pending'));
}

async function offerFor(taskId: string, who = 'runner'): Promise<RunOffer> {
	const list = await offers(who);
	const offer = list.find((o) => o.taskId === taskId);
	expect(
		offer,
		`kein Angebot für ${taskId}: ${JSON.stringify(list.map((o) => o.taskId))}`
	).toBeTruthy();
	return offer!;
}

const task = async (id: string) => ok<TaskDetailDto>(await call('admin', 'GET', `/tasks/${id}`));

async function createTask(body: Record<string, unknown>): Promise<TaskDto> {
	return ok<TaskDto>(await call('admin', 'POST', `/projects/${projectId}/tasks`, body), 201);
}

const finish = (runId: string, body: Record<string, unknown>, who = 'runner') =>
	call<{ ok: boolean; taskStatus: string }>(who, 'POST', `/runner/runs/${runId}/finish`, body);

/** SSE-Verbindung öffnen und Ereignisse mitschreiben */
async function openStream<E extends { type: string }>(key: string, path: string) {
	resetAllForTests();
	const ac = new AbortController();
	const url = new URL(`http://localhost:5173/api/v1${M}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			headers: { authorization: `Bearer ${key}` },
			signal: ac.signal
		}),
		url,
		ip: '127.0.0.1'
	});
	const events: E[] = [];
	if (res.status === 200 && res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf('\n\n')) >= 0) {
						const chunk = buf.slice(0, i);
						buf = buf.slice(i + 2);
						for (const line of chunk.split('\n')) {
							if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as E);
						}
					}
				}
			} catch {
				// abgebrochen
			}
		})();
	}
	const waitFor = (type: string, pred: (e: E) => boolean = () => true) =>
		vi.waitFor(
			() => {
				const hit = events.find((e) => e.type === type && pred(e));
				expect(
					hit,
					`Ereignis ${type} – bisher: ${events.map((e) => e.type).join(',')}`
				).toBeTruthy();
				return hit!;
			},
			{ timeout: 3000 }
		);
	return { res, events, waitFor, close: () => ac.abort() };
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(aidevModule);
	await syncModules();
	admin = await adminContext('admin@example.test', 'correct-horse-battery');
	await enableModule(admin, 'aidev');
	admin = (await contextForUser(admin.userId!))!.ctx;
	startScheduler();
	keys.admin = (
		await createApiKey(admin, { name: 'admin', scopes: [...aidevModule.manifest.permissions] })
	).key;
	const runnerRole = await createRole(admin, {
		name: 'KI-Runner',
		permissions: ['aidev.runner.connect', 'core.api.manage']
	});
	await technicalKey('runner', runnerRole, ['aidev.runner.connect']);
	await technicalKey('runner2', runnerRole, ['aidev.runner.connect']);
	const plainRole = await createRole(admin, { name: 'Ohne KI', permissions: ['core.api.manage'] });
	await technicalKey('viewer', plainRole, ['core.api.manage']);
	const creatorRole = await createRole(admin, {
		name: 'KI-Nutzer',
		permissions: ['aidev.project.view', 'aidev.task.create', 'core.api.manage']
	});
	await technicalKey('creator', creatorRole, ['aidev.project.view', 'aidev.task.create']);
}, 60_000);

afterAll(async () => {
	await whenDispatchIdle();
	closeAllLive();
	await close?.();
});

describe('aidev', () => {
	it('Runner meldet sich an, Verwaltung gibt frei', async () => {
		const reg = ok(await register('runner', ['fake-a', 'fake-b']), 201);
		expect(reg).toMatchObject({ status: 'pending', heartbeatSec: 15 });
		runnerId = reg.runnerId;
		// erneute Anmeldung: gleicher Runner, Slots bleiben beim Admin-Wert
		const again = ok(await register('runner', ['fake-a', 'fake-b']), 201);
		expect(again.runnerId).toBe(runnerId);
		expect(ok(await heartbeat('runner'), 201).status).toBe('pending');
		expect(ok(await call('runner', 'GET', '/runner/pending'))).toEqual([]);

		const runners = ok<RunnerDto[]>(await call('admin', 'GET', '/runners'));
		expect(runners).toHaveLength(1);
		expect(runners[0]!.accounts.map((a) => a.key).sort()).toEqual(['fake-a', 'fake-b']);
		const approved = ok<RunnerDto>(
			await call('admin', 'PATCH', `/runners/${runnerId}`, { status: 'approved' })
		);
		expect(approved.status).toBe('approved');
		expect(ok(await heartbeat('runner'), 201).status).toBe('approved');

		// Verteilung: Test-Agent für alle Rollen
		const routing = Object.fromEntries(
			Object.entries(DEFAULT_ROUTING).map(([role, list]) => [
				role,
				[{ provider: 'fake', weight: 10 }, ...list]
			])
		) as Routing;
		const put = ok<{ routing: Routing }>(
			await call('admin', 'PUT', '/routing', { routing, limits: DEFAULT_LIMITS })
		);
		expect(put.routing.implement[0]!.provider).toBe('fake');
	});

	it('Projekt anlegen: Repo-Formen, Duplikat, ungültig', async () => {
		const p = ok<ProjectDto>(
			await call('admin', 'POST', '/projects', {
				name: 'Widgets',
				repo: 'https://github.com/acme/widgets.git'
			}),
			201
		);
		expect(p).toMatchObject({ repoOwner: 'acme', repoName: 'widgets', commitPolicy: 'pr' });
		projectId = p.id;
		const dup = await call('admin', 'POST', '/projects', {
			name: 'Doppelt',
			repo: 'git@github.com:Acme/Widgets.git'
		});
		expect(dup.status).toBe(409);
		const bad = await call('admin', 'POST', '/projects', { name: 'X', repo: 'kein repo' });
		expect(bad.status).toBe(422);
		// PATCH ohne Felder setzt nichts zurück
		const patched = ok<ProjectDto>(
			await call('admin', 'PATCH', `/projects/${projectId}`, { maxParallel: 3 })
		);
		expect(patched).toMatchObject({ maxParallel: 3, commitPolicy: 'pr', defaultBranch: 'main' });
	});

	let firstRunId = '';

	it('Auftrag → Angebot → Annahme → Ereignisse → Verbrauch → Abschluss mit PR', async () => {
		const t = await createTask({ prompt: 'Füge eine README mit Installationsanleitung hinzu' });
		expect(t.status).toBe('queued');
		const offer = await offerFor(t.id);
		firstRunId = offer.runId;
		expect(offer).toMatchObject({
			role: 'implement',
			readOnly: false,
			expectPlan: false,
			baseRef: 'main',
			account: { provider: 'fake' },
			leaseSec: 90,
			timeoutSec: DEFAULT_LIMITS.runTimeoutMin * 60
		});
		expect(offer.branch).toMatch(/^aidev\/[0-9a-f]{8}-/);
		expect(offer.delivery).toMatchObject({ mode: 'pr', autoMerge: false });
		expect(offer.delivery.mode === 'pr' && offer.delivery.body).toContain(`Aidev-Task: ${t.id}`);
		expect(offer.prompt.length).toBeGreaterThan(0);
		expect((await task(t.id)).task.status).toBe('queued');

		ok(await call('runner', 'POST', `/runner/runs/${offer.runId}/accept`), 201);
		expect((await task(t.id)).task.status).toBe('running');

		const ts = new Date().toISOString();
		const e1 = ok<{ accepted: number }>(
			await call('runner', 'POST', `/runner/runs/${offer.runId}/events`, {
				events: [
					{ seq: 0, ts, kind: 'status', payload: { text: 'Start' } },
					{ seq: 1, ts, kind: 'text', payload: { text: 'x'.repeat(20_000) } }
				]
			}),
			201
		);
		expect(e1.accepted).toBe(2);
		const e2 = ok<{ accepted: number }>(
			await call('runner', 'POST', `/runner/runs/${offer.runId}/events`, {
				events: [
					{ seq: 1, ts, kind: 'text', payload: { text: 'doppelt' } },
					{ seq: 2, ts, kind: 'tool', payload: { name: 'edit', input: { file: 'README.md' } } }
				]
			}),
			201
		);
		expect(e2.accepted).toBe(1);
		const events = ok<RunEventDto[]>(await call('admin', 'GET', `/runs/${offer.runId}/events`));
		expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
		expect(String(events[1]!.payload.text).length).toBeLessThanOrEqual(16_000);
		const after = ok<RunEventDto[]>(
			await call('admin', 'GET', `/runs/${offer.runId}/events?afterSeq=1`)
		);
		expect(after.map((e) => e.seq)).toEqual([2]);

		const reserved = await q<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM usage_ledger WHERE run_id = ${offer.runId} AND source = 'reserved'`
		);
		expect(Number(reserved[0]!.n)).toBe(1);
		ok(
			await call('runner', 'POST', `/runner/runs/${offer.runId}/usage`, {
				model: 'fake-1',
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 1000
			}),
			201
		);
		const ledger = await q<{ source: string; units: number }>(
			sql`SELECT source, units FROM usage_ledger WHERE run_id = ${offer.runId}`
		);
		expect(ledger.map((l) => l.source)).toEqual(['reported']);
		expect(Number(ledger[0]!.units)).toBe(1600);

		const fin = ok(
			await finish(offer.runId, {
				status: 'succeeded',
				sessionId: 'sess-1',
				headSha: 'abcdef1',
				branch: offer.branch,
				commits: [
					{ sha: 'abcdef1', message: 'README', additions: 10, deletions: 0, files: ['README.md'] }
				],
				pr: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
				summary: 'README angelegt'
			}),
			201
		);
		expect(fin.taskStatus).toBe('review');
		// Wiederholung des Abschlusses ändert nichts
		expect(ok(await finish(offer.runId, { status: 'failed' }), 201).taskStatus).toBe('review');

		const detail = await task(t.id);
		expect(detail.task).toMatchObject({
			status: 'review',
			prNumber: 7,
			resultSummary: 'README angelegt',
			branch: offer.branch
		});
		expect(detail.runs[0]).toMatchObject({ status: 'succeeded', units: 1600, eventCount: 3 });
		expect(detail.runs[0]!.commits.map((c) => c.sha)).toEqual(['abcdef1']);
		expect(detail.pullRequest).toMatchObject({ number: 7, state: 'open', taskId: t.id });
		const pulls = ok<PullRequestDto[]>(await call('admin', 'GET', `/projects/${projectId}/pulls`));
		expect(pulls.map((p) => p.number)).toEqual([7]);
		const chat = ok<ChatMessageDto[]>(await call('admin', 'GET', `/projects/${projectId}/chat`));
		expect(chat[0]).toMatchObject({ kind: 'agent', taskId: t.id });
		expect(chat[0]!.body).toContain('#7');
	});

	it('Lease läuft ab → Job stellt zurück und plant neu ein', async () => {
		const t = await createTask({ prompt: 'Lease-Test' });
		const offer = await offerFor(t.id);
		ok(await call('runner', 'POST', `/runner/runs/${offer.runId}/accept`), 201);
		// Heartbeat verlängert die Lease
		const hb = ok(await heartbeat('runner', [offer.runId, firstRunId]), 201);
		expect(hb.cancel).toEqual([firstRunId]);
		await q(
			sql`UPDATE run SET lease_expires_at = now() - interval '1 second' WHERE id = ${offer.runId}`
		);
		await runJobNow(systemContext('test'), 'aidev.scheduler');
		await whenDispatchIdle();
		const detail = await task(t.id);
		const lost = detail.runs.find((r) => r.id === offer.runId)!;
		expect(lost.status).toBe('lost');
		expect(detail.task.attempts).toBe(2);
		expect(detail.runs[0]).toMatchObject({ status: 'offered', attempt: 2 });
		// aufräumen: Abbruch beendet das Angebot sofort
		const cancelled = ok<TaskDto>(await call('admin', 'POST', `/tasks/${t.id}/cancel`), 201);
		expect(cancelled.status).toBe('cancelled');
		expect((await task(t.id)).runs[0]!.status).toBe('cancelled');
	});

	it('Limit → Wartezeit → zweites Konto übernimmt', async () => {
		const t = await createTask({ prompt: 'Limit-Test' });
		const first = await offerFor(t.id);
		ok(await call('runner', 'POST', `/runner/runs/${first.runId}/accept`), 201);
		ok(
			await call('runner', 'POST', `/runner/runs/${first.runId}/usage`, {
				inputTokens: 5000,
				outputTokens: 1000
			}),
			201
		);
		const resetsAt = new Date(Date.now() + 3600_000).toISOString();
		ok(
			await call('runner', 'POST', `/runner/runs/${first.runId}/limit`, {
				kind: '5h',
				resetsAt,
				raw: 'usage limit reached'
			}),
			201
		);
		const fin = ok(
			await finish(first.runId, { status: 'limited', errorKind: 'limit', errorMessage: 'Limit' }),
			201
		);
		expect(fin.taskStatus).toBe('queued');
		const accounts = ok<AccountDto[]>(await call('admin', 'GET', '/accounts'));
		const limited = accounts.find((a) => a.key === first.account.key)!;
		expect(limited.cooldownUntil).toBe(resetsAt);
		expect(limited.cooldownReason).toContain('5-Stunden');
		expect(limited.effective5hUnits).toBeGreaterThan(0);

		const second = await offerFor(t.id);
		expect(second.account.key).not.toBe(first.account.key);
		expect((await task(t.id)).task.attempts).toBe(1);
		ok(await call('runner', 'POST', `/runner/runs/${second.runId}/accept`), 201);
		expect(
			ok(await finish(second.runId, { status: 'succeeded', summary: 'ok' }), 201).taskStatus
		).toBe('done');
		// Wartezeit aufheben
		const cleared = ok<AccountDto>(
			await call('admin', 'POST', `/accounts/${limited.id}/clear-cooldown`),
			201
		);
		expect(cleared.cooldownUntil).toBeNull();
	});

	it('Orchestrierung: Plan → Teilaufträge mit Abhängigkeiten → Ausliefern', async () => {
		const parent = await createTask({ prompt: 'Großes Feature', decompose: true });
		expect(parent.role).toBe('orchestrate');
		const plan = await offerFor(parent.id);
		expect(plan).toMatchObject({ role: 'orchestrate', readOnly: true, expectPlan: true });
		expect(plan.delivery.mode).toBe('none');
		ok(await call('runner', 'POST', `/runner/runs/${plan.runId}/accept`), 201);
		ok(
			await finish(plan.runId, {
				status: 'succeeded',
				summary: 'Plan erstellt',
				plan: {
					summary: 'Erst recherchieren, dann bauen',
					subtasks: [
						{ key: 'a', title: 'Recherche', prompt: 'Recherchiere', role: 'research' },
						{ key: 'b', title: 'Umsetzung', prompt: 'Baue es', role: 'implement', dependsOn: ['a'] }
					]
				}
			}),
			201
		);
		const d = await task(parent.id);
		expect(d.task.status).toBe('blocked');
		expect(d.task.branch).toMatch(/^aidev\/[0-9a-f]{8}-/);
		expect(d.children.map((c) => [c.position, c.role, c.status])).toEqual([
			[0, 'research', 'queued'],
			[1, 'implement', 'queued']
		]);
		const [a, b] = d.children;
		expect(b!.dependsOn).toEqual([a!.id]);

		// nur a ist einplanbar (b wartet auf a)
		const list = await offers();
		expect(list.map((o) => o.taskId)).toContain(a!.id);
		expect(list.map((o) => o.taskId)).not.toContain(b!.id);
		const oa = list.find((o) => o.taskId === a!.id)!;
		expect(oa).toMatchObject({ role: 'research', readOnly: true });
		ok(await call('runner', 'POST', `/runner/runs/${oa.runId}/accept`), 201);
		ok(await finish(oa.runId, { status: 'succeeded', summary: 'Ergebnis der Recherche' }), 201);

		const ob = await offerFor(b!.id);
		expect(ob.branch).toMatch(new RegExp(`^aidev/${parent.id.replace(/-/g, '').slice(0, 8)}/2-`));
		expect(ob.baseRef).toBe(d.task.branch);
		expect(ob.delivery).toEqual({ mode: 'integrate', integrationBranch: d.task.branch });
		expect(ob.prompt).toContain('Ergebnis der Recherche');
		ok(await call('runner', 'POST', `/runner/runs/${ob.runId}/accept`), 201);
		ok(await finish(ob.runId, { status: 'succeeded', summary: 'gebaut', merged: true }), 201);

		// alle Teilaufträge fertig → Ausliefern auf dem Integrations-Branch
		expect((await task(parent.id)).task.status).toBe('queued');
		const deliver = await offerFor(parent.id);
		expect(deliver).toMatchObject({
			role: 'implement',
			readOnly: false,
			branch: d.task.branch,
			baseRef: 'main'
		});
		expect(deliver.delivery.mode).toBe('pr');
		ok(await call('runner', 'POST', `/runner/runs/${deliver.runId}/accept`), 201);
		ok(
			await finish(deliver.runId, {
				status: 'succeeded',
				summary: 'ausgeliefert',
				pr: { number: 9, url: 'https://github.com/acme/widgets/pull/9' }
			}),
			201
		);
		expect((await task(parent.id)).task).toMatchObject({ status: 'review', prNumber: 9 });
	});

	it('Plan mit Zyklus wird abgelehnt', async () => {
		const parent = await createTask({ prompt: 'Zyklus', decompose: true, maxAttempts: 1 });
		const o = await offerFor(parent.id);
		ok(await call('runner', 'POST', `/runner/runs/${o.runId}/accept`), 201);
		const fin = ok(
			await finish(o.runId, {
				status: 'succeeded',
				plan: {
					subtasks: [
						{ key: 'a', title: 'A', prompt: 'A', role: 'implement', dependsOn: ['b'] },
						{ key: 'b', title: 'B', prompt: 'B', role: 'implement', dependsOn: ['a'] }
					]
				}
			}),
			201
		);
		expect(fin.taskStatus).toBe('failed');
		const d = await task(parent.id);
		expect(d.task.errorMessage).toContain('Zyklus');
		expect(d.children).toHaveLength(0);
	});

	it('Konflikt → Konfliktlösung übernimmt das Ergebnis', async () => {
		const t = await createTask({ prompt: 'Konflikt-Test' });
		const o = await offerFor(t.id);
		ok(await call('runner', 'POST', `/runner/runs/${o.runId}/accept`), 201);
		ok(
			await finish(o.runId, {
				status: 'failed',
				errorKind: 'conflict',
				errorMessage: 'Merge-Konflikt',
				conflictFiles: ['src/a.ts'],
				branch: o.branch
			}),
			201
		);
		const d = await task(t.id);
		expect(d.task.status).toBe('blocked');
		const resolve = d.children.find((c) => c.role === 'resolve')!;
		expect(resolve.status).toBe('queued');
		const ro = await offerFor(resolve.id);
		expect(ro).toMatchObject({ role: 'resolve', branch: o.branch, readOnly: false });
		expect(ro.delivery.mode).toBe('pr');
		ok(await call('runner', 'POST', `/runner/runs/${ro.runId}/accept`), 201);
		ok(
			await finish(ro.runId, {
				status: 'succeeded',
				pr: { number: 11, url: 'https://github.com/acme/widgets/pull/11' }
			}),
			201
		);
		expect((await task(t.id)).task).toMatchObject({ status: 'review', prNumber: 11 });
		expect((await task(resolve.id)).task.status).toBe('done');
	});

	it('Rechte: Runner-Key, fremder Runner, Person ohne Projektrecht, fremde Aufträge', async () => {
		expect((await call('runner', 'GET', '/projects')).status).toBe(403);
		expect(
			(await call('admin', 'POST', '/runner/heartbeat', { slotsUsed: 0, runIds: [] })).status
		).toBe(404);
		ok(await register('runner2', ['fake-x']), 201);
		const foreign = await finish(firstRunId, { status: 'succeeded' }, 'runner2');
		expect(foreign.status).toBe(404);
		expect((await call('runner2', 'POST', `/runner/runs/${firstRunId}/accept`)).status).toBe(404);
		expect((await call('viewer', 'GET', '/projects')).status).toBe(403);
		expect((await call('viewer', 'GET', '/runner/pending')).status).toBe(403);
		// eigene Aufträge ja, fremde nein
		const own = ok<TaskDto>(
			await call('creator', 'POST', `/projects/${projectId}/tasks`, {
				prompt: 'Eigener Auftrag',
				draft: true
			}),
			201
		);
		expect(own.status).toBe('draft');
		ok(await call('creator', 'PATCH', `/tasks/${own.id}`, { priority: 2 }));
		const foreignTask = await createTask({ prompt: 'Fremd', draft: true });
		expect((await call('creator', 'POST', `/tasks/${foreignTask.id}/cancel`)).status).toBe(403);
		expect((await call('creator', 'DELETE', `/tasks/${foreignTask.id}`)).status).toBe(403);
		ok(await call('admin', 'DELETE', `/tasks/${foreignTask.id}`));
		expect((await call('admin', 'GET', `/tasks/${foreignTask.id}`)).status).toBe(404);
	});

	it('Chat im Modus „task“ legt einen Auftrag an', async () => {
		const res = ok<{ message: ChatMessageDto; task: TaskDto }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Bitte die Tests reparieren',
				mode: 'task'
			}),
			201
		);
		expect(res.task).toMatchObject({ role: 'implement', status: 'queued' });
		expect(res.message).toMatchObject({ kind: 'user', taskId: res.task.id });
		ok(await call('admin', 'POST', `/tasks/${res.task.id}/cancel`), 201);
	});

	it('SSE: Projekt-Stream und Runner-Stream mit RPC (Repo prüfen)', async () => {
		const live = await openStream<{ type: string }>(
			keys.admin!,
			`/projects/${projectId}/live?client=test-client-1`
		);
		expect(live.res.status).toBe(200);
		expect(live.res.headers.get('content-type')).toContain('text/event-stream');
		await live.waitFor('hello');

		const stream = await openStream<RunnerCommand>(keys.runner!, '/runner/stream?client=main');
		expect(stream.res.status).toBe(200);
		await stream.waitFor('hello');
		const check = call<{ ok: boolean; canPush: boolean }>(
			'admin',
			'POST',
			`/projects/${projectId}/check`
		);
		const rpc = (await stream.waitFor('rpc')) as Extract<RunnerCommand, { type: 'rpc' }>;
		expect(rpc).toMatchObject({
			op: 'repo.check',
			project: { repoOwner: 'acme', repoName: 'widgets' }
		});
		expect(
			(await call('runner2', 'POST', `/runner/rpc/${rpc.reqId}`, { ok: true, result: {} })).status
		).toBe(404);
		ok(
			await call('runner', 'POST', `/runner/rpc/${rpc.reqId}`, {
				ok: true,
				result: { ok: true, defaultBranch: 'main', canPush: true, message: 'Zugriff ok' }
			}),
			201
		);
		expect(ok(await check, 201)).toMatchObject({ ok: true, canPush: true });

		// Live-Ereignis bei Änderung eines Auftrags
		const t = await createTask({ prompt: 'Live-Test', draft: true });
		await live.waitFor('task', (e) => (e as unknown as { task: TaskDto }).task.id === t.id);

		stream.close();
		live.close();
		await vi.waitFor(async () => {
			const [r] = await q<{ online: boolean }>(
				sql`SELECT online FROM runner WHERE id = ${runnerId}`
			);
			expect(r!.online).toBe(false);
		});
		// ohne Runner-Verbindung keine Projekt-Operationen
		expect((await call('admin', 'POST', `/projects/${projectId}/check`)).status).toBe(503);
	});
});
