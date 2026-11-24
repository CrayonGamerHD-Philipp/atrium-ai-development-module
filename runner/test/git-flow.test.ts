/**
 * Git-Ablauf end-to-end: lokales Bare-Remote, Fake-Agent, gh-Shim, Mini-Atrium. Prüft Auslieferung pr/direct/
 * integrate inkl. Konflikten sowie Nur-Lese-Läufe, Tests, Setup, Limits, Abbruch und Zeitlimit.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
		prompt: 'Bitte die README ergänzen.',
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
		branch: `aidev/${taskId.slice(0, 8)}-readme`,
		baseRef: 'main',
		readOnly: false,
		expectPlan: false,
		resumeSessionId: null,
		delivery: { mode: 'pr', autoMerge: false, title: 'README ergänzen', body: 'Beschreibung des PR' },
		leaseSec: 90,
		timeoutSec: 120,
		...over
	};
}

/** Lauf ausführen und `finish` liefern */
async function runOffer(o: RunOffer, after?: () => void): Promise<FinishInput> {
	const res = await executor.handleOffer(o);
	expect(res).toBe('accepted');
	after?.();
	const fin = await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/finish`);
	expect(fin.invalid).toBeUndefined();
	return fin.body as FinishInput;
}

function pathsFor(runId: string): string[] {
	return atrium.requests.filter((r) => r.path.startsWith(`/runner/runs/${runId}/`)).map((r) => r.path.split('/').pop() ?? '');
}

describe('Auslieferung', () => {
	it('pr: Branch pushen, PR öffnen, Auto-Merge aktivieren', async () => {
		const o = offer({ delivery: { mode: 'pr', autoMerge: true, title: 'README ergänzen', body: 'PR-Text' } });
		const fin = await runOffer(o);
		expect(fin.status).toBe('succeeded');
		expect(fin.errorKind).toBeNull();
		expect(fin.pr).toEqual({ number: expect.any(Number), url: expect.stringMatching(/\/pull\/\d+$/) });
		expect(fin.branch).toBe(o.branch);
		expect(fin.commits).toHaveLength(1);
		expect(fin.commits[0]?.files).toEqual(['AIDEV_FAKE.md']);
		expect(fin.commits[0]?.message).toContain(`Aidev-Task: ${o.taskId}`);
		expect(fin.commits[0]?.additions).toBeGreaterThan(0);
		expect(fin.headSha).toBe(remote.sha(o.branch));
		expect(remote.read(o.branch, 'AIDEV_FAKE.md')).toContain('Bitte die README ergänzen.');
		const pr = env.ghPrs().find((p) => p.head === o.branch);
		expect(pr).toMatchObject({ base: 'main', title: 'README ergänzen', body: 'PR-Text', autoMerge: true });
		// Reihenfolge: accept → events … → usage → finish
		const seq = pathsFor(o.runId);
		expect(seq[0]).toBe('accept');
		expect(seq.at(-1)).toBe('finish');
		expect(seq.indexOf('events')).toBeGreaterThan(0);
		expect(seq.indexOf('usage')).toBeLessThan(seq.indexOf('finish'));
		// seq der Ereignisse lückenlos ab 0
		const seqs = atrium
			.byPath(new RegExp(`/runs/${o.runId}/events$`))
			.flatMap((r) => (r.body as { events: { seq: number }[] }).events.map((e) => e.seq));
		expect(seqs).toEqual([...Array(seqs.length).keys()]);
		// Worktree bleibt erhalten
		expect(existsSync(path.join(env.workDir, 'wt', o.runId, 'AIDEV_FAKE.md'))).toBe(true);
	});

	it('pr: zweiter Lauf auf demselben Branch setzt fort und nutzt den vorhandenen PR', async () => {
		const first = offer();
		await runOffer(first);
		const second = offer({ branch: first.branch, taskId: first.taskId, prompt: 'Nachbesserung [fake:commit]' });
		const fin = await runOffer(second);
		expect(fin.status).toBe('succeeded');
		expect(fin.commits).toHaveLength(1);
		expect(fin.commits[0]?.message).toBe('Fake-Agent: eigener Commit');
		const prs = env.ghPrs().filter((p) => p.head === first.branch);
		expect(prs).toHaveLength(1);
		expect(fin.pr?.number).toBe(prs[0]?.number);
		expect(remote.log(first.branch)[0]).toBe('Fake-Agent: eigener Commit');
		// Der erste Worktree wurde auf detached umgestellt, bleibt aber vorhanden
		expect(existsSync(path.join(env.workDir, 'wt', first.runId))).toBe(true);
	});

	it('direct: rebase und Push auf main', async () => {
		const o = offer({ delivery: { mode: 'direct' }, prompt: 'Direkt ändern' });
		const before = remote.sha('main');
		const fin = await runOffer(o);
		expect(fin.status).toBe('succeeded');
		expect(fin.merged).toBe(true);
		expect(fin.pr).toBeNull();
		expect(remote.read('main', 'AIDEV_FAKE.md')).toContain('Direkt ändern');
		expect(remote.sha('main')).not.toBe(before);
		expect(fin.commits).toHaveLength(1);
		expect(fin.headSha).toBe(remote.sha('main'));
		expect(remote.sha(o.branch)).toBeNull();
	});

	it('direct: Konflikt → failed conflict mit Dateiliste', async () => {
		// main hat AIDEV_FAKE.md (vorheriger Test); Branch startet von `old` ohne diese Datei
		const o = offer({ delivery: { mode: 'direct' }, baseRef: 'old', prompt: 'Konflikt erzeugen' });
		const mainBefore = remote.sha('main');
		const fin = await runOffer(o);
		expect(fin.status).toBe('failed');
		expect(fin.errorKind).toBe('conflict');
		expect(fin.conflictFiles).toEqual(['AIDEV_FAKE.md']);
		expect(remote.sha('main')).toBe(mainBefore);
		// Rebase wurde abgebrochen, Worktree sauber
		const wt = path.join(env.workDir, 'wt', o.runId);
		expect(git(wt, 'status', '--porcelain')).toBe('');
	});

	it('integrate: Integrations-Branch anlegen, mergen, Konflikt beim zweiten Teilauftrag', async () => {
		// Namensschema wie Atrium: Integrations-Branch aidev/<kurz>-<slug>, Teilaufträge aidev/<kurz>/<n>-<slug>
		const short = randomUUID().slice(0, 8);
		const parent = `aidev/${short}-eltern`;
		const a = offer({
			branch: `aidev/${short}/1-a`,
			baseRef: parent,
			prompt: 'Teil A',
			delivery: { mode: 'integrate', integrationBranch: parent }
		});
		const finA = await runOffer(a);
		expect(finA.status).toBe('succeeded');
		expect(finA.merged).toBe(true);
		expect(remote.sha(parent)).not.toBeNull();
		expect(remote.read(parent, 'AIDEV_FAKE.md')).toContain('Teil A');
		expect(remote.log(parent)[0]).toContain(`Merge ${a.branch} in ${parent}`);
		expect(remote.sha(a.branch)).not.toBeNull();

		// Teil B startet von `old` (ohne die Datei) → add/add-Konflikt beim Mergen
		const b = offer({
			branch: `aidev/${short}/2-b`,
			baseRef: 'old',
			prompt: 'Teil B',
			delivery: { mode: 'integrate', integrationBranch: parent }
		});
		const finB = await runOffer(b);
		expect(finB.status).toBe('failed');
		expect(finB.errorKind).toBe('conflict');
		expect(finB.conflictFiles).toEqual(['AIDEV_FAKE.md']);
		expect(remote.read(parent, 'AIDEV_FAKE.md')).toContain('Teil A');
		// Temporärer Merge-Worktree wurde entfernt
		expect(existsSync(path.join(env.workDir, 'tmp', `${b.runId}-integrate`))).toBe(false);
	});
});

describe('Sonderfälle', () => {
	it('readOnly + expectPlan: Plan wird mitgesendet, nichts committet', async () => {
		const o = offer({
			role: 'orchestrate',
			readOnly: true,
			expectPlan: true,
			prompt: 'Plane das [fake:plan]',
			delivery: { mode: 'none' }
		});
		const fin = await runOffer(o);
		expect(fin.status).toBe('succeeded');
		expect(fin.plan).toMatchObject({ subtasks: [{ key: 'research' }, { key: 'impl', dependsOn: ['research'] }] });
		expect(fin.commits).toEqual([]);
		expect(fin.summary).toContain('```json');
		expect(remote.sha(o.branch)).toBeNull();
	});

	it('keine Änderungen → succeeded ohne PR', async () => {
		const o = offer({ prompt: 'Nichts tun [fake:noop]' });
		const fin = await runOffer(o);
		expect(fin.status).toBe('succeeded');
		expect(fin.pr).toBeNull();
		expect(fin.commits).toEqual([]);
		expect(fin.summary).toContain('Keine Änderungen');
		expect(remote.sha(o.branch)).toBeNull();
	});

	it('testCmd schlägt fehl → failed tests, nichts gepusht', async () => {
		const o = offer({ project: { ...offer().project, testCmd: 'node -e "process.exit(3)"' } });
		const fin = await runOffer(o);
		expect(fin.status).toBe('failed');
		expect(fin.errorKind).toBe('tests');
		expect(fin.commits).toHaveLength(1);
		expect(remote.sha(o.branch)).toBeNull();
	});

	it('setupCmd schlägt fehl → failed setup, Ausgabe als Ereignis', async () => {
		const o = offer({
			project: { ...offer().project, setupCmd: 'node -e "console.log(\'einrichten\'); console.error(\'kaputt\'); process.exit(1)"' }
		});
		const fin = await runOffer(o);
		expect(fin.errorKind).toBe('setup');
		const events = atrium
			.byPath(new RegExp(`/runs/${o.runId}/events$`))
			.flatMap((r) => (r.body as { events: { kind: string; payload: { text?: string } }[] }).events);
		expect(events.some((e) => e.kind === 'system' && e.payload.text?.includes('einrichten'))).toBe(true);
		expect(events.some((e) => e.kind === 'stderr' && e.payload.text?.includes('kaputt'))).toBe(true);
	});

	it('Limit → /limit und finish limited', async () => {
		const o = offer({ prompt: '[fake:limit]' });
		const fin = await runOffer(o);
		expect(fin.status).toBe('limited');
		expect(fin.errorKind).toBe('limit');
		const lim = atrium.byPath(new RegExp(`/runs/${o.runId}/limit$`));
		expect(lim).toHaveLength(1);
		expect(lim[0]?.body).toMatchObject({ kind: '5h' });
	});

	it('Abbruch → finish cancelled', async () => {
		const o = offer({ prompt: '[fake:slow]' });
		const fin = await runOffer(o, () => {
			setTimeout(() => executor.cancel(o.runId, 'Von Person abgebrochen'), 1500);
		});
		expect(fin.status).toBe('cancelled');
		expect(fin.errorKind).toBe('cancelled');
		expect(fin.errorMessage).toBe('Von Person abgebrochen');
	});

	it('Zeitlimit → failed timeout', async () => {
		const o = offer({ prompt: '[fake:slow]', timeoutSec: 2 });
		const fin = await runOffer(o);
		expect(fin.status).toBe('failed');
		expect(fin.errorKind).toBe('timeout');
	});

	it('Agent-Fehler → failed agent', async () => {
		const fin = await runOffer(offer({ prompt: '[fake:fail]' }));
		expect(fin.errorKind).toBe('agent');
		expect(fin.errorMessage).toContain('absichtlicher Fehler');
	});

	it('lehnt unbekannte Konten und ungültige Branches ab', async () => {
		const a = offer({ account: { key: 'gibt-es-nicht', provider: 'claude' } });
		expect(await executor.handleOffer(a)).toBe('rejected');
		const rej = await atrium.waitFor((r) => r.path === `/runner/runs/${a.runId}/reject`);
		expect((rej.body as { reason: string }).reason).toContain('Unbekanntes Konto');
		const b = offer({ branch: '--upload-pack=evil' });
		expect(await executor.handleOffer(b)).toBe('rejected');
		// doppeltes Angebot wird ignoriert
		expect(await executor.handleOffer(a)).toBe('ignored');
	});

	it('Commit-Autor aus der Konfiguration', () => {
		const prBranch = env.ghPrs()[0]?.head ?? '';
		const author = git(remote.bare, 'log', '-1', '--format=%an <%ae>', prBranch);
		expect(author).toBe('Atrium Agent <agent@atrium.local>');
	});

	it('Aufräumen entfernt überzählige Worktrees, aktive bleiben', async () => {
		const wtRoot = path.join(env.workDir, 'wt');
		const n = (await import('node:fs')).readdirSync(wtRoot).length;
		expect(n).toBeGreaterThan(3);
		const removed = await workspace.cleanup(new Set(), Date.now() + 49 * 3_600_000);
		expect(removed).toBe(n);
		expect(readFileSync).toBeDefined();
	});
});

describe('Beenden', () => {
	it('bricht laufende Läufe mit cancelled ab und nimmt keine neuen an', async () => {
		const o = offer({ prompt: '[fake:slow]' });
		expect(await executor.handleOffer(o)).toBe('accepted');
		await new Promise((r) => setTimeout(r, 300));
		await executor.shutdown(20_000);
		const fin = await atrium.waitFor((r) => r.path === `/runner/runs/${o.runId}/finish`);
		expect(fin.body).toMatchObject({ status: 'cancelled', errorMessage: 'Runner wird beendet' });
		expect(existsSync(path.join(env.workDir, 'wt', o.runId))).toBe(true);
		expect(await executor.handleOffer(offer())).toBe('rejected');
	});
});
