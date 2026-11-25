/**
 * Runner gegen ein Mini-Atrium (node:http, SSE): Anmeldung, Befehlsstrom, Nachholen über /pending, Angebote,
 * Abbruch über Heartbeat, Wiederholung von Ereignis-Batches, RPCs und Terminal-Fehlerpfad.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountConfigSchema, type RunnerConfig } from '../src/config.ts';
import type { AccountState } from '../src/executor.ts';
import { silentLogger } from '../src/log.ts';
import type { FinishInput, RunOffer } from '../src/protocol.ts';
import { Redactor } from '../src/redact.ts';
import { Runner } from '../src/runner.ts';
import { createRemote, type Remote, setupTestEnv, type TestEnv } from './helpers/env.ts';
import { FakeAtrium } from './helpers/fake-atrium.ts';

let env: TestEnv;
let atrium: FakeAtrium;
let remote: Remote;
let runner: Runner;
let started: Promise<void>;
const projectId = randomUUID();
const project = { id: projectId, repoOwner: 'acme', repoName: 'web', defaultBranch: 'main' };

function offer(over: Partial<RunOffer> = {}): RunOffer {
	const taskId = randomUUID();
	return {
		runId: randomUUID(),
		taskId,
		attempt: 1,
		role: 'implement',
		title: 'Änderung',
		prompt: 'Bitte ändern.',
		systemPrompt: '',
		project: { ...project, name: 'Web', setupCmd: '', testCmd: '' },
		account: { key: 'fake-1', provider: 'fake' },
		model: null,
		branch: `aidev/${taskId.slice(0, 8)}-aenderung`,
		baseRef: 'main',
		readOnly: false,
		expectPlan: false,
		resumeSessionId: null,
		delivery: { mode: 'pr', autoMerge: false, title: 'Änderung', body: '' },
		leaseSec: 90,
		timeoutSec: 120,
		...over
	};
}

async function finishOf(runId: string): Promise<FinishInput> {
	const r = await atrium.waitFor((x) => x.path === `/runner/runs/${runId}/finish`);
	expect(r.invalid).toBeUndefined();
	return r.body as FinishInput;
}

async function rpc(op: string, args: Record<string, unknown> = {}, target = 'main') {
	const reqId = randomUUID();
	atrium.send({ type: 'rpc', reqId, op: op as never, project, target, args });
	const r = await atrium.waitFor((x) => x.path === `/runner/rpc/${reqId}`);
	expect(r.invalid).toBeUndefined();
	return r.body as { ok: boolean; result?: any; error?: string };
}

beforeAll(async () => {
	env = await setupTestEnv();
	atrium = new FakeAtrium();
	await atrium.start();
	remote = await createRemote(env, 'acme', 'web');
	const pendingOffer = offer({ prompt: 'Aus /pending' });
	atrium.pending = [{ type: 'offer', offer: pendingOffer }];
	const config: RunnerConfig = {
		atriumUrl: atrium.url,
		apiKey: atrium.apiKey,
		name: 'test-runner',
		workDir: env.workDir,
		maxSlots: 2,
		gitRemoteTemplate: env.remoteTemplate,
		gitAuthorName: 'Atrium Agent',
		gitAuthorEmail: 'agent@atrium.local',
		accounts: [accountConfigSchema.parse({ key: 'fake-1', provider: 'fake', models: ['fake-large'] })],
		configFile: null
	};
	runner = new Runner({ config, redactor: new Redactor([atrium.apiKey]), log: silentLogger, backoffBaseMs: 5 });
	started = runner.start();
	(globalThis as { __pendingRun?: string }).__pendingRun = pendingOffer.runId;
});

afterAll(async () => {
	await runner?.shutdown();
	await started?.catch(() => undefined);
	await atrium?.stop();
	await env?.cleanup();
});

describe('Runner', () => {
	it('meldet sich mit Konten und Fähigkeiten an', async () => {
		const reg = await atrium.waitFor((r) => r.path === '/runner/register');
		expect(reg.invalid).toBeUndefined();
		expect(reg.body).toMatchObject({
			protocol: 1,
			name: 'test-runner',
			maxSlots: 2,
			capabilities: { git: true, gh: true, limitReport: true, attachments: true },
			accounts: [{ key: 'fake-1', provider: 'fake', loggedIn: true, models: ['fake-large'] }],
			// frisch gestartet: keine laufenden Läufe → Atrium gibt verwaiste sofort frei
			runIds: []
		});
		await atrium.waitFor((r) => r.path === '/runner/stream');
	});

	it('holt verpasste Angebote über /pending nach', async () => {
		const runId = (globalThis as { __pendingRun?: string }).__pendingRun ?? '';
		const fin = await finishOf(runId);
		expect(fin.status).toBe('succeeded');
		expect(fin.pr).not.toBeNull();
	});

	it('führt ein Angebot aus dem SSE-Strom aus (accept → events → finish)', async () => {
		atrium.failEvents = 1; // erster Batch schlägt fehl → wird erneut gesendet
		const o = offer();
		atrium.send({ type: 'offer', offer: o });
		const fin = await finishOf(o.runId);
		expect(fin.status).toBe('succeeded');
		const paths = atrium.requests.filter((r) => r.path.startsWith(`/runner/runs/${o.runId}/`)).map((r) => r.path.split('/').pop());
		expect(paths[0]).toBe('accept');
		expect(paths.at(-1)).toBe('finish');
		const ok = atrium.byPath(new RegExp(`/runs/${o.runId}/events$`)).filter((r) => !r.invalid);
		const seqs = ok.flatMap((r) => (r.body as { events: { seq: number }[] }).events.map((e) => e.seq));
		expect(seqs).toEqual([...Array(seqs.length).keys()]);
		expect(remote.sha(o.branch)).not.toBeNull();
	});

	it('bricht Läufe aus der Heartbeat-Antwort ab', async () => {
		const o = offer({ prompt: '[fake:slow]' });
		atrium.send({ type: 'offer', offer: o });
		await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/accept`);
		const hb = await atrium.waitFor(
			(r) => r.path === '/runner/heartbeat' && ((r.body as { runIds: string[] }).runIds ?? []).includes(o.runId),
			20_000
		);
		expect(hb.invalid).toBeUndefined();
		atrium.cancel.push(o.runId);
		const fin = await finishOf(o.runId);
		expect(fin.status).toBe('cancelled');
	});

	it('bricht Läufe über den cancel-Befehl ab', async () => {
		const o = offer({ prompt: '[fake:slow]' });
		atrium.send({ type: 'offer', offer: o });
		await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/accept`);
		atrium.send({ type: 'cancel', runId: o.runId, reason: 'Person hat abgebrochen' });
		const fin = await finishOf(o.runId);
		expect(fin).toMatchObject({ status: 'cancelled', errorMessage: 'Person hat abgebrochen' });
	});

	it('beantwortet Datei-RPCs auf der Haupt-Arbeitskopie', async () => {
		const list = await rpc('fs.list', { path: '' });
		expect(list.ok).toBe(true);
		expect(list.result.entries.map((e: { name: string }) => e.name)).toContain('README.md');
		expect(list.result.entries.map((e: { name: string }) => e.name)).not.toContain('.git');

		const w = await rpc('fs.write', { path: 'docs/neu.md', content: 'Hallo Welt ✓' });
		expect(w.ok).toBe(true);
		const r = await rpc('fs.read', { path: 'docs/neu.md' });
		expect(r.result).toMatchObject({ encoding: 'utf8', content: 'Hallo Welt ✓', truncated: false });

		const bin = await rpc('fs.write', { path: 'bild.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' });
		expect(bin.ok).toBe(true);
		const rb = await rpc('fs.read', { path: 'bild.bin' });
		expect(rb.result).toMatchObject({ encoding: 'base64', content: 'AAEC/w==' });

		const status = await rpc('git.status');
		expect(status.result.branch).toBe('main');
		expect(status.result.files).toEqual(expect.arrayContaining([{ path: 'docs/neu.md', status: '??' }]));

		expect((await rpc('fs.write', { path: '../ausbruch.txt', content: 'x' })).ok).toBe(false);
		expect((await rpc('fs.write', { path: '.git/config', content: 'x' })).error).toContain('.git');
		expect((await rpc('fs.delete', { path: 'docs' })).error).toContain('nicht leer');
		expect((await rpc('fs.delete', { path: 'docs/neu.md' })).ok).toBe(true);
		expect((await rpc('fs.delete', { path: 'docs' })).ok).toBe(true);

		const log = await rpc('git.log');
		expect(log.result.commits[0]).toMatchObject({ message: 'Erster Commit' });
	});

	it('beantwortet RPCs auf Lauf-Worktrees, Diff, PRs und Repo-Prüfung', async () => {
		const o = offer({ prompt: 'Für den Diff' });
		atrium.send({ type: 'offer', offer: o });
		await finishOf(o.runId);
		const list = await rpc('fs.list', {}, `run:${o.runId}`);
		expect(list.result.entries.map((e: { name: string }) => e.name)).toContain('AIDEV_FAKE.md');
		const missing = await rpc('fs.list', {}, `run:${randomUUID()}`);
		expect(missing).toMatchObject({ ok: false, error: 'Worktree nicht mehr vorhanden' });

		const diff = await rpc('git.diff', { base: 'main', head: o.branch }, `run:${o.runId}`);
		expect(diff.ok).toBe(true);
		expect(diff.result.files).toEqual([{ path: 'AIDEV_FAKE.md', additions: expect.any(Number), deletions: 0 }]);
		expect(diff.result.diff).toContain('+# Fake-Agent');
		expect(diff.result.truncated).toBe(false);
		expect((await rpc('git.diff', { base: '--output=/tmp/x' })).ok).toBe(false);

		const prs = await rpc('gh.pr-list');
		expect(prs.ok).toBe(true);
		expect(prs.result.pulls.length).toBeGreaterThan(0);
		expect(prs.result.pulls[0]).toMatchObject({ state: 'open', checks: 'success', autoMerge: false });

		const merge = await rpc('gh.pr-merge', { number: prs.result.pulls[0].number, method: 'squash' });
		expect(merge.ok).toBe(true);
		expect((await rpc('gh.pr-merge', { number: 1, method: 'evil' })).ok).toBe(false);

		const check = await rpc('repo.check');
		expect(check.result).toEqual({
			ok: true,
			defaultBranch: 'main',
			canPush: true,
			message: expect.any(String),
			branches: expect.arrayContaining(['main'])
		});
		expect(check.result.branches[0]).toBe('main');
	});

	it('beendet Terminals auf fehlenden Worktrees mit Fehlermeldung', async () => {
		const sid = randomUUID();
		atrium.send({ type: 'pty-open', sid, project, target: `run:${randomUUID()}`, cols: 80, rows: 24 });
		const exit = await atrium.waitFor((r) => r.path === `/runner/pty/${sid}/exit`);
		expect(exit.body).toEqual({ code: 1 });
		const out = atrium.byPath(new RegExp(`/pty/${sid}/output$`));
		expect((out[0]?.body as { data: string }).data).toMatch(/Worktree nicht mehr vorhanden|node-pty/);
	});

	it('lehnt Angebote ab, wenn alle Slots belegt sind', async () => {
		const a = offer({ prompt: '[fake:slow]' });
		const b = offer({ prompt: '[fake:slow]' });
		const c = offer({ prompt: '[fake:slow]' });
		atrium.send({ type: 'offer', offer: a });
		atrium.send({ type: 'offer', offer: b });
		await atrium.waitFor((r) => r.path === `/runner/runs/${b.runId}/accept`);
		atrium.send({ type: 'offer', offer: c });
		const rej = await atrium.waitFor((r) => r.path === `/runner/runs/${c.runId}/reject`);
		expect((rej.body as { reason: string }).reason).toContain('Slots');
		atrium.send({ type: 'cancel', runId: a.runId, reason: '' });
		atrium.send({ type: 'cancel', runId: b.runId, reason: '' });
		expect((await finishOf(a.runId)).status).toBe('cancelled');
		expect((await finishOf(b.runId)).status).toBe('cancelled');
	});

	it('meldet den Limit-Stand im Heartbeat', async () => {
		const hb = await atrium.waitFor(
			(r) => r.path === '/runner/heartbeat' && Boolean((r.body as { accounts: { limits?: unknown }[] }).accounts?.[0]?.limits),
			20_000
		);
		expect(hb.invalid).toBeUndefined();
		expect((hb.body as { accounts: unknown[] }).accounts[0]).toMatchObject({
			key: 'fake-1',
			loggedIn: true,
			limits: { source: 'stream', windows: [{ window: '5h', label: 'five_hour', status: expect.any(String) }] }
		});
	});

	it('sendet bei einem Limit-Treffer die bekannten Fenster mit', async () => {
		const o = offer({ prompt: '[fake:limit]' });
		atrium.send({ type: 'offer', offer: o });
		const lim = await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/limit`);
		expect(lim.invalid).toBeUndefined();
		expect(lim.body).toMatchObject({
			kind: '5h',
			windows: [{ window: '5h', usedPercent: 100, status: 'rejected' }]
		});
		expect((await finishOf(o.runId)).status).toBe('limited');
		expect(runner.limits.snapshot('fake-1')?.windows[0]).toMatchObject({ window: '5h', status: 'rejected' });
	});

	it('wartet beim Beenden mit Frist auf laufende Läufe und meldet draining', async () => {
		const o = offer({ prompt: '[fake:slow]' });
		atrium.send({ type: 'offer', offer: o });
		await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/accept`);
		const skip = new AbortController();
		let done = false;
		const stopping = runner.shutdown({ drainSec: 60, skipDrain: skip.signal }).then(() => {
			done = true;
		});
		const hb = await atrium.waitFor((r) => r.path === '/runner/heartbeat' && (r.body as { draining?: boolean }).draining === true);
		expect(hb.invalid).toBeUndefined();
		expect((hb.body as { runIds: string[] }).runIds).toContain(o.runId);
		// keine neuen Läufe während der Frist
		const late = offer();
		atrium.send({ type: 'offer', offer: late });
		const rej = await atrium.waitFor((r) => r.path === `/runner/runs/${late.runId}/reject`);
		expect((rej.body as { reason: string }).reason).toContain('beendet');
		expect(atrium.requests.some((r) => r.path === `/runner/runs/${o.runId}/finish`)).toBe(false);
		expect(done).toBe(false);
		// zweites Signal: Frist abbrechen → Lauf wird abgebrochen und neu eingeplant
		skip.abort();
		expect(await finishOf(o.runId)).toMatchObject({ status: 'cancelled', errorMessage: 'Runner wird beendet' });
		await stopping;
		expect(done).toBe(true);
	});

	it('sendet keine Anfrage mit ungültigem Body', () => {
		const bad = atrium.requests.filter((r) => r.invalid && r.invalid !== 'simulierter Fehler');
		expect(bad).toEqual([]);
	});
});

describe('Runner.heartbeatAccounts', () => {
	it('sendet den Limit-Stand nur, wenn er sich geändert hat oder jünger als 30 min ist', () => {
		const acct = accountConfigSchema.parse({ key: 'claude-main', provider: 'claude' });
		const r = new Runner({
			config: {
				atriumUrl: 'http://127.0.0.1:9',
				apiKey: 'test-api-key',
				name: 'x',
				workDir: '/tmp/aidev-hb-test',
				maxSlots: 1,
				gitRemoteTemplate: 'https://github.com/{owner}/{repo}.git',
				gitAuthorName: 'A',
				gitAuthorEmail: 'a@b.c',
				accounts: [acct],
				limitProbe: false,
				configFile: null
			},
			redactor: new Redactor()
		});
		(r as unknown as { accounts: Map<string, AccountState> }).accounts = new Map([
			[acct.key, { config: acct, ok: true, loggedIn: true, version: '1' }]
		]);
		const t0 = new Date('2026-11-25T10:00:00.000Z');
		const at = (min: number) => new Date(t0.getTime() + min * 60_000);
		const win = (usedPercent: number) => ({ window: '5h' as const, label: 'five_hour', usedPercent, resetsAt: null, status: 'allowed' as const });

		expect(r.heartbeatAccounts(t0)).toEqual([{ key: 'claude-main', loggedIn: true }]);
		r.limits.update(acct.key, [win(10)], 'probe', t0);
		// frisch → in jedem Heartbeat
		expect(r.heartbeatAccounts(at(1))[0]?.limits).toMatchObject({ observedAt: t0.toISOString(), windows: [win(10)] });
		expect(r.heartbeatAccounts(at(29))[0]?.limits).toBeDefined();
		// älter als 30 min und unverändert → nicht mehr
		expect(r.heartbeatAccounts(at(31))[0]).toEqual({ key: 'claude-main', loggedIn: true });
		// geändert (auch wenn alt) → einmal senden
		r.limits.update(acct.key, [win(20)], 'probe', at(2));
		expect(r.heartbeatAccounts(at(40))[0]?.limits?.windows).toEqual([win(20)]);
		expect(r.heartbeatAccounts(at(41))[0]?.limits).toBeUndefined();
	});
});
