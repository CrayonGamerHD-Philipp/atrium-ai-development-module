/**
 * PC-Runner: geordnete Übergabe mit WIP-Ref (Standby über `FakePowerMonitor`), Fortsetzung auf einem anderen
 * Runner (anderes Konto/anderer Anbieter-Schlüssel), Fencing (aufgewachter PC pusht nicht, meldet nichts),
 * Checkpoints. Lokales Bare-Remote, Mini-Atrium.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AtriumClient, RunnerApi } from '../src/client.ts';
import { accountConfigSchema, publicEnv, type RunnerConfig } from '../src/config.ts';
import { Executor, type AccountState, type AtriumFeatures } from '../src/executor.ts';
import { Workspace } from '../src/git/workspace.ts';
import { FakePowerMonitor } from '../src/power/index.ts';
import { defaultAdapters } from '../src/providers/index.ts';
import type { FinishInput, RunOffer } from '../src/protocol.ts';
import { Redactor } from '../src/redact.ts';
import { Runner } from '../src/runner.ts';
import { createRemote, git, type Remote, setupTestEnv, type TestEnv } from './helpers/env.ts';
import { FakeAtrium } from './helpers/fake-atrium.ts';

let env: TestEnv;
let atrium: FakeAtrium;
let remote: Remote;
const projectId = randomUUID();
const features: AtriumFeatures = { handoff: true, fencing: true, checkpoints: true };

function makeExecutor(workDir: string, key: string, o: { checkpointMin?: number } = {}) {
	const acct = accountConfigSchema.parse({ key, provider: 'fake' });
	const config: RunnerConfig = {
		atriumUrl: atrium.url,
		apiKey: atrium.apiKey,
		name: key,
		workDir,
		maxSlots: 2,
		gitRemoteTemplate: env.remoteTemplate,
		gitAuthorName: 'Atrium Agent',
		gitAuthorEmail: 'agent@atrium.local',
		accounts: [acct],
		kind: 'desktop',
		wipCheckpointMin: o.checkpointMin ?? 0,
		configFile: null
	};
	const api = new RunnerApi(new AtriumClient({ atriumUrl: atrium.url, apiKey: atrium.apiKey, backoffBaseMs: 5 }));
	const workspace = new Workspace({
		workDir,
		remoteTemplate: env.remoteTemplate,
		author: { name: 'Atrium Agent', email: 'agent@atrium.local' },
		env: publicEnv(process.env),
		useGhCredentials: false
	});
	const accounts = new Map<string, AccountState>([[key, { config: acct, ok: true, loggedIn: true, version: 'fake-1' }]]);
	const executor = new Executor({
		config,
		api,
		workspace,
		adapters: defaultAdapters,
		redactor: new Redactor([atrium.apiKey]),
		accounts: () => accounts,
		batcherFlushMs: 20,
		features: () => features
	});
	return { executor, config, workspace };
}

function offer(key: string, over: Partial<RunOffer> = {}): RunOffer {
	const taskId = over.taskId ?? randomUUID();
	return {
		runId: randomUUID(),
		taskId,
		attempt: 1,
		role: 'implement',
		title: 'Langer Auftrag',
		prompt: 'Bitte weiterarbeiten. [fake:write-slow]',
		systemPrompt: 'Test',
		project: { id: projectId, name: 'Shop', repoOwner: 'acme', repoName: 'shop', defaultBranch: 'main', setupCmd: '', testCmd: '' },
		account: { key, provider: 'fake' },
		model: null,
		branch: `aidev/${taskId.slice(0, 8)}-lang`,
		baseRef: 'main',
		readOnly: false,
		expectPlan: false,
		resumeSessionId: null,
		delivery: { mode: 'branch' },
		fence: 1,
		leaseSec: 60,
		timeoutSec: 120,
		...over
	};
}

const finishOf = async (runId: string) =>
	(await atrium.waitFor((r) => r.path === `/runner/runs/${runId}/finish`)).body as FinishInput;

async function waitForFile(file: string) {
	for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
	expect(existsSync(file)).toBe(true);
}

beforeAll(async () => {
	env = await setupTestEnv();
	atrium = new FakeAtrium();
	atrium.features = { handoff: true, fencing: true, checkpoints: true };
	atrium.leaseSec = 60;
	await atrium.start();
	remote = await createRemote(env, 'acme', 'shop');
});

afterAll(async () => {
	await atrium?.stop();
	await env?.cleanup();
});

describe('Übergabe und Fortsetzung', () => {
	it('Standby: Agent stoppen, WIP-Ref pushen (kein Branch), als übergeben melden; Server setzt fort', async () => {
		const pc = makeExecutor(path.join(env.tmp, 'pc-work'), 'claude-pc');
		const o1 = offer('claude-pc');
		expect(await pc.executor.handleOffer(o1)).toBe('accepted');
		await waitForFile(path.join(pc.config.workDir, 'wt', o1.runId, 'AIDEV_WIP.md'));

		const n = await pc.executor.handover('suspend', Date.now() + 15_000);
		expect(n).toBe(1);
		const fin = await finishOf(o1.runId);
		expect(fin.status).toBe('cancelled');
		expect(fin.fence).toBe(1);
		expect(fin.handoff).toMatchObject({ reason: 'suspend', wipPushed: true, wipRef: `refs/aidev/wip/${o1.runId}` });
		const wipSha = fin.handoff!.headSha!;
		// WIP liegt nur unter dem eigenen Ref – der Branch wurde nicht angelegt, main unverändert
		expect(git(remote.bare, 'rev-parse', `refs/aidev/wip/${o1.runId}`)).toBe(wipSha);
		expect(remote.sha(o1.branch)).toBeNull();
		expect(git(remote.bare, 'log', '-1', '--format=%B', wipSha)).toContain('Aidev-Wip: suspend');
		expect(git(remote.bare, 'show', `${wipSha}:AIDEV_WIP.md`)).toContain('Zwischenstand');
		// während der Übergabe keine neuen Läufe
		expect(await pc.executor.handleOffer(offer('claude-pc'))).toBe('rejected');
		pc.executor.resume();

		// Server-Runner mit anderem Konto setzt auf dem Zwischenstand fort und liefert aus
		const srv = makeExecutor(path.join(env.tmp, 'srv-work'), 'codex-srv');
		const o2 = offer('codex-srv', {
			taskId: o1.taskId,
			branch: o1.branch,
			fence: 2,
			prompt: 'Bitte fertigstellen.',
			resumeWip: { ref: `refs/aidev/wip/${o1.runId}`, sha: wipSha, fromRunner: 'PC' }
		});
		expect(await srv.executor.handleOffer(o2)).toBe('accepted');
		const fin2 = await finishOf(o2.runId);
		expect(fin2).toMatchObject({ status: 'succeeded', branchPushed: true, fence: 2 });
		// Ergebnis enthält Zwischenstand und neue Arbeit in einem normalen Commit, kein WIP-Commit im Branch
		expect(remote.read(o1.branch, 'AIDEV_WIP.md')).toContain('Zwischenstand');
		expect(remote.read(o1.branch, 'AIDEV_FAKE.md')).toContain('Bitte fertigstellen.');
		expect(git(remote.bare, 'log', '--format=%B', `main..${o1.branch}`)).not.toContain('Aidev-Wip');
		expect(git(remote.bare, 'rev-list', '--count', `main..${o1.branch}`)).toBe('1');
		// verbrauchter WIP-Ref wurde aufgeräumt
		expect(git(remote.bare, 'for-each-ref', 'refs/aidev/wip/')).toBe('');
		const events = atrium.byPath(new RegExp(`/runner/runs/${o2.runId}/events`)).flatMap((r) => (r.body as { events: { payload: { detail?: string } }[] }).events);
		expect(events.some((e) => /Zwischenstand von PC übernommen/.test(e.payload.detail ?? ''))).toBe(true);
	});

	it('veralteter Zwischenstand (Branch inzwischen weiter) wird nicht übernommen', async () => {
		const pc = makeExecutor(path.join(env.tmp, 'pc2-work'), 'claude-pc');
		const o1 = offer('claude-pc');
		expect(await pc.executor.handleOffer(o1)).toBe('accepted');
		await waitForFile(path.join(pc.config.workDir, 'wt', o1.runId, 'AIDEV_WIP.md'));
		await pc.executor.handover('shutdown', Date.now() + 15_000);
		const wipSha = (await finishOf(o1.runId)).handoff!.headSha!;
		// inzwischen hat jemand anderes den Branch gepusht
		remote.commitFile(o1.branch, 'ANDERS.md', 'neu\n', 'Paralleler Stand');
		const srv = makeExecutor(path.join(env.tmp, 'srv2-work'), 'codex-srv');
		const o2 = offer('codex-srv', {
			taskId: o1.taskId,
			branch: o1.branch,
			fence: 2,
			prompt: 'Weiter.',
			resumeWip: { ref: `refs/aidev/wip/${o1.runId}`, sha: wipSha, fromRunner: 'PC' }
		});
		await srv.executor.handleOffer(o2);
		expect((await finishOf(o2.runId)).status).toBe('succeeded');
		expect(remote.read(o1.branch, 'AIDEV_WIP.md')).toBeNull();
		expect(remote.read(o1.branch, 'ANDERS.md')).toBe('neu\n');
	});
});

describe('Fencing: aufgewachter PC', () => {
	it('Lease ungültig vor dem Push → nichts gepusht, keine Abschlussmeldung', async () => {
		const pc = makeExecutor(path.join(env.tmp, 'pc3-work'), 'claude-pc');
		const o = offer('claude-pc', { prompt: 'Kurz. [fake:noop-not]' });
		atrium.revoked.add(o.runId);
		expect(await pc.executor.handleOffer(o)).toBe('accepted');
		await pc.executor.idle();
		expect(remote.sha(o.branch)).toBeNull();
		expect(atrium.requests.some((r) => r.path === `/runner/runs/${o.runId}/finish`)).toBe(false);
		expect(atrium.requests.some((r) => r.path === '/runner/leases')).toBe(true);
	});

	it('nach dem Aufwachen: übernommene Läufe verwerfen (Runner.wake), gültige laufen weiter', async () => {
		const power = new FakePowerMonitor(10_000);
		const workDir = path.join(env.tmp, 'pc4-work');
		const acct = accountConfigSchema.parse({ key: 'claude-pc', provider: 'fake' });
		const runner = new Runner({
			config: {
				atriumUrl: atrium.url,
				apiKey: atrium.apiKey,
				name: 'pc',
				workDir,
				maxSlots: 2,
				gitRemoteTemplate: env.remoteTemplate,
				gitAuthorName: 'Atrium Agent',
				gitAuthorEmail: 'agent@atrium.local',
				accounts: [acct],
				kind: 'desktop',
				configFile: null
			},
			redactor: new Redactor([atrium.apiKey]),
			fetch,
			powerMonitor: power,
			reprobeMs: 3_600_000,
			cleanupMs: 3_600_000,
			backoffBaseMs: 5
		});
		const started = runner.start();
		await atrium.waitFor((r) => r.path === '/runner/register');
		await new Promise((r) => setTimeout(r, 200));
		const stale = offer('claude-pc');
		const fresh = offer('claude-pc');
		atrium.send({ type: 'offer', offer: stale });
		atrium.send({ type: 'offer', offer: fresh });
		await waitForFile(path.join(workDir, 'wt', stale.runId, 'AIDEV_WIP.md'));
		await waitForFile(path.join(workDir, 'wt', fresh.runId, 'AIDEV_WIP.md'));
		// Standby ohne Ereignis: Atrium hat `stale` inzwischen einem anderen Runner gegeben
		atrium.revoked.add(stale.runId);
		atrium.conflict.add(stale.runId);
		await power.emit('resume', { sleptMs: 120_000 });
		expect(runner.executor.isRunning(fresh.runId)).toBe(true);
		for (let i = 0; i < 100 && runner.executor.isRunning(stale.runId); i++) await new Promise((r) => setTimeout(r, 20));
		expect(runner.executor.isRunning(stale.runId)).toBe(false);
		// verworfener Lauf: kein finish, kein Push; Worktree bleibt bis zum Aufräumen
		expect(atrium.requests.some((r) => r.path === `/runner/runs/${stale.runId}/finish`)).toBe(false);
		expect(existsSync(path.join(workDir, 'wt', stale.runId))).toBe(true);
		// Neuanmeldung nach dem Aufwachen
		expect(atrium.requests.filter((r) => r.path === '/runner/register').length).toBeGreaterThanOrEqual(2);

		// danach: Standby mit Ereignis → Heartbeat mit handover, gültiger Lauf wird übergeben
		await power.emit('suspend');
		const hb = atrium.requests.filter((r) => r.path === '/runner/heartbeat').map((r) => r.body as { handover?: string });
		expect(hb.some((b) => b.handover === 'suspend')).toBe(true);
		const fin = await finishOf(fresh.runId);
		expect(fin.handoff).toMatchObject({ reason: 'suspend', wipPushed: true });
		// Zustandsdatei für `status`
		const state = JSON.parse(readFileSync(path.join(workDir, 'state.json'), 'utf8')) as { kind: string; power: string };
		expect(state).toMatchObject({ kind: 'desktop', power: 'fake' });
		await runner.shutdown();
		await started;
	});
});

describe('Checkpoints', () => {
	it('sichert Zwischenstände regelmäßig und meldet sie mit Fencing-Token', async () => {
		const pc = makeExecutor(path.join(env.tmp, 'pc5-work'), 'claude-pc', { checkpointMin: 0.01 as unknown as number });
		const o = offer('claude-pc', { fence: 7 });
		await pc.executor.handleOffer(o);
		const cp = await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/checkpoint`, 20_000);
		expect(cp.invalid).toBeUndefined();
		expect(cp.body).toMatchObject({ ref: `refs/aidev/wip/${o.runId}`, fence: 7 });
		const sha = (cp.body as { sha: string }).sha;
		expect(git(remote.bare, 'rev-parse', `refs/aidev/wip/${o.runId}`)).toBe(sha);
		pc.executor.cancel(o.runId);
		await pc.executor.idle();
	});
});
