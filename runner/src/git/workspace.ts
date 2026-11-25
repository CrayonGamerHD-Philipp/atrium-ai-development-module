/**
 * Repository-Verwaltung des Runners:
 * - Bare-Cache je Repo `WORK_DIR/cache/<owner>/<repo>.git` (Remote `origin`, Refs unter `refs/remotes/origin/*`,
 *   `fetch --prune` vor jedem Lauf; Zugriffe je Repo per Mutex serialisiert)
 * - Worktree je Lauf `WORK_DIR/wt/<runId>` (bleibt nach dem Lauf erhalten, Aufräumen nach 48 h bzw. > 30 Stück)
 * - Arbeitskopie des Haupt-Branchs je Projekt `WORK_DIR/projects/<projectId>/main` (Editor/Terminal)
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { silentLogger } from '../log.ts';
import { KeyedMutex } from '../util/async.ts';
import { assertRefName, createGitRunner, GitError, gitEnv, type GitOptions, type GitRunner } from './git.ts';

export interface RepoRef {
	repoOwner: string;
	repoName: string;
}

export interface WorkspaceOptions {
	workDir: string;
	remoteTemplate: string;
	author: { name: string; email: string };
	/** Basisumgebung für git (ohne private Variablen des Runners) */
	env: NodeJS.ProcessEnv;
	/** `gh` als Credential-Helper für https://github.com verwenden */
	useGhCredentials: boolean;
	log?: Logger;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const WORKTREE_MAX_AGE_MS = 48 * 3_600_000;
export const WORKTREE_MAX_COUNT = 30;

export function assertRepo(r: RepoRef): void {
	if (!SAFE_NAME.test(r.repoOwner) || !SAFE_NAME.test(r.repoName) || r.repoOwner.startsWith('.') || r.repoName.startsWith('.'))
		throw new GitError(`Repository „${r.repoOwner}/${r.repoName}“ ist ungültig`);
}

function assertId(id: string): void {
	if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GitError(`Ungültige ID „${id}“`);
}

export class Workspace {
	readonly git: GitRunner;
	readonly env: NodeJS.ProcessEnv;
	private readonly mutex = new KeyedMutex();
	private readonly log: Logger;
	readonly emptyHooksDir: string;

	constructor(readonly o: WorkspaceOptions) {
		this.env = gitEnv(o.env, o.author);
		this.git = createGitRunner(this.env);
		this.log = o.log ?? silentLogger;
		this.emptyHooksDir = path.join(o.workDir, 'empty-hooks');
	}

	get wtRoot(): string {
		return path.join(this.o.workDir, 'wt');
	}
	get tmpRoot(): string {
		return path.join(this.o.workDir, 'tmp');
	}

	remoteUrl(r: RepoRef): string {
		assertRepo(r);
		return this.o.remoteTemplate.replaceAll('{owner}', r.repoOwner).replaceAll('{repo}', r.repoName);
	}

	cacheDir(r: RepoRef): string {
		assertRepo(r);
		return path.join(this.o.workDir, 'cache', r.repoOwner, `${r.repoName}.git`);
	}

	runDir(runId: string): string {
		assertId(runId);
		return path.join(this.wtRoot, runId);
	}

	mainDir(projectId: string): string {
		assertId(projectId);
		return path.join(this.o.workDir, 'projects', projectId, 'main');
	}

	/** `-c`-Einstellungen für Netzwerkzugriffe (Anmeldung über gh) */
	netConfig(r: RepoRef): string[] {
		const url = this.remoteUrl(r);
		if (!this.o.useGhCredentials || !url.startsWith('https://github.com/')) return [];
		return ['credential.https://github.com.helper=', 'credential.https://github.com.helper=!gh auth git-credential'];
	}

	/** `-c`-Einstellungen für Commits/Merges des Runners (keine Repo-Hooks) */
	get noHooks(): string[] {
		return [`core.hooksPath=${this.emptyHooksDir.replace(/\\/g, '/')}`];
	}

	/** Serialisiert Zugriffe auf ein Repository */
	withRepo<T>(r: RepoRef, fn: () => Promise<T>): Promise<T> {
		return this.mutex.run(`${r.repoOwner}/${r.repoName}`.toLowerCase(), fn);
	}

	private async ensureCacheUnlocked(r: RepoRef, signal?: AbortSignal): Promise<string> {
		const dir = this.cacheDir(r);
		const url = this.remoteUrl(r);
		await mkdir(this.emptyHooksDir, { recursive: true });
		if (!existsSync(path.join(dir, 'HEAD'))) {
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			await this.git(['init', '--bare', '--quiet', dir]);
			await this.git(['remote', 'add', 'origin', url], { cwd: dir });
			await this.git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: dir });
			await this.git(['config', 'core.hooksPath', this.emptyHooksDir.replace(/\\/g, '/')], { cwd: dir });
			await this.git(['config', 'gc.auto', '0'], { cwd: dir });
		} else {
			const cur = await this.git(['remote', 'get-url', 'origin'], { cwd: dir, allowFail: true });
			if (cur.stdout.trim() !== url) await this.git(['remote', 'set-url', 'origin', url], { cwd: dir });
		}
		await this.git(['fetch', '--prune', '--quiet', 'origin'], {
			cwd: dir,
			config: this.netConfig(r),
			signal,
			timeoutMs: 600_000
		});
		return dir;
	}

	/** Cache anlegen bzw. aktualisieren (`fetch --prune`) */
	ensureCache(r: RepoRef, signal?: AbortSignal): Promise<string> {
		return this.withRepo(r, () => this.ensureCacheUnlocked(r, signal));
	}

	/** SHA eines Refs oder `null` */
	async revParse(cwd: string, ref: string): Promise<string | null> {
		const res = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true });
		const sha = res.stdout.trim();
		return res.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
	}

	/** Branch auf dem Remote aus `origin/<from>` anlegen (z. B. Integrations-Branch), falls er fehlt */
	async createRemoteBranch(r: RepoRef, cache: string, branch: string, from: string): Promise<string> {
		assertRefName(branch);
		assertRefName(from);
		const fromSha = await this.revParse(cache, `refs/remotes/origin/${from}`);
		if (!fromSha) throw new GitError(`Branch „${from}“ existiert im Repository nicht`);
		const push = await this.git(['push', '--quiet', 'origin', `${fromSha}:refs/heads/${branch}`], {
			cwd: cache,
			config: this.netConfig(r),
			allowFail: true
		});
		await this.git(['fetch', '--prune', '--quiet', 'origin'], { cwd: cache, config: this.netConfig(r) });
		const sha = await this.revParse(cache, `refs/remotes/origin/${branch}`);
		if (!sha) throw new GitError(`Branch „${branch}“ konnte nicht angelegt werden: ${push.stderr.trim()}`);
		return sha;
	}

	/** Worktrees, die einen lokalen Branch ausgecheckt haben */
	private async worktreesOf(cache: string, branch: string): Promise<string[]> {
		const res = await this.git(['worktree', 'list', '--porcelain'], { cwd: cache, allowFail: true });
		const out: string[] = [];
		let current: string | null = null;
		for (const line of res.stdout.split('\n')) {
			if (line.startsWith('worktree ')) current = line.slice(9).trim();
			else if (line.trim() === `branch refs/heads/${branch}` && current) out.push(current);
		}
		return out;
	}

	/** Lauf-ID eines Worktrees unter `WORK_DIR/wt` oder `null` (z. B. Arbeitskopie des Haupt-Branchs) */
	private runIdOf(dir: string): string | null {
		const rel = path.relative(path.resolve(this.wtRoot), path.resolve(dir));
		if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
		return rel.split(/[\\/]/)[0]?.slice(0, 36) ?? null;
	}

	/**
	 * Gelöschte Remote-Branches im Cache nachziehen: lokale Branches und `refs/remotes/origin/<b>` entfernen (unter dem
	 * Repo-Mutex). Worktrees aktiver Läufe (`active`) werden nie angefasst – deren Branch bleibt lokal erhalten; andere
	 * Worktrees mit dem Branch werden auf „detached“ gestellt. Danach `git worktree prune`. Fehlt der Cache, passiert
	 * nichts. Liefert die Branches, die wegen eines aktiven Laufs lokal erhalten blieben.
	 */
	async deleteCachedBranches(r: RepoRef, branches: string[], active: Set<string> = new Set()): Promise<string[]> {
		for (const b of branches) assertRefName(b);
		const cache = this.cacheDir(r);
		return this.withRepo(r, async () => {
			if (!existsSync(path.join(cache, 'HEAD'))) return [];
			await this.git(['worktree', 'prune'], { cwd: cache, allowFail: true });
			const kept: string[] = [];
			for (const branch of branches) {
				await this.git(['update-ref', '-d', `refs/remotes/origin/${branch}`], { cwd: cache, allowFail: true });
				if (!(await this.revParse(cache, `refs/heads/${branch}`))) continue;
				const holders = await this.worktreesOf(cache, branch);
				if (holders.some((h) => active.has(this.runIdOf(h) ?? ''))) {
					kept.push(branch);
					continue;
				}
				for (const other of holders) {
					this.log.info(`Worktree ${other} hält gelöschten Branch ${branch} – wird auf detached umgestellt`);
					await this.git(['checkout', '--quiet', '--detach'], { cwd: other, allowFail: true });
				}
				const del = await this.git(['branch', '-D', '--quiet', branch], { cwd: cache, allowFail: true });
				if (del.code !== 0) this.log.warn(`Lokaler Branch ${branch} konnte nicht gelöscht werden`, del.stderr.trim());
			}
			await this.git(['worktree', 'prune'], { cwd: cache, allowFail: true });
			return kept;
		});
	}

	/** Worktree hinzufügen; ein anderer Worktree mit demselben Branch wird dafür auf „detached“ gestellt */
	async addWorktree(
		cache: string,
		dir: string,
		start: string,
		branch: string | null
	): Promise<void> {
		await mkdir(path.dirname(dir), { recursive: true });
		await this.git(['worktree', 'prune'], { cwd: cache, allowFail: true });
		if (existsSync(dir)) await this.removeWorktree(dir, cache);
		if (branch) {
			assertRefName(branch);
			for (const other of await this.worktreesOf(cache, branch)) {
				if (path.resolve(other) === path.resolve(dir)) continue;
				this.log.info(`Worktree ${other} hält Branch ${branch} – wird auf detached umgestellt`);
				await this.git(['checkout', '--quiet', '--detach'], { cwd: other, allowFail: true });
			}
			await this.git(['worktree', 'add', '--quiet', '--force', '-B', branch, dir, start], { cwd: cache });
		} else {
			await this.git(['worktree', 'add', '--quiet', '--force', '--detach', dir, start], { cwd: cache });
		}
	}

	/** Worktree samt Verzeichnis entfernen */
	async removeWorktree(dir: string, cache?: string): Promise<void> {
		const c = cache ?? (await this.cacheOfWorktree(dir));
		if (c) await this.git(['worktree', 'remove', '--force', '--force', dir], { cwd: c, allowFail: true });
		await rm(dir, { recursive: true, force: true, maxRetries: 3 });
		if (c) await this.git(['worktree', 'prune'], { cwd: c, allowFail: true });
	}

	/** Cache-Verzeichnis eines Worktrees aus seiner `.git`-Datei */
	async cacheOfWorktree(dir: string): Promise<string | null> {
		try {
			const txt = await readFile(path.join(dir, '.git'), 'utf8');
			const m = /^gitdir:\s*(.+)$/m.exec(txt);
			if (!m?.[1]) return null;
			const gitdir = path.resolve(dir, m[1].trim());
			const idx = gitdir.replace(/\\/g, '/').lastIndexOf('/worktrees/');
			return idx > 0 ? gitdir.slice(0, idx) : null;
		} catch {
			return null;
		}
	}

	/** Worktree eines Laufs (für RPC/Terminal); fehlt er, Fehler */
	async runWorktree(runId: string): Promise<string> {
		const dir = this.runDir(runId);
		if (!existsSync(path.join(dir, '.git'))) throw new GitError('Worktree nicht mehr vorhanden');
		return dir;
	}

	/** Arbeitskopie des Haupt-Branchs (bei Bedarf aus dem Cache auschecken) */
	async mainCopy(project: RepoRef & { id: string; defaultBranch: string }): Promise<string> {
		const dir = this.mainDir(project.id);
		if (existsSync(path.join(dir, '.git'))) return dir;
		assertRefName(project.defaultBranch);
		return this.withRepo(project, async () => {
			if (existsSync(path.join(dir, '.git'))) return dir;
			const cache = await this.ensureCacheUnlocked(project);
			const remote = await this.revParse(cache, `refs/remotes/origin/${project.defaultBranch}`);
			if (!remote) throw new GitError(`Branch „${project.defaultBranch}“ existiert im Repository nicht`);
			await mkdir(path.dirname(dir), { recursive: true });
			await this.git(['worktree', 'prune'], { cwd: cache, allowFail: true });
			if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
			const local = await this.revParse(cache, `refs/heads/${project.defaultBranch}`);
			const holders = await this.worktreesOf(cache, project.defaultBranch);
			if (holders.length) {
				for (const other of holders)
					await this.git(['checkout', '--quiet', '--detach'], { cwd: other, allowFail: true });
			}
			if (local) await this.git(['worktree', 'add', '--quiet', dir, project.defaultBranch], { cwd: cache });
			else
				await this.git(
					['worktree', 'add', '--quiet', '-b', project.defaultBranch, dir, `refs/remotes/origin/${project.defaultBranch}`],
					{ cwd: cache }
				);
			await this.git(['branch', `--set-upstream-to=origin/${project.defaultBranch}`, project.defaultBranch], {
				cwd: dir,
				allowFail: true
			});
			return dir;
		});
	}

	/**
	 * Alte Worktrees aufräumen: älter als 48 h oder mehr als 30 Stück (älteste zuerst); aktive Läufe bleiben.
	 * Danach `git worktree prune` in allen Caches.
	 */
	async cleanup(active: Set<string>, now = Date.now()): Promise<number> {
		let removed = 0;
		let entries: string[] = [];
		try {
			entries = await readdir(this.wtRoot);
		} catch {
			entries = [];
		}
		const items: { dir: string; mtime: number; id: string }[] = [];
		for (const name of entries) {
			const dir = path.join(this.wtRoot, name);
			try {
				const s = await stat(dir);
				if (!s.isDirectory()) continue;
				items.push({ dir, mtime: s.mtimeMs, id: name.slice(0, 36) });
			} catch {
				// verschwunden
			}
		}
		items.sort((a, b) => b.mtime - a.mtime);
		let kept = 0;
		for (const it of items) {
			if (active.has(it.id)) {
				kept++;
				continue;
			}
			const tooOld = now - it.mtime > WORKTREE_MAX_AGE_MS;
			const tooMany = kept >= WORKTREE_MAX_COUNT;
			if (tooOld || tooMany) {
				try {
					await this.removeWorktree(it.dir);
					removed++;
				} catch (e) {
					this.log.warn(`Worktree ${it.dir} konnte nicht entfernt werden`, e);
				}
			} else kept++;
		}
		// worktree prune in allen Caches
		const cacheRoot = path.join(this.o.workDir, 'cache');
		try {
			for (const owner of await readdir(cacheRoot)) {
				for (const repo of await readdir(path.join(cacheRoot, owner))) {
					const c = path.join(cacheRoot, owner, repo);
					if (existsSync(path.join(c, 'HEAD')))
						await this.git(['worktree', 'prune'], { cwd: c, allowFail: true });
				}
			}
		} catch {
			// noch kein Cache
		}
		return removed;
	}

	/** git im Worktree ausführen */
	run(cwd: string, args: string[], o: Omit<GitOptions, 'cwd'> = {}) {
		return this.git(args, { ...o, cwd });
	}
}
