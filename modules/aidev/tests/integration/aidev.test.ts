/**
 * Modul `aidev`: Runner-Protokoll und Steuerzentrale gegen PGlite.
 * Anmelden → Freigabe → Projekt + Auftrag → Angebot (pending) → Annahme → Ereignisse (doppelte seq ignoriert) →
 * Verbrauch → Abschluss mit PR (Auftrag `review`, pull_request); Lease-Ablauf → Job → neu eingeplant;
 * Limit → Wartezeit → zweites Konto übernimmt; Orchestrierung → Teilaufträge mit Abhängigkeiten → Ausliefern;
 * Zyklus im Plan abgelehnt; Konflikt → Konfliktlösung; Rechte; bestehenden PR bearbeiten (`targetPr`, pr-update);
 * SSE (Projekt, Runner) inkl. RPC über den Stream.
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
			capabilities: {
				question: true,
				branchDelivery: true,
				prUpdate: true,
				git: true,
				gh: true,
				pty: true,
				os: 'linux'
			},
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
		expect(t.delivery).toBe('project');
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

	it('Orchestrierung: Branch ohne PR gemeinsam ausliefern', async () => {
		const parent = await createTask({
			prompt: 'Großes Feature als Branch',
			decompose: true,
			delivery: 'branch'
		});
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
		expect(deliver.delivery.mode).toBe('branch');
		ok(await call('runner', 'POST', `/runner/runs/${deliver.runId}/accept`), 201);
		ok(
			await finish(deliver.runId, {
				status: 'succeeded',
				summary: 'ausgeliefert',
				branch: deliver.branch,
				branchPushed: true
			}),
			201
		);
		expect((await task(parent.id)).task).toMatchObject({
			status: 'done',
			prNumber: null,
			delivery: 'branch',
			branchPushed: true
		});
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

	it('Chat-Fragen liefern Antworten und übernehmen nur früheren Fragenkontext', async () => {
		const note = ok<{ task: TaskDto | null }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Geheime Notiz',
				mode: 'note'
			}),
			201
		);
		expect(note.task).toBeNull();
		const first = ok<{ task: TaskDto }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Wie funktioniert das?',
				mode: 'question',
				role: 'implement',
				decompose: true
			}),
			201
		);
		expect(first.task.role).toBe('research');
		const offer = await offerFor(first.task.id);
		expect(offer).toMatchObject({ question: true, readOnly: true, expectPlan: false });
		ok(await call('runner', 'POST', `/runner/runs/${offer.runId}/accept`), 201);
		const answer = 'Antwort '.repeat(900).trim();
		ok(await finish(offer.runId, { status: 'succeeded', summary: answer }), 201);
		ok(await finish(offer.runId, { status: 'succeeded', summary: answer }), 201);
		const chat = ok<ChatMessageDto[]>(await call('admin', 'GET', `/projects/${projectId}/chat`));
		expect(chat.filter((m) => m.taskId === first.task.id && m.kind === 'agent')).toHaveLength(1);
		expect(chat.find((m) => m.taskId === first.task.id && m.kind === 'agent')?.body).toBe(answer);
		const second = ok<{ task: TaskDto }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Und warum?',
				mode: 'question'
			}),
			201
		);
		const next = await offerFor(second.task.id);
		expect(next.prompt).toContain('Wie funktioniert das?');
		expect(next.prompt).toContain('Antwort');
		expect(next.prompt).not.toContain('Geheime Notiz');
		ok(await call('runner', 'POST', `/runner/runs/${next.runId}/accept`), 201);
		ok(await call('admin', 'PATCH', `/tasks/${second.task.id}`, { maxAttempts: 1 }));
		ok(await finish(next.runId, { status: 'succeeded', summary: '' }), 201);
		const after = ok<ChatMessageDto[]>(await call('admin', 'GET', `/projects/${projectId}/chat`));
		expect(after.find((m) => m.taskId === second.task.id && m.kind === 'agent')?.body).toContain(
			'keine Antwort'
		);
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
		// der Auftrag erhält den bisherigen Frage-/Antwort-Verlauf, ist aber selbst keine Chat-Frage
		const [row] = await q<{ chat_question: boolean; chat_context: string }>(
			sql`SELECT chat_question, chat_context FROM task WHERE id = ${res.task.id}`
		);
		expect(row!.chat_question).toBe(false);
		expect(row!.chat_context).toContain('Question: Wie funktioniert das?');
		expect(row!.chat_context).toContain('Answer: Antwort');
		expect(row!.chat_context).not.toContain('Bitte die Tests reparieren');
		expect(row!.chat_context).not.toContain('Geheime Notiz');
		expect(row!.chat_context.length).toBeLessThanOrEqual(12000);
		ok(await call('admin', 'POST', `/tasks/${res.task.id}/cancel`), 201);
	});

	it('Chat im Modus „auto“ erkennt Frage und Auftrag', async () => {
		const question = ok<{ message: ChatMessageDto; task: TaskDto; mode: string }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Wie funktioniert der Scheduler?',
				mode: 'auto',
				role: 'implement',
				decompose: true
			}),
			201
		);
		expect(question.mode).toBe('question');
		expect(question.task).toMatchObject({ role: 'research' });
		expect(question.message).toMatchObject({ kind: 'user', taskId: question.task.id });
		const [q1] = await q<{ chat_question: boolean }>(
			sql`SELECT chat_question FROM task WHERE id = ${question.task.id}`
		);
		expect(q1!.chat_question).toBe(true);
		ok(await call('admin', 'POST', `/tasks/${question.task.id}/cancel`), 201);

		const order = ok<{ message: ChatMessageDto; task: TaskDto; mode: string }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Kannst du den Login-Bug fixen?',
				mode: 'auto'
			}),
			201
		);
		expect(order.mode).toBe('task');
		expect(order.task).toMatchObject({ role: 'implement' });
		const [t1] = await q<{ chat_question: boolean }>(
			sql`SELECT chat_question FROM task WHERE id = ${order.task.id}`
		);
		expect(t1!.chat_question).toBe(false);
		ok(await call('admin', 'POST', `/tasks/${order.task.id}/cancel`), 201);

		// ohne Angabe bleibt der Modus `task`; Notizen melden `note`
		const note = ok<{ task: TaskDto | null; mode: string }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Nur Notiz?',
				mode: 'note'
			}),
			201
		);
		expect(note).toMatchObject({ task: null, mode: 'note' });
	});

	it('Chat übernimmt die Auslieferungswahl und ungültige Werte werden abgelehnt', async () => {
		const invalid = await call('admin', 'POST', `/projects/${projectId}/tasks`, {
			prompt: 'Test',
			delivery: 'direct'
		});
		expect(invalid.status).toBe(422);
		const res = ok<{ message: ChatMessageDto; task: TaskDto }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Als Branch ausliefern',
				delivery: 'branch'
			}),
			201
		);
		expect(res.task.delivery).toBe('branch');
		const o = await offerFor(res.task.id);
		expect(o.delivery).toEqual({ mode: 'branch' });
		ok(await call('runner', 'POST', `/runner/runs/${o.runId}/accept`), 201);
		ok(await finish(o.runId, { status: 'succeeded', branch: o.branch, branchPushed: true }), 201);
		expect((await task(res.task.id)).task).toMatchObject({
			status: 'done',
			branch: o.branch,
			branchPushed: true,
			prNumber: null
		});
	});

	it('Branch-Auslieferung geht nur an Runner, die den Modus kennen', async () => {
		// alter Runner ohne Capability `branchDelivery` (gestaffeltes Upgrade)
		const old = ok<{ runnerId: string }>(
			await call('runner2', 'POST', '/runner/register', {
				protocol: 1,
				name: 'Runner alt',
				version: '0.0.9',
				maxSlots: 4,
				capabilities: { git: true, gh: true, pty: true, os: 'linux' },
				accounts: [{ key: 'fake-x', provider: 'fake', label: 'fake-x', loggedIn: true, models: [] }]
			}),
			201
		);
		ok(await call('admin', 'PATCH', `/runners/${old.runnerId}`, { status: 'approved' }));
		ok(await heartbeat('runner2'), 201);
		ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 0 }));
		try {
			const branch = await createTask({ prompt: 'Nur Branch', delivery: 'branch' });
			const pr = await createTask({ prompt: 'Mit PR' });
			const oldOffers = await offers('runner2');
			expect(oldOffers.map((o) => o.taskId)).toContain(pr.id);
			expect(oldOffers.map((o) => o.taskId)).not.toContain(branch.id);
			expect((await task(branch.id)).task.status).toBe('queued');
			ok(await call('admin', 'POST', `/tasks/${pr.id}/cancel`), 201);

			ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 4 }));
			const o = await offerFor(branch.id);
			expect(o.delivery).toEqual({ mode: 'branch' });
			ok(await call('admin', 'POST', `/tasks/${branch.id}/cancel`), 201);
		} finally {
			ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 4 }));
			ok(await call('admin', 'PATCH', `/runners/${old.runnerId}`, { maxSlots: 0 }));
		}
	});

	it('Bestehenden PR bearbeiten: Prüfung, Branch des PR, pr-update, Konfliktlösung erbt den Modus', async () => {
		await q(
			sql`INSERT INTO pull_request (project_id, number, title, branch, state, url) VALUES
				(${projectId}, 101, 'Offen', 'feature/x', 'open', 'https://github.com/acme/widgets/pull/101'),
				(${projectId}, 102, 'Zu', 'feature/y', 'closed', 'https://github.com/acme/widgets/pull/102'),
				(${projectId}, 103, 'Haupt', 'main', 'open', 'https://github.com/acme/widgets/pull/103')`
		);
		for (const [targetPr, message] of [
			[999, 'nicht gefunden'],
			[102, 'Nur offene PRs'],
			[103, 'Haupt-Branch']
		] as const) {
			const res = await call('admin', 'POST', `/projects/${projectId}/tasks`, {
				prompt: 'PR bearbeiten',
				targetPr
			});
			expect(res.status).toBe(422);
			expect(JSON.stringify(res.body)).toContain('targetPr');
			expect(JSON.stringify(res.body)).toContain(message);
		}

		const t = await createTask({ prompt: 'Review-Kommentare in PR 101 umsetzen', targetPr: 101 });
		expect(t).toMatchObject({
			targetPr: 101,
			delivery: 'project',
			branch: 'feature/x',
			prNumber: 101,
			prUrl: 'https://github.com/acme/widgets/pull/101'
		});
		const [row] = await q<{ base_ref: string }>(sql`SELECT base_ref FROM task WHERE id = ${t.id}`);
		expect(row!.base_ref).toBe('main');
		const o = await offerFor(t.id);
		expect(o).toMatchObject({ branch: 'feature/x', baseRef: 'main', readOnly: false });
		expect(o.delivery).toEqual({ mode: 'pr-update', number: 101 });

		// Konflikt → Konfliktlösung liefert ebenfalls in den PR
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
		const resolve = (await task(t.id)).children.find((c) => c.role === 'resolve')!;
		const ro = await offerFor(resolve.id);
		expect(ro).toMatchObject({ role: 'resolve', branch: 'feature/x' });
		expect(ro.delivery).toEqual({ mode: 'pr-update', number: 101 });
		ok(await call('runner', 'POST', `/runner/runs/${ro.runId}/accept`), 201);
		ok(
			await finish(ro.runId, {
				status: 'succeeded',
				branch: 'feature/x',
				branchPushed: true,
				pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101' }
			}),
			201
		);
		const d = await task(t.id);
		expect(d.task).toMatchObject({
			status: 'review',
			prNumber: 101,
			branch: 'feature/x',
			branchPushed: true
		});
		expect(d.pullRequest).toMatchObject({ number: 101, branch: 'feature/x', state: 'open' });
		const chat = ok<ChatMessageDto[]>(await call('admin', 'GET', `/projects/${projectId}/chat`));
		expect(chat.find((m) => m.taskId === t.id && m.kind === 'agent')!.body).toContain(
			'PR #101 aktualisiert.'
		);

		// Chat reicht `targetPr` durch; Fragen zum PR lesen nur (Branch = PR-Branch)
		const question = ok<{ task: TaskDto }>(
			await call('admin', 'POST', `/projects/${projectId}/chat`, {
				body: 'Was ändert PR 101?',
				mode: 'question',
				targetPr: 101
			}),
			201
		);
		expect(question.task).toMatchObject({ targetPr: 101, branch: 'feature/x' });
		const qo = await offerFor(question.task.id);
		expect(qo).toMatchObject({ readOnly: true, question: true, branch: 'feature/x' });
		expect(qo.delivery.mode).toBe('none');
		ok(await call('admin', 'POST', `/tasks/${question.task.id}/cancel`), 201);
	});

	it('PR-Aktualisierung geht nur an Runner mit `prUpdate`', async () => {
		// runner2 ist der alte Runner ohne `prUpdate` (aus dem Test zur Branch-Auslieferung)
		const runners = ok<RunnerDto[]>(await call('admin', 'GET', '/runners'));
		const old = runners.find((r) => r.id !== runnerId && !r.capabilities.prUpdate)!;
		expect(old).toBeTruthy();
		ok(await call('admin', 'PATCH', `/runners/${old.id}`, { maxSlots: 4 }));
		ok(await heartbeat('runner2'), 201);
		ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 0 }));
		try {
			const update = await createTask({ prompt: 'PR 101 nachbessern', targetPr: 101 });
			const pr = await createTask({ prompt: 'Neuer PR' });
			const oldOffers = await offers('runner2');
			expect(oldOffers.map((o) => o.taskId)).toContain(pr.id);
			expect(oldOffers.map((o) => o.taskId)).not.toContain(update.id);
			expect((await task(update.id)).task.status).toBe('queued');
			ok(await call('admin', 'POST', `/tasks/${pr.id}/cancel`), 201);

			ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 4 }));
			const o = await offerFor(update.id);
			expect(o.delivery).toEqual({ mode: 'pr-update', number: 101 });
			ok(await call('admin', 'POST', `/tasks/${update.id}/cancel`), 201);
		} finally {
			ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 4 }));
			ok(await call('admin', 'PATCH', `/runners/${old.id}`, { maxSlots: 0 }));
		}
	});

	it('Orchestrierung eines PR: Teilaufträge mit PR-Schutz, Abschluss meldet den PR', async () => {
		const parent = await createTask({
			prompt: 'PR 101 in Teilen überarbeiten',
			targetPr: 101,
			decompose: true
		});
		const plan = await offerFor(parent.id);
		expect(plan).toMatchObject({ readOnly: true, expectPlan: true, delivery: { mode: 'none' } });
		ok(await call('runner', 'POST', `/runner/runs/${plan.runId}/accept`), 201);
		ok(
			await finish(plan.runId, {
				status: 'succeeded',
				plan: {
					summary: 'Ein Teil',
					subtasks: [{ key: 'a', title: 'Teil A', prompt: 'Baue A', role: 'implement' }]
				}
			}),
			201
		);
		const [child] = (await task(parent.id)).children;

		// Teilauftrag mergt in den PR-Branch → nur an Runner mit `prUpdate`
		const runners = ok<RunnerDto[]>(await call('admin', 'GET', '/runners'));
		const old = runners.find((r) => r.id !== runnerId && !r.capabilities.prUpdate)!;
		ok(await call('admin', 'PATCH', `/runners/${old.id}`, { maxSlots: 4 }));
		ok(await heartbeat('runner2'), 201);
		ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 0 }));
		try {
			expect((await offers('runner2')).map((o) => o.taskId)).not.toContain(child!.id);
		} finally {
			ok(await call('admin', 'PATCH', `/runners/${runnerId}`, { maxSlots: 4 }));
			ok(await call('admin', 'PATCH', `/runners/${old.id}`, { maxSlots: 0 }));
		}
		const sub = await offerFor(child!.id);
		expect(sub).toMatchObject({ baseRef: 'feature/x', readOnly: false });
		expect(sub.delivery).toEqual({
			mode: 'integrate',
			integrationBranch: 'feature/x',
			pullNumber: 101
		});
		ok(await call('runner', 'POST', `/runner/runs/${sub.runId}/accept`), 201);
		ok(
			await finish(sub.runId, {
				status: 'succeeded',
				summary: 'A gebaut',
				merged: true,
				commits: [{ sha: 'abcdef1', message: 'Teil A' }]
			}),
			201
		);

		// Abschluss: Änderungen liegen schon im PR-Branch → `integrated`
		const deliver = await offerFor(parent.id);
		expect(deliver).toMatchObject({ branch: 'feature/x', readOnly: false });
		expect(deliver.delivery).toEqual({ mode: 'pr-update', number: 101, integrated: true });
		ok(await call('runner', 'POST', `/runner/runs/${deliver.runId}/accept`), 201);
		ok(
			await finish(deliver.runId, {
				status: 'succeeded',
				summary: 'Integration geprüft',
				branch: 'feature/x',
				branchPushed: true,
				pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101' }
			}),
			201
		);
		expect((await task(parent.id)).task).toMatchObject({
			status: 'review',
			prNumber: 101,
			branchPushed: true
		});
	});

	it('PR-Sync überträgt den Merge auf alle Aufträge desselben PR', async () => {
		const reviewing = await q<{ id: string }>(
			sql`SELECT id FROM task WHERE project_id = ${projectId} AND pr_number = 101
				AND status = 'review'`
		);
		// Auftrag aus „Bestehenden PR bearbeiten“ und die PR-Orchestrierung
		expect(reviewing.length).toBeGreaterThanOrEqual(2);
		const stream = await openStream<RunnerCommand>(keys.runner!, '/runner/stream?client=main');
		await stream.waitFor('hello');
		try {
			const sync = call('admin', 'POST', `/projects/${projectId}/pulls/sync`);
			const rpc = (await stream.waitFor(
				'rpc',
				(e) => (e as Extract<RunnerCommand, { type: 'rpc' }>).op === 'gh.pr-list'
			)) as Extract<RunnerCommand, { type: 'rpc' }>;
			const pr = {
				number: 101,
				title: 'Offen',
				branch: 'feature/x',
				state: 'merged',
				isDraft: false,
				mergeable: 'MERGEABLE',
				checks: 'passing',
				autoMerge: false,
				url: 'https://github.com/acme/widgets/pull/101',
				additions: 1,
				deletions: 0,
				createdAt: '',
				updatedAt: ''
			};
			ok(
				await call('runner', 'POST', `/runner/rpc/${rpc.reqId}`, {
					ok: true,
					result: { pulls: [pr] }
				}),
				201
			);
			ok(await sync, 201);
		} finally {
			stream.close();
		}
		for (const r of reviewing) expect((await task(r.id)).task.status).toBe('done');
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

	it('Heartbeat mit Limit-Stand füllt `AccountDto.limits`, ältere Runner ändern nichts', async () => {
		const fakeA = async () =>
			ok<AccountDto[]>(await call('admin', 'GET', '/accounts')).find(
				(a) => a.runnerId === runnerId && a.key === 'fake-a'
			)!;
		const samples = async () =>
			(
				await q<{ n: number }>(
					sql`SELECT count(*)::int AS n FROM account_limit_sample s
						JOIN provider_account a ON a.id = s.account_id
						WHERE a.runner_id = ${runnerId} AND a.key = 'fake-a'`
				)
			)[0]!.n;
		const beat = (accounts: unknown[]) =>
			call<{ status: string }>('runner', 'POST', '/runner/heartbeat', {
				slotsUsed: 0,
				runIds: [],
				accounts
			});
		expect((await fakeA()).limits).toBeNull();

		const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
		// Beobachtung nach den Buchungen früherer Tests (Verbrauch zählt nur bis zur Beobachtung)
		const observedAt = new Date().toISOString();
		const limits = {
			observedAt,
			source: 'probe',
			windows: [
				{ window: '5h', label: 'five_hour', usedPercent: 20, resetsAt, status: 'allowed' },
				{ window: 'week', usedPercent: 35, resetsAt: null }
			]
		};
		ok(await beat([{ key: 'fake-a', loggedIn: true, limits }]), 201);
		const account = await fakeA();
		const first = account.limits!;
		// eigene Schätzung nur bei bekanntem Budget
		const est5h = account.effective5hUnits > 0 ? account.usage.util5h : null;
		const estWeek = account.effectiveWeekUnits > 0 ? account.usage.utilWeek : null;
		expect(first).toMatchObject({
			observedAt,
			source: 'probe',
			stale: false
		});
		// Budgetvorschlag = Verbrauch im Fenster / gemeldete Auslastung (frühere Tests haben Verbrauch gebucht)
		const [ledger] = await q<{ units: number }>(
			sql`SELECT COALESCE(sum(units), 0)::int AS units FROM usage_ledger
				WHERE account_id = ${account.id} AND source <> 'reserved'
					AND ts <= ${observedAt}::timestamptz`
		);
		const units = ledger!.units;
		expect(first.suggestedBudget5hUnits).toBe(units > 0 ? Math.round(units / 0.2) : null);
		expect(first.suggestedBudgetWeekUnits).toBe(units > 0 ? Math.round(units / 0.35) : null);
		expect(first.windows).toEqual([
			{
				window: '5h',
				label: 'five_hour',
				usedPercent: 20,
				resetsAt,
				status: 'allowed',
				stale: false,
				estimatedUtil: est5h,
				exhaustsAt: null
			},
			{
				window: 'week',
				label: '',
				usedPercent: 35,
				resetsAt: null,
				status: 'unknown',
				stale: false,
				estimatedUtil: estWeek,
				exhaustsAt: null
			}
		]);
		expect(await samples()).toBe(2);

		// älterer Runner ohne `limits` und ein älterer Stand ändern nichts
		ok(await beat([{ key: 'fake-a', loggedIn: true }]), 201);
		ok(await heartbeat('runner'), 201);
		const older = { ...limits, observedAt: new Date(Date.now() - 600_000).toISOString() };
		ok(await beat([{ key: 'fake-a', loggedIn: true, limits: older }]), 201);
		expect((await fakeA()).limits).toEqual(first);

		// neuerer Stand ersetzt den Schnappschuss, Proben höchstens alle 5 Minuten
		const newer = {
			...limits,
			observedAt: new Date().toISOString(),
			windows: [{ window: '5h', usedPercent: 30, resetsAt, status: 'warning' }]
		};
		ok(await beat([{ key: 'fake-a', loggedIn: true, limits: newer }]), 201);
		const second = (await fakeA()).limits!;
		expect(second.observedAt).toBe(newer.observedAt);
		expect(second.windows).toHaveLength(1);
		expect(second.windows[0]).toMatchObject({ usedPercent: 30, status: 'warning' });
		expect(await samples()).toBe(2);

		// vorgehende Runner-Uhr: Zeiten werden auf „jetzt“ begrenzt, Fensterzeiten um dieselbe Abweichung verschoben
		const ahead = Date.now() + 3 * 3600_000;
		const future = {
			observedAt: new Date(ahead).toISOString(),
			source: 'stream',
			windows: [
				{ window: '5h', usedPercent: 40, resetsAt, status: 'allowed' },
				{
					window: 'week',
					usedPercent: 50,
					resetsAt: null,
					status: 'rejected',
					observedAt: new Date(ahead - 2 * 3600_000).toISOString()
				}
			]
		};
		const before = Date.now();
		ok(await beat([{ key: 'fake-a', loggedIn: true, limits: future }]), 201);
		const third = (await fakeA()).limits!;
		const thirdAt = new Date(third.observedAt).getTime();
		expect(thirdAt).toBeGreaterThanOrEqual(before - 1000);
		expect(thirdAt).toBeLessThanOrEqual(Date.now());
		expect(third.stale).toBe(false);
		// das Wochenfenster ist 2 h älter als der Schnappschuss → veraltet
		expect(third.windows.map((w) => [w.window, w.stale])).toEqual([
			['5h', false],
			['week', true]
		]);

		// derselbe Stand erneut gesendet (Heartbeat) gilt nicht als neue Beobachtung
		ok(await beat([{ key: 'fake-a', loggedIn: true, limits: future }]), 201);
		expect((await fakeA()).limits!.observedAt).toBe(third.observedAt);
	});
});
