/** Commits und Auslieferung (Push, PR, direkt, Integrations-Branch) eines Laufs. */
import path from 'node:path';
import type { CommitInfo } from '../protocol.ts';
import { exec } from '../util/proc.ts';
import { assertRefName, GitError } from './git.ts';
import type { RepoRef, Workspace } from './workspace.ts';

/** Fehler mit Fehlerart für `finish` */
export class DeliveryError extends Error {
	constructor(
		readonly kind: 'git' | 'conflict',
		message: string,
		readonly conflictFiles: string[] = []
	) {
		super(message);
		this.name = 'DeliveryError';
	}
}

export type Emit = (kind: 'git' | 'system' | 'stderr' | 'error' | 'status', payload: Record<string, unknown>) => void;

/** Uncommittete Änderungen vorhanden? */
export async function isDirty(ws: Workspace, dir: string): Promise<boolean> {
	const r = await ws.run(dir, ['status', '--porcelain', '--untracked-files=all']);
	return r.stdout.trim().length > 0;
}

/** Alle Änderungen committen (`git add -A`), falls vorhanden; liefert true bei neuem Commit */
export async function commitAll(ws: Workspace, dir: string, title: string, taskId: string): Promise<boolean> {
	if (!(await isDirty(ws, dir))) return false;
	await ws.run(dir, ['add', '-A']);
	const staged = await ws.run(dir, ['diff', '--cached', '--quiet'], { allowFail: true });
	if (staged.code === 0) return false;
	const subject = title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Änderungen des Agents';
	await ws.run(dir, ['commit', '--quiet', '--no-verify', '-F', '-'], {
		input: `${subject}\n\nAidev-Task: ${taskId}\n`,
		config: ws.noHooks
	});
	return true;
}

/** Änderungen verwerfen (Nur-Lese-Rollen) */
export async function discardChanges(ws: Workspace, dir: string): Promise<void> {
	await ws.run(dir, ['reset', '--hard', '--quiet']);
	await ws.run(dir, ['clean', '-fd', '--quiet']);
}

export async function headSha(ws: Workspace, dir: string): Promise<string> {
	const r = await ws.run(dir, ['rev-parse', 'HEAD']);
	return r.stdout.trim();
}

/** Anzahl Commits in `base..HEAD` */
export async function countCommits(ws: Workspace, dir: string, base: string): Promise<number> {
	const r = await ws.run(dir, ['rev-list', '--count', `${base}..HEAD`]);
	return Number(r.stdout.trim()) || 0;
}

/** Commits `base..HEAD` (älteste zuerst) mit numstat */
export async function commitInfos(ws: Workspace, dir: string, base: string, max = 200): Promise<CommitInfo[]> {
	const r = await ws.run(dir, [
		'log',
		'--reverse',
		`--max-count=${max}`,
		'--format=%x1e%H%x1f%B%x1f',
		'--numstat',
		'--no-renames',
		`${base}..HEAD`
	]);
	return parseCommitLog(r.stdout).slice(-max);
}

export function parseCommitLog(out: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	for (const rec of out.split('\x1e')) {
		if (!rec.trim()) continue;
		const [sha = '', message = '', rest = ''] = rec.split('\x1f');
		if (!/^[0-9a-f]{7,40}$/.test(sha.trim())) continue;
		let additions = 0;
		let deletions = 0;
		const files: string[] = [];
		for (const line of rest.split('\n')) {
			const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
			if (!m) continue;
			if (m[1] !== '-') additions += Number(m[1]);
			if (m[2] !== '-') deletions += Number(m[2]);
			if (files.length < 500) files.push((m[3] ?? '').slice(0, 500));
		}
		commits.push({ sha: sha.trim(), message: message.trim().slice(0, 4000), additions, deletions, files });
	}
	return commits;
}

/** Dateien mit Konflikten */
export async function conflictFiles(ws: Workspace, dir: string): Promise<string[]> {
	const r = await ws.run(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
	return r.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 200);
}

function isRejected(stderr: string): boolean {
	return /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|stale info|failed to push some refs/i.test(stderr);
}

/**
 * Branch pushen (`HEAD:refs/heads/<branch>`). Wird der Push abgelehnt und ist es ein eigener `aidev/`-Branch,
 * wird mit `--force-with-lease` (erwarteter Stand: `expectedRemote`) erneut gepusht.
 */
export async function pushBranch(
	ws: Workspace,
	repo: RepoRef,
	dir: string,
	branch: string,
	expectedRemote: string | null,
	emit: Emit
): Promise<void> {
	assertRefName(branch);
	await ws.withRepo(repo, async () => {
		const r = await ws.run(dir, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${branch}`], {
			allowFail: true,
			config: [...ws.netConfig(repo), ...ws.noHooks],
			timeoutMs: 600_000
		});
		if (r.code === 0) {
			emit('git', { action: 'push', detail: `Branch ${branch} gepusht` });
			return;
		}
		const err = r.stderr + r.stdout;
		if (isRejected(err) && branch.startsWith('aidev/')) {
			emit('git', { action: 'push', detail: `Push abgelehnt – erneut mit --force-with-lease auf ${branch}` });
			const f = await ws.run(
				dir,
				['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expectedRemote ?? ''}`, 'origin', `HEAD:refs/heads/${branch}`],
				{ allowFail: true, config: [...ws.netConfig(repo), ...ws.noHooks], timeoutMs: 600_000 }
			);
			if (f.code === 0) {
				emit('git', { action: 'push', detail: `Branch ${branch} gepusht (force-with-lease)` });
				return;
			}
			throw new DeliveryError('git', `Push von ${branch} fehlgeschlagen:\n${(f.stderr || f.stdout).trim().slice(-2000)}`);
		}
		throw new DeliveryError('git', `Push von ${branch} fehlgeschlagen:\n${err.trim().slice(-2000)}`);
	});
}

/** Remote-Refs im Cache aktualisieren */
export async function fetchRepo(ws: Workspace, repo: RepoRef): Promise<void> {
	await ws.ensureCache(repo);
}

export interface GhResult {
	code: number | null;
	stdout: string;
	stderr: string;
	spawnError: string | null;
}

export async function gh(ws: Workspace, args: string[], o: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<GhResult> {
	const r = await exec('gh', args, {
		cwd: o.cwd,
		input: o.input,
		env: { ...ws.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
		timeoutMs: o.timeoutMs ?? 60_000
	});
	return { code: r.code, stdout: r.stdout, stderr: r.stderr, spawnError: r.spawnError };
}

function prFromUrl(url: string): { number: number; url: string } | null {
	const m = /https?:\/\/\S+\/pull\/(\d+)/.exec(url);
	return m?.[1] ? { number: Number(m[1]), url: m[0] } : null;
}

/** PR öffnen bzw. vorhandenen PR des Branchs liefern */
export async function ensurePullRequest(
	ws: Workspace,
	repo: RepoRef,
	o: { branch: string; base: string; title: string; body: string },
	emit: Emit
): Promise<{ number: number; url: string }> {
	const slug = `${repo.repoOwner}/${repo.repoName}`;
	const create = await gh(ws, [
		'pr',
		'create',
		'--repo',
		slug,
		'--head',
		o.branch,
		'--base',
		o.base,
		'--title',
		o.title.replace(/\s+/g, ' ').trim().slice(0, 200) || o.branch,
		'--body-file',
		'-'
	], { input: o.body });
	if (create.code === 0) {
		const pr = prFromUrl(create.stdout) ?? prFromUrl(create.stderr);
		if (pr) {
			emit('git', { action: 'pr', detail: `PR #${pr.number} geöffnet`, url: pr.url });
			return pr;
		}
	}
	const view = await gh(ws, ['pr', 'view', o.branch, '--repo', slug, '--json', 'number,url']);
	if (view.code === 0) {
		try {
			const j = JSON.parse(view.stdout) as { number?: unknown; url?: unknown };
			if (typeof j.number === 'number' && typeof j.url === 'string') {
				emit('git', { action: 'pr', detail: `Vorhandener PR #${j.number}`, url: j.url });
				return { number: j.number, url: j.url };
			}
		} catch {
			// unten Fehler
		}
	}
	const why = create.spawnError ?? (create.stderr.trim() || view.stderr.trim() || 'unbekannter Fehler');
	throw new DeliveryError('git', `PR konnte nicht erstellt werden: ${why.slice(-2000)}`);
}

/** Auto-Merge aktivieren (Fehler nur als Ereignis) */
export async function enableAutoMerge(ws: Workspace, repo: RepoRef, number: number, emit: Emit): Promise<void> {
	const r = await gh(ws, ['pr', 'merge', String(number), '--repo', `${repo.repoOwner}/${repo.repoName}`, '--auto', '--squash']);
	if (r.code === 0) emit('git', { action: 'auto-merge', detail: `Auto-Merge für PR #${number} aktiviert` });
	else
		emit('error', {
			text: `Auto-Merge für PR #${number} nicht möglich: ${(r.spawnError ?? (r.stderr.trim() || r.stdout.trim())).slice(-1000)}`
		});
}

/**
 * Direkt auf den Haupt-Branch: rebase auf `origin/<default>` und Push, bis zu 3 Versuche bei abgelehntem Push.
 * Liefert den Stand von `origin/<default>` vor dem erfolgreichen Push (Basis der ausgelieferten Commits).
 */
export async function deliverDirect(
	ws: Workspace,
	repo: RepoRef,
	dir: string,
	defaultBranch: string,
	emit: Emit
): Promise<string> {
	assertRefName(defaultBranch);
	let lastErr = '';
	for (let attempt = 1; attempt <= 3; attempt++) {
		await fetchRepo(ws, repo);
		const onto = await ws.revParse(dir, `refs/remotes/origin/${defaultBranch}`);
		if (!onto) throw new DeliveryError('git', `Branch „${defaultBranch}“ existiert im Repository nicht`);
		const rb = await ws.run(dir, ['rebase', '--quiet', onto], { allowFail: true, config: ws.noHooks });
		if (rb.code !== 0) {
			const files = await conflictFiles(ws, dir);
			await ws.run(dir, ['rebase', '--abort'], { allowFail: true });
			if (files.length)
				throw new DeliveryError('conflict', `Konflikt beim Rebase auf ${defaultBranch}`, files);
			throw new DeliveryError('git', `Rebase auf ${defaultBranch} fehlgeschlagen:\n${(rb.stderr || rb.stdout).trim().slice(-2000)}`);
		}
		emit('git', { action: 'rebase', detail: `Auf origin/${defaultBranch} rebased (Versuch ${attempt})` });
		const pushed = await ws.withRepo(repo, () =>
			ws.run(dir, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${defaultBranch}`], {
				allowFail: true,
				config: [...ws.netConfig(repo), ...ws.noHooks],
				timeoutMs: 600_000
			})
		);
		if (pushed.code === 0) {
			emit('git', { action: 'push', detail: `Direkt auf ${defaultBranch} gepusht` });
			return onto;
		}
		lastErr = (pushed.stderr || pushed.stdout).trim();
		if (!isRejected(lastErr)) break;
		emit('git', { action: 'push', detail: `Push auf ${defaultBranch} abgelehnt (Versuch ${attempt})` });
	}
	throw new DeliveryError('git', `Push auf ${defaultBranch} fehlgeschlagen:\n${lastErr.slice(-2000)}`);
}

/**
 * Teilauftrag in den Integrations-Branch mergen (`git merge --no-ff`) und pushen; bei Wettlauf bis zu 3 Versuche.
 * Der Merge läuft in einem eigenen temporären Worktree.
 */
export async function deliverIntegrate(
	ws: Workspace,
	repo: RepoRef,
	o: { dir: string; branch: string; integrationBranch: string; defaultBranch: string; runId: string; taskId: string },
	emit: Emit
): Promise<void> {
	assertRefName(o.integrationBranch);
	const head = await headSha(ws, o.dir);
	const tmp = path.join(ws.tmpRoot, `${o.runId}-integrate`);
	let lastErr = '';
	try {
		for (let attempt = 1; attempt <= 3; attempt++) {
			const cache = await ws.ensureCache(repo);
			let target = await ws.revParse(cache, `refs/remotes/origin/${o.integrationBranch}`);
			if (!target) {
				emit('git', { action: 'branch', detail: `Integrations-Branch ${o.integrationBranch} wird aus ${o.defaultBranch} angelegt` });
				target = await ws.withRepo(repo, () => ws.createRemoteBranch(repo, cache, o.integrationBranch, o.defaultBranch));
			}
			await ws.withRepo(repo, () => ws.addWorktree(cache, tmp, target, null));
			const merge = await ws.run(
				tmp,
				['merge', '--no-ff', '--quiet', '-m', `Merge ${o.branch} in ${o.integrationBranch}\n\nAidev-Task: ${o.taskId}`, head],
				{ allowFail: true, config: ws.noHooks }
			);
			if (merge.code !== 0) {
				const files = await conflictFiles(ws, tmp);
				await ws.run(tmp, ['merge', '--abort'], { allowFail: true });
				if (files.length)
					throw new DeliveryError('conflict', `Konflikt beim Mergen in ${o.integrationBranch}`, files);
				throw new DeliveryError('git', `Merge in ${o.integrationBranch} fehlgeschlagen:\n${(merge.stderr || merge.stdout).trim().slice(-2000)}`);
			}
			const pushed = await ws.withRepo(repo, () =>
				ws.run(tmp, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${o.integrationBranch}`], {
					allowFail: true,
					config: [...ws.netConfig(repo), ...ws.noHooks],
					timeoutMs: 600_000
				})
			);
			if (pushed.code === 0) {
				emit('git', { action: 'merge', detail: `${o.branch} in ${o.integrationBranch} gemergt und gepusht` });
				return;
			}
			lastErr = (pushed.stderr || pushed.stdout).trim();
			if (!isRejected(lastErr)) break;
			emit('git', { action: 'push', detail: `Push auf ${o.integrationBranch} abgelehnt (Versuch ${attempt})` });
		}
		throw new DeliveryError('git', `Push auf ${o.integrationBranch} fehlgeschlagen:\n${lastErr.slice(-2000)}`);
	} finally {
		await ws.removeWorktree(tmp).catch(() => undefined);
	}
}

export { GitError };
