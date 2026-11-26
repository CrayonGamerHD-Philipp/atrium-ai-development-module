/**
 * Übergabe laufender Läufe (Standby/Herunterfahren des PCs): WIP-Commit und Push ohne Force, `finish` mit
 * `handoff`, Frist sowie Auslieferungssperre nach dem Aufwachen (`holdDelivery`/`releaseDelivery`).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AtriumClient, RunnerApi } from '../src/client.ts';
import { accountConfigSchema, publicEnv, type RunnerConfig } from '../src/config.ts';
import { Executor, type AccountState } from '../src/executor.ts';
import { Workspace } from '../src/git/workspace.ts';
import { defaultAdapters } from '../src/providers/index.ts';
import type { FinishInput, RunOffer } from '../src/protocol.ts';
import { Redactor } from '../src/redact.ts';
import { createRemote, git, type Remote, setupTestEnv, type TestEnv } from './helpers/env.ts';
import { FakeAtrium } from './helpers/fake-atrium.ts';

let env: TestEnv;
let atrium: FakeAtrium;
let remote: Remote;
let executor: Executor;
let workspace: Workspace;
const projectId = randomUUID();
const fakeAcct = accountConfigSchema.parse({ key: 'fake-1', provider: 'fake' });

beforeAll(async () => {
	env = await setupTestEnv();
	atrium = new FakeAtrium();
	await atrium.start();
	remote = await createRemote(env, 'acme', 'shop');
	const config: RunnerConfig = {
		atriumUrl: atrium.url,
		apiKey: atrium.apiKey,
		name: 'test',
		workDir: env.workDir,
		maxSlots: 4,
		gitRemoteTemplate: env.remoteTemplate,
		gitAuthorName: 'Atrium Agent',
		gitAuthorEmail: 'agent@atrium.local',
		accounts: [fakeAcct],
		configFile: null
	};
	const api = new RunnerApi(new AtriumClient({ atriumUrl: atrium.url, apiKey: atrium.apiKey, backoffBaseMs: 5 }));
	workspace = new Workspace({
		workDir: env.workDir,
		remoteTemplate: env.remoteTemplate,
		author: { name: 'Atrium Agent', email: 'agent@atrium.local' },
		env: publicEnv(process.env),
		useGhCredentials: false
	});
	const accounts = new Map<string, AccountState>([
		['fake-1', { config: fakeAcct, ok: true, loggedIn: true, version: 'fake-1' }]
	]);
	executor = new Executor({
		config,
		api,
		workspace,
		adapters: defaultAdapters,
		redactor: new Redactor([atrium.apiKey]),
		accounts: () => accounts,
		batcherFlushMs: 20
	});
});

afterAll(async () => {
	executor?.releaseDelivery();
	await executor?.shutdown(5000);
	await atrium?.stop();
	await env?.cleanup();
});

function offer(over: Partial<RunOffer> = {}): RunOffer {
	const taskId = randomUUID();
	return {
		runId: randomUUID(),
		taskId,
		attempt: 1,
		role: 'implement',
		title: 'README ergänzen',
		prompt: '[fake:slow] Bitte die README ergänzen.',
		systemPrompt: 'Du bist ein Test-Agent.',
		project: {
			id: projectId,
			name: 'Shop',
			repoOwner: 'acme',
			repoName: 'shop',
			defaultBranch: 'main',
			setupCmd: '',
			testCmd: ''
		},
		account: { key: 'fake-1', provider: 'fake' },
		model: null,
		branch: `aidev/${taskId.slice(0, 8)}-wip`,
		baseRef: 'main',
		readOnly: false,
		expectPlan: false,
		resumeSessionId: null,
		delivery: { mode: 'pr', autoMerge: false, title: 'README ergänzen', body: '' },
		leaseSec: 90,
		timeoutSec: 120,
		...over
	};
}

const wtDir = (runId: string) => path.join(env.workDir, 'wt', runId);

function events(runId: string): { kind: string; payload: { text?: string } }[] {
	return atrium
		.byPath(new RegExp(`/runs/${runId}/events$`))
		.flatMap((r) => (r.body as { events: { kind: string; payload: { text?: string } }[] }).events);
}

/** Lauf annehmen und warten, bis der (langsame) Fake-Agent läuft */
async function startSlow(o: RunOffer): Promise<void> {
	expect(await executor.handleOffer(o)).toBe('accepted');
	const until = Date.now() + 30_000;
	while (!events(o.runId).some((e) => e.payload.text === 'Fake-Agent gestartet')) {
		if (Date.now() > until) throw new Error('Agent startet nicht');
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function finishOf(runId: string): Promise<FinishInput> {
	const fin = await atrium.waitFor((r) => r.path === `/runner/runs/${runId}/finish`);
	expect(fin.invalid).toBeUndefined();
	return fin.body as FinishInput;
}

const finishCount = (runId: string) => atrium.byPath(new RegExp(`/runs/${runId}/finish$`)).length;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `pre-receive`-Hook im Test-Remote, der Pushes festhält, solange die Sperrdatei existiert (simuliert einen
 * gerade laufenden Push). `started` wartet, bis ein Push im Hook hängt.
 */
function blockPushes(): { started(): Promise<void>; unblock(): void; remove(): void } {
	const hook = path.join(remote.bare, 'hooks', 'pre-receive');
	const marker = path.join(env.tmp, 'push-started');
	const block = path.join(env.tmp, 'push-block');
	rmSync(marker, { force: true });
	writeFileSync(block, '');
	writeFileSync(
		hook,
		`#!/bin/sh\ncat >/dev/null\ntouch "${marker}"\nwhile [ -f "${block}" ]; do sleep 0.05; done\nexit 0\n`
	);
	chmodSync(hook, 0o755);
	return {
		async started() {
			const until = Date.now() + 30_000;
			while (!existsSync(marker)) {
				if (Date.now() > until) throw new Error('Push startet nicht');
				await sleep(20);
			}
		},
		unblock: () => rmSync(block, { force: true }),
		remove() {
			rmSync(block, { force: true });
			rmSync(hook, { force: true });
		}
	};
}

describe('handoff', () => {
	it('schreibender Lauf: WIP-Commit liegt auf origin/<branch>, finish mit handoff.wipPushed', async () => {
		const o = offer();
		await startSlow(o);
		// Zwischenstand des Agents im Worktree
		writeFileSync(path.join(wtDir(o.runId), 'ZWISCHENSTAND.md'), 'halb fertig\n');
		const n = await executor.handoff('suspend', { deadlineMs: 8000, pushWip: true });
		expect(n).toBe(1);
		const fin = await finishOf(o.runId);
		expect(fin).toMatchObject({
			status: 'cancelled',
			errorKind: 'cancelled',
			errorMessage: 'Übergabe: PC geht in den Standby',
			branch: o.branch
		});
		expect(fin.handoff).toMatchObject({ reason: 'suspend', wipPushed: true });
		expect(fin.handoff?.headSha).toMatch(/^[0-9a-f]{40}$/);
		expect(fin.headSha).toBe(fin.handoff?.headSha);
		expect(remote.sha(o.branch)).toBe(fin.handoff?.headSha);
		expect(remote.read(o.branch, 'ZWISCHENSTAND.md')).toBe('halb fertig\n');
		const msg = git(remote.bare, 'log', '-1', '--format=%B', o.branch);
		expect(msg).toContain('wip(aidev): Zwischenstand vor Übergabe');
		expect(msg).toContain(`Aidev-Task: ${o.taskId}`);
		expect(msg).toContain('Aidev-Handoff: suspend');
		// kein PR, Worktree bleibt erhalten
		expect(env.ghCalls().some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(false);
		expect(existsSync(path.join(wtDir(o.runId), 'ZWISCHENSTAND.md'))).toBe(true);
		expect(finishCount(o.runId)).toBe(1);
		// keine neuen Angebote bis resumeOffers
		expect(await executor.handleOffer(offer())).toBe('rejected');
		executor.resumeOffers();
	});

	it('Nur-Lese-Lauf und pr-update: kein Push, wipPushed false', async () => {
		const ro = offer({ role: 'review', readOnly: true });
		const branch = `aidev/${randomUUID().slice(0, 8)}-pr`;
		const prSha = remote.commitFile(branch, 'PR.md', 'vom PR\n', 'Vorhandener PR-Commit');
		const pr = env.addGhPr({ repo: 'acme/shop', head: branch });
		const upd = offer({ branch, delivery: { mode: 'pr-update', number: pr.number } });
		await startSlow(ro);
		await startSlow(upd);
		writeFileSync(path.join(wtDir(ro.runId), 'LESEN.md'), 'x\n');
		writeFileSync(path.join(wtDir(upd.runId), 'PR-WIP.md'), 'x\n');
		expect(await executor.handoff('shutdown', { deadlineMs: 8000, pushWip: true })).toBe(2);
		executor.resumeOffers();
		for (const o of [ro, upd]) {
			const fin = await finishOf(o.runId);
			expect(fin).toMatchObject({
				status: 'cancelled',
				errorKind: 'cancelled',
				errorMessage: 'Übergabe: PC wird heruntergefahren'
			});
			expect(fin.handoff).toMatchObject({ reason: 'shutdown', wipPushed: false, headSha: null });
		}
		expect(remote.sha(ro.branch)).toBeNull();
		expect(remote.sha(branch)).toBe(prSha);
		expect(remote.read(branch, 'PR-WIP.md')).toBeNull();
	});

	it('pushWip false: kein handoff-Feld und kein Push', async () => {
		const o = offer();
		await startSlow(o);
		writeFileSync(path.join(wtDir(o.runId), 'ZWISCHENSTAND.md'), 'x\n');
		expect(await executor.handoff('shutdown', { deadlineMs: 8000, pushWip: false })).toBe(1);
		executor.resumeOffers();
		const fin = await finishOf(o.runId);
		expect(fin).toMatchObject({ status: 'cancelled', errorKind: 'cancelled' });
		expect(fin.handoff).toBeUndefined();
		expect(remote.sha(o.branch)).toBeNull();
	});

	it('Frist überschritten: trotzdem cancelled gemeldet, danach kein Push', async () => {
		const o = offer();
		await startSlow(o);
		writeFileSync(path.join(wtDir(o.runId), 'ZWISCHENSTAND.md'), 'x\n');
		// Repository-Sperre belegen: Commit/Push des Zwischenstands kommt nicht zum Zug
		let unblock: () => void = () => undefined;
		const blocked = new Promise<void>((r) => (unblock = r));
		const lock = workspace.withRepo({ repoOwner: 'acme', repoName: 'shop' }, () => blocked);
		const t0 = Date.now();
		expect(await executor.handoff('suspend', { deadlineMs: 600, pushWip: true })).toBe(1);
		expect(Date.now() - t0).toBeLessThan(2000);
		const fin = await finishOf(o.runId);
		expect(fin).toMatchObject({ status: 'cancelled', errorKind: 'cancelled', errorMessage: 'Übergabe: PC geht in den Standby' });
		expect(fin.handoff).toMatchObject({ reason: 'suspend', wipPushed: false });
		unblock();
		await lock;
		await executor.idle();
		expect(remote.sha(o.branch)).toBeNull();
		expect(finishCount(o.runId)).toBe(1);
		executor.resumeOffers();
	});

	it('Übergabe bei gesperrter Auslieferung (Laufbesitz ungeklärt): kein Zwischenstand gepusht', async () => {
		const o = offer();
		await startSlow(o);
		writeFileSync(path.join(wtDir(o.runId), 'ZWISCHENSTAND.md'), 'x\n');
		executor.holdDelivery();
		try {
			expect(await executor.handoff('suspend', { deadlineMs: 8000, pushWip: true })).toBe(1);
			const fin = await finishOf(o.runId);
			expect(fin).toMatchObject({ status: 'cancelled', handoff: { reason: 'suspend', wipPushed: false, headSha: null } });
			expect(remote.sha(o.branch)).toBeNull();
		} finally {
			executor.releaseDelivery();
			executor.resumeOffers();
		}
	});

	it('holdDelivery + cancel + releaseDelivery: kein Push, cancelled', async () => {
		executor.holdDelivery();
		const o = offer({ prompt: 'Bitte die README ergänzen.' });
		expect(await executor.handleOffer(o)).toBe('accepted');
		// Agent ist fertig, die Auslieferung wartet am Gate
		const until = Date.now() + 30_000;
		while (!existsSync(path.join(wtDir(o.runId), 'AIDEV_FAKE.md')) && Date.now() < until)
			await new Promise((r) => setTimeout(r, 20));
		await new Promise((r) => setTimeout(r, 300));
		expect(finishCount(o.runId)).toBe(0);
		expect(remote.sha(o.branch)).toBeNull();
		expect(executor.cancel(o.runId, 'Von Atrium abgebrochen')).toBe(true);
		await new Promise((r) => setTimeout(r, 200));
		expect(finishCount(o.runId)).toBe(0);
		executor.releaseDelivery();
		const fin = await finishOf(o.runId);
		expect(fin).toMatchObject({ status: 'cancelled', errorKind: 'cancelled', errorMessage: 'Von Atrium abgebrochen' });
		expect(fin.handoff).toBeUndefined();
		expect(remote.sha(o.branch)).toBeNull();
		expect(git(wtDir(o.runId), 'log', '-1', '--format=%s')).toBe('Erster Commit');
	});

	// Prozessgruppen und Shell-Hook: nur POSIX
	it.skipIf(process.platform === 'win32')('Besitzverlust während eines laufenden Pushes: Push wird abgebrochen, nichts ausgeliefert', async () => {
		const blocker = blockPushes();
		try {
			const o = offer({ prompt: 'Bitte die README ergänzen.' });
			expect(await executor.handleOffer(o)).toBe('accepted');
			await blocker.started();
			// Heartbeat-Antwort: Atrium hat den Lauf inzwischen einem anderen Runner gegeben
			expect(executor.cancel(o.runId, 'Von Atrium abgebrochen')).toBe(true);
			const fin = await finishOf(o.runId);
			expect(fin).toMatchObject({ status: 'cancelled', errorKind: 'cancelled', branchPushed: false, pr: null });
			blocker.unblock();
			await sleep(300);
			expect(remote.sha(o.branch)).toBeNull();
			expect(env.ghCalls().some((c) => c[0] === 'pr' && c[1] === 'create' && c.includes(o.branch))).toBe(false);
		} finally {
			blocker.remove();
		}
	});

	it.skipIf(process.platform === 'win32')('Besitzverlust während der direkten Auslieferung: kein Push auf main', async () => {
		const mainBefore = remote.sha('main');
		const blocker = blockPushes();
		try {
			const o = offer({ prompt: 'Direkt ändern', delivery: { mode: 'direct' } });
			expect(await executor.handleOffer(o)).toBe('accepted');
			await blocker.started();
			expect(executor.cancel(o.runId, 'Von Atrium abgebrochen')).toBe(true);
			const fin = await finishOf(o.runId);
			expect(fin).toMatchObject({ status: 'cancelled', merged: false });
			blocker.unblock();
			await sleep(300);
			expect(remote.sha('main')).toBe(mainBefore);
		} finally {
			blocker.remove();
		}
	});

	it.skipIf(process.platform === 'win32')('Standby während eines laufenden Pushes: Übergabe bricht den Push ab', async () => {
		const blocker = blockPushes();
		try {
			const o = offer({ prompt: 'Bitte die README ergänzen.' });
			expect(await executor.handleOffer(o)).toBe('accepted');
			await blocker.started();
			const t0 = Date.now();
			expect(await executor.handoff('suspend', { deadlineMs: 3000, pushWip: false })).toBe(1);
			expect(Date.now() - t0).toBeLessThan(5000);
			const fin = await finishOf(o.runId);
			expect(fin).toMatchObject({ status: 'cancelled', errorMessage: 'Übergabe: PC geht in den Standby', pr: null });
			blocker.unblock();
			await sleep(300);
			expect(remote.sha(o.branch)).toBeNull();
		} finally {
			blocker.remove();
			executor.resumeOffers();
		}
	});

	it.skipIf(process.platform === 'win32')('Sperre während eines laufenden Pushes: abgebrochen, nach der Freigabe wiederholt', async () => {
		const blocker = blockPushes();
		try {
			const o = offer({ prompt: 'Bitte die README ergänzen.' });
			expect(await executor.handleOffer(o)).toBe('accepted');
			await blocker.started();
			// Aufgewacht: Laufbesitz ungeklärt → laufender Push wird beendet
			executor.holdDelivery();
			const until = Date.now() + 30_000;
			while (!events(o.runId).some((e) => e.payload.text?.startsWith('Auslieferung unterbrochen'))) {
				if (Date.now() > until) throw new Error('Push wird nicht unterbrochen');
				await sleep(20);
			}
			blocker.unblock();
			await sleep(300);
			expect(remote.sha(o.branch)).toBeNull();
			expect(finishCount(o.runId)).toBe(0);
			// Heartbeat ohne cancel: Lauf gehört weiter hierher → Push und PR nach der Freigabe
			executor.releaseDelivery();
			const fin = await finishOf(o.runId);
			expect(fin.status).toBe('succeeded');
			expect(fin.pr).not.toBeNull();
			expect(remote.read(o.branch, 'AIDEV_FAKE.md')).toContain('Bitte die README ergänzen.');
		} finally {
			blocker.remove();
			executor.releaseDelivery();
		}
	});

	it('holdDelivery + releaseDelivery ohne Abbruch: Auslieferung läuft normal weiter', async () => {
		executor.holdDelivery();
		const o = offer({ prompt: 'Bitte die README ergänzen.' });
		expect(await executor.handleOffer(o)).toBe('accepted');
		await new Promise((r) => setTimeout(r, 500));
		expect(finishCount(o.runId)).toBe(0);
		expect(remote.sha(o.branch)).toBeNull();
		executor.releaseDelivery();
		const fin = await finishOf(o.runId);
		expect(fin.status).toBe('succeeded');
		expect(fin.pr).not.toBeNull();
		expect(remote.read(o.branch, 'AIDEV_FAKE.md')).toContain('Bitte die README ergänzen.');
	});
});
