/**
 * RPC `git.branch-delete` end-to-end gegen ein lokales Bare-Remote: Löschen, fehlende Branches, Aufräumen des Caches
 * (Worktrees aktiver Läufe bleiben unangetastet), erwarteter Stand (`expect`), Schutz durch offene PRs (live über gh,
 * auch jenseits der ersten 100; Forks zählen nicht) und strenge Validierung der Argumente.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicEnv } from '../src/config.ts';
import { Workspace } from '../src/git/workspace.ts';
import { MAX_BRANCH_DELETE, type RpcCommand } from '../src/protocol.ts';
import { Redactor } from '../src/redact.ts';
import { executeRpc, OPEN_PR_LIMIT, parseBranchList, RpcError } from '../src/rpc.ts';
import { createRemote, git, type Remote, setupTestEnv, type TestEnv } from './helpers/env.ts';

let env: TestEnv;
let remote: Remote;
let workspace: Workspace;
const project = { id: randomUUID(), repoOwner: 'acme', repoName: 'cleanup', defaultBranch: 'main' };

beforeAll(async () => {
	env = await setupTestEnv();
	remote = await createRemote(env, project.repoOwner, project.repoName);
	workspace = new Workspace({
		workDir: env.workDir,
		remoteTemplate: env.remoteTemplate,
		author: { name: 'Atrium Agent', email: 'agent@atrium.local' },
		env: publicEnv(process.env),
		useGhCredentials: false
	});
});

afterAll(async () => {
	await env?.cleanup();
});

function cmd(
	branches: unknown,
	over: Partial<RpcCommand['project']> = {},
	args: Record<string, unknown> = {}
): RpcCommand {
	return {
		type: 'rpc',
		reqId: randomUUID(),
		op: 'git.branch-delete',
		project: { ...project, ...over },
		target: 'main',
		args: { branches, ...args }
	};
}

const ctx = (active: string[] = []) => ({
	workspace,
	redactor: new Redactor(),
	activeRuns: () => active
});

function localRef(cache: string, ref: string): boolean {
	try {
		git(cache, 'rev-parse', '--verify', '--quiet', ref);
		return true;
	} catch {
		return false;
	}
}

describe('git.branch-delete', () => {
	it('löscht vorhandene Branches, meldet fehlende als missing', async () => {
		remote.commitFile('aidev/a', 'a.txt', 'a\n', 'A');
		remote.commitFile('aidev/b', 'b.txt', 'b\n', 'B');
		const res = await executeRpc(ctx(), cmd(['aidev/a', 'aidev/b', 'aidev/gibt-es-nicht', 'aidev/a']));
		expect(res).toEqual({ deleted: ['aidev/a', 'aidev/b'], missing: ['aidev/gibt-es-nicht'], failed: [], kept: [] });
		expect(remote.sha('aidev/a')).toBeNull();
		expect(remote.sha('aidev/b')).toBeNull();
		expect(remote.sha('main')).not.toBeNull();
		expect(remote.sha('old')).not.toBeNull();
	});

	it('räumt den Cache auf, Worktrees aktiver Läufe bleiben unangetastet', async () => {
		remote.commitFile('aidev/c', 'c.txt', 'c\n', 'C');
		remote.commitFile('aidev/d', 'd.txt', 'd\n', 'D');
		const cache = await workspace.ensureCache(project);
		const runC = randomUUID();
		const runD = randomUUID();
		await workspace.addWorktree(cache, workspace.runDir(runC), 'refs/remotes/origin/aidev/c', 'aidev/c');
		await workspace.addWorktree(cache, workspace.runDir(runD), 'refs/remotes/origin/aidev/d', 'aidev/d');

		const res = await executeRpc(ctx([runD]), cmd(['aidev/c', 'aidev/d']));
		expect(res).toEqual({ deleted: ['aidev/c', 'aidev/d'], missing: [], failed: [], kept: [] });
		expect(remote.sha('aidev/c')).toBeNull();
		// Remote-Tracking-Refs weg
		expect(localRef(cache, 'refs/remotes/origin/aidev/c')).toBe(false);
		expect(localRef(cache, 'refs/remotes/origin/aidev/d')).toBe(false);
		// Inaktiver Lauf: lokaler Branch gelöscht, Worktree detached (bleibt aber bestehen)
		expect(localRef(cache, 'refs/heads/aidev/c')).toBe(false);
		expect(existsSync(path.join(workspace.runDir(runC), 'c.txt'))).toBe(true);
		expect(git(workspace.runDir(runC), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
		// Aktiver Lauf: Branch und Worktree unverändert
		expect(localRef(cache, 'refs/heads/aidev/d')).toBe(true);
		expect(git(workspace.runDir(runD), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('aidev/d');
	});

	it('ohne Cache: Löschen über ein temporäres Repo', async () => {
		const other = { ...project, repoName: 'nocache' };
		const r = await createRemote(env, other.repoOwner, other.repoName);
		r.commitFile('aidev/x', 'x.txt', 'x\n', 'X');
		expect(existsSync(workspace.cacheDir(other))).toBe(false);
		const res = await executeRpc(ctx(), cmd(['aidev/x'], { repoName: 'nocache' }));
		expect(res).toEqual({ deleted: ['aidev/x'], missing: [], failed: [], kept: [] });
		expect(r.sha('aidev/x')).toBeNull();
		expect(existsSync(workspace.cacheDir(other))).toBe(false);
	});

	it('abgelehnter Sammel-Push → einzeln wiederholt, nur der geschützte Branch landet in failed', async () => {
		const hook = path.join(remote.bare, 'hooks', 'pre-receive');
		writeFileSync(
			hook,
			'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/aidev/geschuetzt" ] && [ "$new" = "0000000000000000000000000000000000000000" ]; then echo "geschützt ghp_abcdefghijklmnopqrstuvwxyz0123" >&2; exit 1; fi\ndone\nexit 0\n'
		);
		chmodSync(hook, 0o755);
		try {
			remote.commitFile('aidev/frei', 'f.txt', 'f\n', 'F');
			remote.commitFile('aidev/geschuetzt', 'g.txt', 'g\n', 'G');
			const res = (await executeRpc(ctx(), cmd(['aidev/frei', 'aidev/geschuetzt']))) as {
				deleted: string[];
				missing: string[];
				failed: { branch: string; error: string }[];
			};
			expect(res.deleted).toEqual(['aidev/frei']);
			expect(res.missing).toEqual([]);
			expect(res.failed).toHaveLength(1);
			expect(res.failed[0]?.branch).toBe('aidev/geschuetzt');
			expect(res.failed[0]?.error).toContain('[entfernt]');
			expect(res.failed[0]?.error).not.toContain('ghp_');
			expect(remote.sha('aidev/frei')).toBeNull();
			expect(remote.sha('aidev/geschuetzt')).not.toBeNull();
		} finally {
			rmSync(hook, { force: true });
		}
	});

	it('nur fehlende Branches → kein Push, alles missing', async () => {
		const res = await executeRpc(ctx(), cmd(['aidev/weg-1', 'aidev/weg-2']));
		expect(res).toEqual({ deleted: [], missing: ['aidev/weg-1', 'aidev/weg-2'], failed: [], kept: [] });
	});

	it('expect: nur der erwartete Stand wird gelöscht, ein geänderter Branch bleibt (changed)', async () => {
		const shaE = remote.commitFile('aidev/e-gleich', 'e.txt', 'e\n', 'E');
		const old = remote.commitFile('aidev/e-neu', 'e.txt', 'e\n', 'E');
		remote.commitFile('aidev/e-neu', 'e2.txt', 'nach dem Merge\n', 'E2');
		const res = await executeRpc(
			ctx(),
			cmd(['aidev/e-gleich', 'aidev/e-neu'], {}, { expect: { 'aidev/e-gleich': shaE, 'aidev/e-neu': old } })
		);
		expect(res).toEqual({
			deleted: ['aidev/e-gleich'],
			missing: [],
			failed: [],
			kept: [{ branch: 'aidev/e-neu', reason: 'changed' }]
		});
		expect(remote.sha('aidev/e-gleich')).toBeNull();
		expect(remote.sha('aidev/e-neu')).not.toBeNull();
	});

	it('lehnt ungültige expect-Angaben ab', async () => {
		await expect(executeRpc(ctx(), cmd(['aidev/a'], {}, { expect: ['x'] }))).rejects.toThrow(/Objekt/);
		await expect(executeRpc(ctx(), cmd(['aidev/a'], {}, { expect: { 'aidev/b': 'a'.repeat(40) } }))).rejects.toThrow(
			/unbekannten Branch/
		);
		await expect(executeRpc(ctx(), cmd(['aidev/a'], {}, { expect: { 'aidev/a': 'HEAD' } }))).rejects.toThrow(/SHA/);
	});

	it('offene PRs schützen Head- und Basis-Branches (auch jenseits der ersten 100), Fork-Heads nicht', async () => {
		const repo = `${project.repoOwner}/${project.repoName}`;
		for (const b of ['aidev/p-head', 'aidev/p-basis', 'aidev/p-fork', 'aidev/p-frei']) remote.commitFile(b, 'p.txt', 'p\n', 'P');
		// gh liefert die neuesten zuerst – der schützende PR liegt also außerhalb der ersten 100
		env.addGhPr({ repo, head: 'aidev/p-head' });
		for (let i = 0; i < 120; i++) env.addGhPr({ repo, head: `feature/f-${i}` });
		env.addGhPr({ repo, head: 'aidev/p-basis-kind', base: 'aidev/p-basis' });
		env.addGhPr({ repo, head: 'aidev/p-fork', isCrossRepository: true });
		env.addGhPr({ repo, head: 'aidev/p-frei', state: 'MERGED' });
		const res = await executeRpc(ctx(), cmd(['aidev/p-head', 'aidev/p-basis', 'aidev/p-fork', 'aidev/p-frei']));
		expect(res).toEqual({
			deleted: ['aidev/p-fork', 'aidev/p-frei'],
			missing: [],
			failed: [],
			kept: [
				{ branch: 'aidev/p-head', reason: 'open-pr' },
				{ branch: 'aidev/p-basis', reason: 'open-pr' }
			]
		});
		expect(remote.sha('aidev/p-head')).not.toBeNull();
		expect(remote.sha('aidev/p-basis')).not.toBeNull();
		expect(remote.sha('aidev/p-fork')).toBeNull();
		const list = env.ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'list').at(-1);
		expect(list).toEqual(expect.arrayContaining(['--state', 'open', '--limit', String(OPEN_PR_LIMIT)]));
	});

	it('offene PRs nicht abrufbar → Fehler, nichts gelöscht', async () => {
		remote.commitFile('aidev/q', 'q.txt', 'q\n', 'Q');
		env.setGhListFailure(true);
		try {
			await expect(executeRpc(ctx(), cmd(['aidev/q']))).rejects.toThrow(/Offene PRs nicht abrufbar/);
			expect(remote.sha('aidev/q')).not.toBeNull();
		} finally {
			env.setGhListFailure(false);
		}
	});

	it('lehnt Branches ohne aidev/-Präfix ab und löscht nichts', async () => {
		remote.commitFile('aidev/bleibt', 'e.txt', 'e\n', 'E');
		await expect(executeRpc(ctx(), cmd(['aidev/bleibt', 'old']))).rejects.toThrow(/aidev\//);
		expect(remote.sha('old')).not.toBeNull();
		expect(remote.sha('aidev/bleibt')).not.toBeNull();
	});

	it('lehnt den Haupt-Branch ab', async () => {
		const res = executeRpc(ctx(), cmd(['aidev/main'], { defaultBranch: 'aidev/main' }));
		await expect(res).rejects.toBeInstanceOf(RpcError);
		await expect(res).rejects.toThrow(/Haupt-Branch/);
	});

	it.each([
		['-aidev/x'],
		['aidev/../main'],
		['aidev/'],
		['aidev/a b'],
		['aidev/x.lock'],
		['aidev//x'],
		['aidev/x@{1}'],
		['']
	])('lehnt ungültigen Namen %j ab', async (name) => {
		await expect(executeRpc(ctx(), cmd([name]))).rejects.toBeInstanceOf(RpcError);
	});

	it('lehnt leere Listen, Nicht-Listen und Nicht-Zeichenketten ab', async () => {
		await expect(executeRpc(ctx(), cmd([]))).rejects.toThrow(/leer/);
		await expect(executeRpc(ctx(), cmd('aidev/a'))).rejects.toThrow(/Liste/);
		await expect(executeRpc(ctx(), cmd(undefined))).rejects.toThrow(/Liste/);
		await expect(executeRpc(ctx(), cmd(['aidev/a', 1]))).rejects.toThrow(/Zeichenketten/);
	});

	it('Obergrenze: MAX_BRANCH_DELETE ok (nach Entfernen von Duplikaten), eins mehr abgelehnt', async () => {
		const max = Array.from({ length: MAX_BRANCH_DELETE }, (_, i) => `aidev/n-${i}`);
		expect(parseBranchList([...max, ...max], 'main')).toEqual(max);
		await expect(executeRpc(ctx(), cmd([...max, 'aidev/zu-viel']))).rejects.toThrow(
			new RegExp(`Höchstens ${MAX_BRANCH_DELETE}`)
		);
	});
});
