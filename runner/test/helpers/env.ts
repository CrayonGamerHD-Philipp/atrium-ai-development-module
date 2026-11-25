/**
 * Testumgebung: temporäres Verzeichnis, leere globale git-Konfiguration, gh-Shim im PATH, lokales Bare-Remote
 * (`git init --bare`) als „GitHub“.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shimScript = path.join(here, '..', 'fixtures', 'gh-shim', 'gh-shim.mjs');

export interface TestEnv {
	tmp: string;
	workDir: string;
	remotes: string;
	ghState: string;
	remoteTemplate: string;
	cleanup(): Promise<void>;
	ghCalls(): string[][];
	ghPrs(): GhPr[];
	/** PR im gh-Shim anlegen (z. B. geschlossen, aus einem Fork, mit Kommentaren) */
	addGhPr(pr: Partial<GhPr> & { repo: string; head: string }): GhPr;
}

export interface GhPr {
	number: number;
	repo: string;
	head: string;
	base: string;
	title: string;
	body: string;
	url: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	autoMerge: boolean;
	isCrossRepository?: boolean;
	comments?: { author: { login: string }; body: string }[];
	reviews?: { author: { login: string }; body: string; state: string }[];
	inlineComments?: { path: string; line: number | null; body: string; user: { login: string } }[];
	/** `gh pr view` schlägt fehl */
	failView?: boolean;
	/** `gh api …/comments` (Inline-Kommentare) schlägt fehl */
	failApi?: boolean;
	/** `gh pr comment` schlägt fehl */
	failComment?: boolean;
}

export async function setupTestEnv(): Promise<TestEnv> {
	const tmp = await mkdtemp(path.join(os.tmpdir(), 'aidev-runner-'));
	const bin = path.join(tmp, 'bin');
	await mkdir(bin, { recursive: true });
	const gitconfig = path.join(tmp, 'gitconfig');
	await writeFile(gitconfig, '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
	const node = process.execPath;
	await writeFile(path.join(bin, 'gh'), `#!/bin/sh\nexec "${node.replace(/\\/g, '/')}" "${shimScript.replace(/\\/g, '/')}" "$@"\n`);
	await chmod(path.join(bin, 'gh'), 0o755);
	await writeFile(path.join(bin, 'gh.cmd'), `@"${node}" "${shimScript}" %*\r\n`);
	const ghState = path.join(tmp, 'gh-state.json');
	process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
	process.env.GH_SHIM_STATE = ghState;
	process.env.GIT_CONFIG_GLOBAL = gitconfig;
	process.env.GIT_CONFIG_NOSYSTEM = '1';
	process.env.GIT_AUTHOR_NAME = 'Test';
	process.env.GIT_AUTHOR_EMAIL = 'test@example.org';
	process.env.GIT_COMMITTER_NAME = 'Test';
	process.env.GIT_COMMITTER_EMAIL = 'test@example.org';
	const remotes = path.join(tmp, 'remotes');
	await mkdir(remotes, { recursive: true });
	const readState = () =>
		existsSync(ghState) ? JSON.parse(readFileSync(ghState, 'utf8')) : { prs: [], merges: [], calls: [] };
	return {
		tmp,
		workDir: path.join(tmp, 'work'),
		remotes,
		ghState,
		remoteTemplate: `${remotes.replace(/\\/g, '/')}/{owner}/{repo}.git`,
		async cleanup() {
			await rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
		},
		ghCalls: () => readState().calls,
		ghPrs: () => readState().prs,
		addGhPr(pr) {
			const state = readState();
			const number = state.prs.length + 1;
			const full: GhPr = {
				number,
				base: 'main',
				title: `PR ${number}`,
				body: '',
				url: `https://github.com/${pr.repo}/pull/${number}`,
				state: 'OPEN',
				autoMerge: false,
				...pr
			};
			state.prs.push(full);
			writeFileSync(ghState, JSON.stringify(state, null, 2));
			return full;
		}
	};
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Bare-Remote mit einem ersten Commit auf `main` (README.md) und Branch `old` auf demselben Stand */
export async function createRemote(env: TestEnv, owner: string, repo: string): Promise<Remote> {
	const bare = path.join(env.remotes, owner, `${repo}.git`);
	await mkdir(bare, { recursive: true });
	git(bare, 'init', '--bare', '--quiet', '-b', 'main');
	const r = new Remote(env, bare);
	r.commitFile('main', 'README.md', '# Testprojekt\n', 'Erster Commit');
	git(r.scratch, 'push', '--quiet', 'origin', 'main:old');
	return r;
}

export class Remote {
	readonly scratch: string;
	constructor(
		readonly env: TestEnv,
		readonly bare: string
	) {
		this.scratch = path.join(env.tmp, `scratch-${path.basename(bare)}-${Math.random().toString(36).slice(2, 8)}`);
		git(env.tmp, 'clone', '--quiet', bare, this.scratch);
	}

	/** Datei auf einem Branch des Remotes setzen (Commit + Push) */
	commitFile(branch: string, file: string, content: string, message: string): string {
		const s = this.scratch;
		git(s, 'fetch', '--quiet', 'origin');
		const exists = (() => {
			try {
				git(s, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
				return true;
			} catch {
				return false;
			}
		})();
		if (exists) git(s, 'checkout', '--quiet', '-B', branch, `origin/${branch}`);
		else {
			try {
				git(s, 'checkout', '--quiet', '-B', branch, 'origin/main');
			} catch {
				git(s, 'checkout', '--quiet', '--orphan', branch);
			}
		}
		const full = path.join(s, file);
		execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1], process.argv[2])`, full, content]);
		git(s, 'add', '-A');
		git(s, 'commit', '--quiet', '-m', message);
		git(s, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
		return git(s, 'rev-parse', 'HEAD');
	}

	/** Inhalt einer Datei auf einem Remote-Branch (oder null) */
	read(branch: string, file: string): string | null {
		try {
			return execFileSync('git', ['show', `${branch}:${file}`], { cwd: this.bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		} catch {
			return null;
		}
	}

	sha(branch: string): string | null {
		try {
			return git(this.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
		} catch {
			return null;
		}
	}

	log(branch: string): string[] {
		return git(this.bare, 'log', '--format=%s', branch).split('\n');
	}
}
