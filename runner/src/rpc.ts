/**
 * RPC-Anfragen von Atrium (Editor, Diff, PR-Übersicht, Repo-Prüfung, Branch-Aufräumen). Jede Anfrage läuft parallel mit einem
 * Zeitlimit von 18 s; das Ergebnis wird gegen das Result-Schema aus `protocol.ts` geprüft und per
 * `POST /runner/rpc/:reqId` zurückgemeldet.
 */
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { RunnerApi } from './client.ts';
import { gh } from './git/delivery.ts';
import { assertRefName, GitError } from './git/git.ts';
import type { Workspace } from './git/workspace.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import { PathError, resolveInJail } from './paths.ts';
import {
	branchDeleteResult,
	fsListResult,
	fsReadResult,
	gitDiffResult,
	gitLogResult,
	gitStatusResult,
	MAX_BRANCH_DELETE,
	MAX_DIFF_BYTES,
	MAX_FILE_BYTES,
	MAX_REPO_BRANCHES,
	prListResult,
	repoCheckResult,
	type FsEntry,
	type PrInfo,
	type RpcCommand
} from './protocol.ts';
import type { Redactor } from './redact.ts';
import { errorMessage } from './util/async.ts';
import { exec, type ExecResult } from './util/proc.ts';

export const RPC_TIMEOUT_MS = 18_000;
const MAX_LIST = 2000;

export class RpcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RpcError';
	}
}

export interface RpcContext {
	workspace: Workspace;
	log?: Logger;
	/** Bereinigt Fehlertexte (z. B. von `git push`) */
	redactor?: Redactor;
	/** IDs laufender Läufe (deren Worktrees bleiben beim Aufräumen unangetastet) */
	activeRuns?: () => Iterable<string>;
}

function str(v: unknown, name: string, def?: string): string {
	if (v === undefined || v === null) {
		if (def !== undefined) return def;
		throw new RpcError(`Argument „${name}“ fehlt`);
	}
	if (typeof v !== 'string') throw new RpcError(`Argument „${name}“ muss eine Zeichenkette sein`);
	return v;
}

/** Arbeitsverzeichnis zum Ziel `main` bzw. `run:<id>` */
async function workspaceDir(ctx: RpcContext, cmd: RpcCommand): Promise<string> {
	if (cmd.target === 'main') return ctx.workspace.mainCopy(cmd.project);
	return ctx.workspace.runWorktree(cmd.target.slice(4));
}

/** Binärdaten? (NUL-Byte oder ungültiges UTF-8) */
function decodeText(buf: Buffer, truncated: boolean): string | null {
	if (buf.subarray(0, 8000).includes(0)) return null;
	const dec = new TextDecoder('utf-8', { fatal: true });
	for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
		try {
			return dec.decode(buf.subarray(0, buf.length - cut));
		} catch {
			// weiter kürzen (abgeschnittenes Mehrbyte-Zeichen)
		}
	}
	return null;
}

async function fsList(dir: string, args: Record<string, unknown>) {
	const p = await resolveInJail(dir, str(args.path, 'path', ''));
	const s = await stat(p.abs).catch(() => null);
	if (!s) throw new RpcError('Ordner nicht gefunden');
	if (!s.isDirectory()) throw new RpcError('Kein Ordner');
	const names = await readdir(p.abs);
	const entries: FsEntry[] = [];
	for (const name of names) {
		if (name === '.git') continue;
		try {
			const ls = await lstat(path.join(p.abs, name));
			entries.push({
				name,
				path: p.rel ? `${p.rel}/${name}` : name,
				type: ls.isSymbolicLink() ? 'symlink' : ls.isDirectory() ? 'dir' : 'file',
				size: ls.isFile() ? ls.size : 0
			});
		} catch {
			// verschwunden
		}
	}
	entries.sort((a, b) => {
		const da = a.type === 'dir' ? 0 : 1;
		const db = b.type === 'dir' ? 0 : 1;
		return da - db || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name);
	});
	return { path: p.rel, entries: entries.slice(0, MAX_LIST) };
}

async function fsRead(dir: string, args: Record<string, unknown>) {
	const p = await resolveInJail(dir, str(args.path, 'path'));
	const s = await stat(p.abs).catch(() => null);
	if (!s) throw new RpcError('Datei nicht gefunden');
	if (!s.isFile()) throw new RpcError('Keine Datei');
	const size = s.size;
	const len = Math.min(size, MAX_FILE_BYTES);
	const buf = Buffer.alloc(len);
	const fh = await open(p.abs, 'r');
	let read = 0;
	try {
		while (read < len) {
			const { bytesRead } = await fh.read(buf, read, len - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
	} finally {
		await fh.close();
	}
	const data = buf.subarray(0, read);
	const truncated = size > read;
	const text = decodeText(data, truncated);
	return text !== null
		? { path: p.rel, encoding: 'utf8' as const, content: text, size, truncated }
		: { path: p.rel, encoding: 'base64' as const, content: data.toString('base64'), size, truncated };
}

async function fsWrite(dir: string, args: Record<string, unknown>) {
	const p = await resolveInJail(dir, str(args.path, 'path'), { write: true });
	if (!p.rel) throw new RpcError('Pfad fehlt');
	const content = str(args.content, 'content');
	const encoding = str(args.encoding, 'encoding', 'utf8');
	if (encoding !== 'utf8' && encoding !== 'base64') throw new RpcError('Unbekannte Kodierung');
	const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
	if (buf.length > MAX_FILE_BYTES) throw new RpcError(`Datei zu groß (max. ${MAX_FILE_BYTES} Bytes)`);
	const existing = await lstat(p.abs).catch(() => null);
	if (existing?.isDirectory()) throw new RpcError('Ziel ist ein Ordner');
	await mkdir(path.dirname(p.abs), { recursive: true });
	// Ordner könnten zwischenzeitlich per Symlink umgelenkt worden sein → erneut prüfen
	await resolveInJail(dir, p.rel, { write: true });
	const tmp = path.join(path.dirname(p.abs), `.${path.basename(p.abs)}.aidev-${randomBytes(6).toString('hex')}.tmp`);
	try {
		await writeFile(tmp, buf, { flag: 'wx' });
		await rename(tmp, p.abs);
	} catch (e) {
		await unlink(tmp).catch(() => undefined);
		throw e;
	}
	return { path: p.rel, size: buf.length };
}

async function fsDelete(dir: string, args: Record<string, unknown>) {
	const p = await resolveInJail(dir, str(args.path, 'path'), { write: true });
	if (!p.rel) throw new RpcError('Das Arbeitsverzeichnis selbst kann nicht gelöscht werden');
	const s = await lstat(p.abs).catch(() => null);
	if (!s) throw new RpcError('Datei nicht gefunden');
	if (s.isDirectory()) {
		try {
			await rmdir(p.abs);
		} catch {
			throw new RpcError('Ordner ist nicht leer');
		}
	} else await unlink(p.abs);
	return { path: p.rel, deleted: true };
}

/** `git status --porcelain=v2 --branch -z` lesen */
export function parseStatusV2(out: string): z.infer<typeof gitStatusResult> {
	const res = { branch: '', head: '', ahead: 0, behind: 0, files: [] as { path: string; status: string }[] };
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const line = parts[i] ?? '';
		if (!line) continue;
		if (line.startsWith('# branch.oid ')) res.head = line.slice(13).trim() === '(initial)' ? '' : line.slice(13).trim();
		else if (line.startsWith('# branch.head ')) res.branch = line.slice(14).trim();
		else if (line.startsWith('# branch.ab ')) {
			const m = /\+(\d+) -(\d+)/.exec(line);
			if (m) {
				res.ahead = Number(m[1]);
				res.behind = Number(m[2]);
			}
		} else if (line.startsWith('1 ')) {
			const f = line.split(' ');
			res.files.push({ path: f.slice(8).join(' '), status: (f[1] ?? '..').replace(/\./g, ' ').trim() || 'M' });
		} else if (line.startsWith('2 ')) {
			const f = line.split(' ');
			res.files.push({ path: f.slice(9).join(' '), status: (f[1] ?? 'R.').replace(/\./g, ' ').trim() || 'R' });
			i++; // Ursprungspfad folgt als eigener Eintrag
		} else if (line.startsWith('u ')) {
			const f = line.split(' ');
			res.files.push({ path: f.slice(10).join(' '), status: 'U' });
		} else if (line.startsWith('? ')) {
			res.files.push({ path: line.slice(2), status: '??' });
		}
	}
	if (res.files.length > 5000) res.files = res.files.slice(0, 5000);
	return res;
}

async function gitStatus(ctx: RpcContext, dir: string) {
	const r = await ctx.workspace.run(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], {
		timeoutMs: RPC_TIMEOUT_MS
	});
	return parseStatusV2(r.stdout);
}

async function gitDiff(ctx: RpcContext, cmd: RpcCommand, dir: string) {
	const ws = ctx.workspace;
	const base = str(cmd.args.base, 'base', `origin/${cmd.project.defaultBranch}`);
	let head = str(cmd.args.head, 'head', '');
	assertRefName(base, 'Basis');
	const cache = ws.cacheDir(cmd.project);
	// Remote-Stand möglichst aktuell (Fehler beim Abrufen sind nicht fatal)
	await Promise.race([
		ws.ensureCache(cmd.project).catch(() => undefined),
		new Promise((r) => setTimeout(r, 8000).unref())
	]);
	if (!head) head = (await ws.run(dir, ['rev-parse', 'HEAD'], { timeoutMs: 5000 })).stdout.trim();
	assertRefName(head, 'Head');
	const resolve = async (ref: string): Promise<string> => {
		const cands = /^[0-9a-f]{7,40}$/.test(ref) ? [ref] : [`refs/remotes/${ref}`, `refs/remotes/origin/${ref}`, ref];
		for (const c of cands) {
			const sha = await ws.revParse(cache, c);
			if (sha) return sha;
		}
		// Commit nur im Worktree vorhanden? (geteilte Objektdatenbank – dann im Cache auflösbar)
		const local = await ws.revParse(dir, ref);
		if (local) return local;
		throw new RpcError(`Ref „${ref}“ nicht gefunden`);
	};
	const baseSha = await resolve(base);
	const headShaV = await resolve(head);
	const range = `${baseSha}...${headShaV}`;
	const num = await ws.run(cache, ['diff', '--numstat', '--no-renames', range], { timeoutMs: RPC_TIMEOUT_MS });
	const files = num.stdout
		.split('\n')
		.map((l) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l))
		.filter((m): m is RegExpExecArray => m !== null)
		.slice(0, 5000)
		.map((m) => ({
			path: m[3] ?? '',
			additions: m[1] === '-' ? 0 : Number(m[1]),
			deletions: m[2] === '-' ? 0 : Number(m[2])
		}));
	const diff = await ws.run(cache, ['diff', '--no-color', '--no-renames', range], {
		timeoutMs: RPC_TIMEOUT_MS,
		maxStdoutBytes: MAX_DIFF_BYTES
	});
	let text = diff.stdout;
	if (diff.truncated) {
		// Auf ganze Zeile kürzen
		const cut = text.lastIndexOf('\n');
		if (cut > 0) text = text.slice(0, cut + 1);
	}
	return { base, head, diff: text, truncated: diff.truncated, files };
}

async function gitLog(ctx: RpcContext, dir: string) {
	const r = await ctx.workspace.run(dir, ['log', '-50', '--format=%H%x1f%s%x1f%an%x1f%aI%x1e'], {
		allowFail: true,
		timeoutMs: RPC_TIMEOUT_MS
	});
	if (r.code !== 0) return { commits: [] };
	const commits = r.stdout
		.split('\x1e')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((rec) => {
			const [sha = '', message = '', author = '', date = ''] = rec.split('\x1f');
			return { sha, message, author, date };
		});
	return { commits };
}

type GhCheck = { __typename?: string; status?: string; conclusion?: string; state?: string };

/** Checks zusammenfassen: failure > pending > success, ohne Checks `none` */
export function summarizeChecks(rollup: unknown): string {
	if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
	let pending = false;
	for (const c of rollup as GhCheck[]) {
		const conclusion = (c.conclusion ?? '').toUpperCase();
		const state = (c.state ?? '').toUpperCase();
		const status = (c.status ?? '').toUpperCase();
		if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(conclusion) || ['FAILURE', 'ERROR'].includes(state))
			return 'failure';
		if (state === 'PENDING' || state === 'EXPECTED' || (status && status !== 'COMPLETED') || (!conclusion && !state))
			pending = true;
	}
	return pending ? 'pending' : 'success';
}

export function mapPr(p: Record<string, unknown>): PrInfo {
	const state = String(p.state ?? '').toUpperCase();
	return {
		number: Number(p.number) || 0,
		title: String(p.title ?? ''),
		branch: String(p.headRefName ?? ''),
		state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
		isDraft: p.isDraft === true,
		mergeable: String(p.mergeable ?? 'UNKNOWN'),
		checks: summarizeChecks(p.statusCheckRollup),
		autoMerge: p.autoMergeRequest !== null && p.autoMergeRequest !== undefined,
		url: String(p.url ?? ''),
		additions: Number(p.additions) || 0,
		deletions: Number(p.deletions) || 0,
		createdAt: String(p.createdAt ?? ''),
		updatedAt: String(p.updatedAt ?? ''),
		...(typeof p.headRefOid === 'string' && /^[0-9a-f]{40,64}$/.test(p.headRefOid) ? { headSha: p.headRefOid } : {}),
		...(typeof p.isCrossRepository === 'boolean' ? { crossRepository: p.isCrossRepository } : {})
	};
}

const PR_FIELDS =
	'number,title,headRefName,headRefOid,isCrossRepository,state,isDraft,mergeable,statusCheckRollup,autoMergeRequest,url,additions,deletions,createdAt,updatedAt';

async function prList(ctx: RpcContext, cmd: RpcCommand) {
	const slug = `${cmd.project.repoOwner}/${cmd.project.repoName}`;
	const r = await gh(ctx.workspace, ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', '100', '--json', PR_FIELDS], {
		timeoutMs: RPC_TIMEOUT_MS
	});
	if (r.code !== 0) throw new RpcError(`gh pr list fehlgeschlagen: ${(r.spawnError ?? r.stderr.trim()).slice(-1000)}`);
	let list: unknown;
	try {
		list = JSON.parse(r.stdout);
	} catch {
		throw new RpcError('gh pr list lieferte kein JSON');
	}
	if (!Array.isArray(list)) throw new RpcError('gh pr list lieferte keine Liste');
	return { pulls: list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(mapPr) };
}

async function prMerge(ctx: RpcContext, cmd: RpcCommand) {
	const n = cmd.args.number;
	if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new RpcError('Argument „number“ ist ungültig');
	const method = str(cmd.args.method, 'method', 'squash');
	if (!['merge', 'squash', 'rebase'].includes(method)) throw new RpcError('Argument „method“ ist ungültig');
	const args = ['pr', 'merge', String(n), '--repo', `${cmd.project.repoOwner}/${cmd.project.repoName}`, `--${method}`];
	if (cmd.args.auto === true) args.push('--auto');
	if (cmd.args.deleteBranch === true) args.push('--delete-branch');
	const r = await gh(ctx.workspace, args, { timeoutMs: RPC_TIMEOUT_MS });
	if (r.code !== 0) throw new RpcError(`Merge fehlgeschlagen: ${(r.spawnError ?? (r.stderr.trim() || r.stdout.trim())).slice(-1500)}`);
	return { ok: true, number: n, method, message: (r.stdout.trim() || r.stderr.trim()).slice(0, 2000) };
}

/**
 * Branch-Namen aus der Ausgabe von `git ls-remote --heads` (`<sha>\trefs/heads/<name>`) lesen: duplikatfrei,
 * `defaultBranch` (falls bekannt und vorhanden) zuerst, Rest alphabetisch, höchstens `MAX_REPO_BRANCHES`.
 * Namen über 255 Zeichen werden verworfen (Schema-Grenze).
 */
export function parseLsRemoteHeads(stdout: string, defaultBranch?: string | null): string[] {
	const names = new Set<string>();
	for (const line of stdout.split(/\r?\n/)) {
		const m = /^[0-9a-f]+\s+refs\/heads\/(\S+)\s*$/i.exec(line.trim());
		const name = m?.[1];
		if (name && name.length <= 255) names.add(name);
	}
	const rest = [...names].filter((b) => b !== defaultBranch).sort((a, b) => a.localeCompare(b));
	const out = defaultBranch && names.has(defaultBranch) ? [defaultBranch, ...rest] : rest;
	return out.slice(0, MAX_REPO_BRANCHES);
}

async function repoCheck(ctx: RpcContext, cmd: RpcCommand) {
	const ws = ctx.workspace;
	const url = ws.remoteUrl(cmd.project);
	const cfg = ws.netConfig(cmd.project).flatMap((c) => ['-c', c]);
	const ls = await exec('git', [...cfg, 'ls-remote', '--heads', url], { env: ws.env, timeoutMs: 12_000 });
	if (ls.code !== 0) {
		return {
			ok: false,
			defaultBranch: null,
			canPush: false,
			message: `Repository nicht erreichbar: ${(ls.spawnError ?? ls.stderr.trim()).split('\n').slice(-3).join(' ').slice(0, 1000)}`
		};
	}
	const view = await gh(ws, ['repo', 'view', `${cmd.project.repoOwner}/${cmd.project.repoName}`, '--json', 'defaultBranchRef,viewerPermission'], {
		timeoutMs: 12_000
	});
	if (view.code !== 0) {
		const m = /^\S+\s+refs\/heads\/(\S+)$/m.exec(ls.stdout);
		const defaultBranch = cmd.project.defaultBranch || (m?.[1] ?? null);
		return {
			ok: true,
			defaultBranch,
			canPush: false,
			message: `Repository erreichbar, gh-Abfrage fehlgeschlagen: ${(view.spawnError ?? view.stderr.trim()).slice(-500)}`,
			branches: parseLsRemoteHeads(ls.stdout, defaultBranch)
		};
	}
	try {
		const j = JSON.parse(view.stdout) as { defaultBranchRef?: { name?: string } | null; viewerPermission?: string };
		const perm = (j.viewerPermission ?? '').toUpperCase();
		const canPush = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(perm);
		const defaultBranch = j.defaultBranchRef?.name ?? null;
		return {
			ok: true,
			defaultBranch,
			canPush,
			message: canPush ? `Zugriff ok (${perm})` : `Kein Schreibrecht (${perm || 'unbekannt'})`,
			branches: parseLsRemoteHeads(ls.stdout, defaultBranch ?? (cmd.project.defaultBranch || null))
		};
	} catch {
		return {
			ok: true,
			defaultBranch: null,
			canPush: false,
			message: 'gh repo view lieferte kein JSON',
			branches: parseLsRemoteHeads(ls.stdout, cmd.project.defaultBranch || null)
		};
	}
}

/** Argument `branches` von `git.branch-delete` prüfen: nur eigene `aidev/`-Branches, nie der Haupt-Branch */
export function parseBranchList(v: unknown, defaultBranch: string): string[] {
	if (!Array.isArray(v)) throw new RpcError('Argument „branches“ muss eine Liste sein');
	if (v.length === 0) throw new RpcError('Argument „branches“ ist leer');
	if (v.some((b) => typeof b !== 'string')) throw new RpcError('Argument „branches“ darf nur Zeichenketten enthalten');
	const out = [...new Set(v as string[])];
	if (out.length > MAX_BRANCH_DELETE) throw new RpcError(`Höchstens ${MAX_BRANCH_DELETE} Branches je Aufruf`);
	for (const b of out) {
		try {
			assertRefName(b);
		} catch {
			throw new RpcError(`Branch „${b.slice(0, 200)}“ ist ungültig`);
		}
		if (!b.startsWith('aidev/')) throw new RpcError(`Branch „${b}“ gehört nicht zu aidev (Präfix „aidev/“ fehlt)`);
		if (b === defaultBranch) throw new RpcError(`Der Haupt-Branch „${b}“ wird nicht gelöscht`);
	}
	return out;
}

type GitFailure = Pick<ExecResult, 'spawnError' | 'stderr' | 'stdout' | 'timedOut'>;

/** Fehlertext von git kürzen (letzte aussagekräftige Zeilen, ohne „To …“/„hint:“/Sammelmeldung) und bereinigen */
function gitErrorText(ctx: RpcContext, r: GitFailure): string {
	const raw = r.timedOut ? 'Zeitlimit überschritten' : (r.spawnError ?? (r.stderr.trim() || r.stdout.trim() || 'unbekannter Fehler'));
	const lines = raw
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const useful = lines.filter((l) => !/^(To\s|hint:|error: failed to push some refs)/.test(l));
	const text = (useful.length ? useful : lines)
		.slice(-4)
		.join(' ')
		.slice(0, 500);
	return ctx.redactor ? ctx.redactor.redact(text) : text;
}

/** Argument `expect` von `git.branch-delete` prüfen: erwarteter Remote-Stand je Branch (nur Branches aus `branches`) */
export function parseExpected(v: unknown, branches: string[]): Map<string, string> {
	const out = new Map<string, string>();
	if (v === undefined || v === null) return out;
	if (typeof v !== 'object' || Array.isArray(v)) throw new RpcError('Argument „expect“ muss ein Objekt sein');
	const known = new Set(branches);
	for (const [b, sha] of Object.entries(v as Record<string, unknown>)) {
		if (!known.has(b)) throw new RpcError(`Argument „expect“ nennt einen unbekannten Branch „${b.slice(0, 200)}“`);
		if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) throw new RpcError(`Argument „expect“ für „${b}“ ist keine SHA`);
		out.set(b, sha);
	}
	return out;
}

/** Höchstzahl offener PRs, die vor dem Löschen geprüft werden (mehr → keine verlässliche Aussage → Abbruch) */
export const OPEN_PR_LIMIT = 1000;

/**
 * Branches, die offene PRs des Repositorys nutzen: Head-Branches aus demselben Repository und alle Basis-Branches
 * (gh paginiert bis `OPEN_PR_LIMIT`). Nicht verlässlich ermittelbar → `RpcError` (dann wird nichts gelöscht).
 */
async function openPrBranches(ctx: RpcContext, cmd: RpcCommand, timeoutMs: number): Promise<Set<string>> {
	const slug = `${cmd.project.repoOwner}/${cmd.project.repoName}`;
	const r = await gh(
		ctx.workspace,
		['pr', 'list', '--repo', slug, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'headRefName,baseRefName,isCrossRepository'],
		{ timeoutMs }
	);
	if (r.code !== 0) throw new RpcError(`Offene PRs nicht abrufbar: ${gitErrorText(ctx, { ...r, timedOut: false })}`);
	let list: unknown;
	try {
		list = JSON.parse(r.stdout);
	} catch {
		throw new RpcError('gh pr list lieferte kein JSON');
	}
	if (!Array.isArray(list)) throw new RpcError('gh pr list lieferte keine Liste');
	if (list.length >= OPEN_PR_LIMIT) throw new RpcError(`Mehr als ${OPEN_PR_LIMIT - 1} offene PRs – Branches werden nicht gelöscht`);
	const used = new Set<string>();
	for (const pr of list as Record<string, unknown>[]) {
		if (!pr || typeof pr !== 'object') continue;
		if (typeof pr.baseRefName === 'string') used.add(pr.baseRefName);
		// Head aus einem Fork nutzt nicht den gleichnamigen Branch dieses Repositorys; unbekannt → vorsichtshalber schon
		if (typeof pr.headRefName === 'string' && pr.isCrossRepository !== true) used.add(pr.headRefName);
	}
	return used;
}

/**
 * Remote-Branches löschen: fehlende → `missing`; Stand weicht von `expect` ab → `kept` (`changed`); von einem
 * offenen PR genutzt (live über gh geprüft) → `kept` (`open-pr`); nicht löschbare → `failed`. Der Push löscht nur
 * mit `--force-with-lease` auf den zuvor gelesenen Stand (zwischenzeitlich geändert → `failed`). Danach den Cache
 * nachziehen.
 */
async function branchDelete(ctx: RpcContext, cmd: RpcCommand) {
	const ws = ctx.workspace;
	const branches = parseBranchList(cmd.args.branches, cmd.project.defaultBranch);
	const expected = parseExpected(cmd.args.expect, branches);
	const url = ws.remoteUrl(cmd.project);
	const cfg = ws.netConfig(cmd.project).flatMap((c) => ['-c', c]);
	// Reserve fürs Aufräumen und die Antwort innerhalb des RPC-Zeitlimits
	const deadline = Date.now() + RPC_TIMEOUT_MS - 3000;
	const left = () => Math.max(1000, deadline - Date.now());

	/** Welche der Branches gibt es auf dem Remote (mit SHA)? */
	const existing = async (list: string[]): Promise<Map<string, string>> => {
		const ls = await exec('git', [...cfg, 'ls-remote', '--heads', url, ...list.map((b) => `refs/heads/${b}`)], {
			env: ws.env,
			timeoutMs: Math.min(12_000, left())
		});
		if (ls.code !== 0) throw new RpcError(`Repository nicht erreichbar: ${gitErrorText(ctx, ls)}`);
		const found = new Map<string, string>();
		for (const m of ls.stdout.matchAll(/^([0-9a-f]+)\s+refs\/heads\/(\S+)$/gm)) if (m[1] && m[2]) found.set(m[2], m[1]);
		return found;
	};

	const present = await existing(branches);
	const missing = branches.filter((b) => !present.has(b));
	const kept: { branch: string; reason: 'open-pr' | 'changed' }[] = [];
	let candidates = branches.filter((b) => present.has(b));
	for (const b of candidates) {
		const want = expected.get(b);
		if (want && want !== present.get(b)) kept.push({ branch: b, reason: 'changed' });
	}
	candidates = candidates.filter((b) => !kept.some((k) => k.branch === b));
	if (candidates.length) {
		const used = await openPrBranches(ctx, cmd, Math.min(10_000, left()));
		for (const b of candidates) if (used.has(b)) kept.push({ branch: b, reason: 'open-pr' });
	}
	const toDelete = candidates.filter((b) => !kept.some((k) => k.branch === b));
	const deleted: string[] = [];
	const failed: { branch: string; error: string }[] = [];

	if (toDelete.length) {
		// `git push` braucht ein Repository: der Cache, sonst ein leeres temporäres Bare-Repo
		const cache = ws.cacheDir(cmd.project);
		let tmp: string | null = null;
		let cwd = cache;
		if (!existsSync(path.join(cache, 'HEAD'))) {
			await mkdir(ws.tmpRoot, { recursive: true });
			tmp = await mkdtemp(path.join(ws.tmpRoot, 'branch-delete-'));
			await ws.git(['init', '--bare', '--quiet', tmp]);
			cwd = tmp;
		}
		const hooks = ['-c', `core.hooksPath=${ws.emptyHooksDir.replace(/\\/g, '/')}`];
		// Nur löschen, wenn der Remote noch auf dem gelesenen Stand ist
		const lease = (list: string[]) => list.map((b) => `--force-with-lease=refs/heads/${b}:${present.get(b) ?? ''}`);
		const push = (list: string[]) =>
			exec('git', [...cfg, ...hooks, 'push', '--quiet', '--no-verify', ...lease(list), url, '--delete', ...list.map((b) => `refs/heads/${b}`)], {
				cwd,
				env: ws.env,
				timeoutMs: Math.min(15_000, left())
			});
		try {
			const all = await push(toDelete);
			if (all.code === 0) deleted.push(...toDelete);
			else {
				// Evtl. teilweise gelöscht: Stand neu lesen, den Rest einzeln versuchen
				const still = await existing(toDelete).catch(() => new Map(toDelete.map((b) => [b, ''])));
				for (const b of toDelete) {
					if (!still.has(b)) deleted.push(b);
					else if (Date.now() >= deadline) failed.push({ branch: b, error: 'Zeitlimit überschritten' });
					else {
						const one = await push([b]);
						if (one.code === 0) deleted.push(b);
						else if (/remote ref does not exist/i.test(one.stderr)) missing.push(b);
						else failed.push({ branch: b, error: gitErrorText(ctx, one) });
					}
				}
			}
		} finally {
			if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	// Cache nachziehen (Fehler sind nicht fatal)
	const gone = [...deleted, ...missing];
	if (gone.length) {
		try {
			await ws.deleteCachedBranches(cmd.project, gone, new Set(ctx.activeRuns?.() ?? []));
		} catch (e) {
			(ctx.log ?? silentLogger).warn('Lokale Branches konnten nicht aufgeräumt werden', errorMessage(e));
		}
	}
	return { deleted, missing, failed, kept };
}

/** Eine RPC-Anfrage ausführen und das validierte Ergebnis liefern */
export async function executeRpc(ctx: RpcContext, cmd: RpcCommand): Promise<unknown> {
	const check = <T>(schema: z.ZodType<T>, v: unknown): T => {
		const r = schema.safeParse(v);
		if (!r.success) throw new RpcError(`Ergebnis entspricht nicht dem Protokoll: ${r.error.issues[0]?.message ?? ''}`);
		return r.data;
	};
	switch (cmd.op) {
		case 'fs.list':
			return check(fsListResult, await fsList(await workspaceDir(ctx, cmd), cmd.args));
		case 'fs.read':
			return check(fsReadResult, await fsRead(await workspaceDir(ctx, cmd), cmd.args));
		case 'fs.write':
			return fsWrite(await workspaceDir(ctx, cmd), cmd.args);
		case 'fs.delete':
			return fsDelete(await workspaceDir(ctx, cmd), cmd.args);
		case 'git.status':
			return check(gitStatusResult, await gitStatus(ctx, await workspaceDir(ctx, cmd)));
		case 'git.diff':
			return check(gitDiffResult, await gitDiff(ctx, cmd, await workspaceDir(ctx, cmd)));
		case 'git.log':
			return check(gitLogResult, await gitLog(ctx, await workspaceDir(ctx, cmd)));
		case 'gh.pr-list':
			return check(prListResult, await prList(ctx, cmd));
		case 'gh.pr-merge':
			return prMerge(ctx, cmd);
		case 'repo.check':
			return check(repoCheckResult, await repoCheck(ctx, cmd));
		case 'git.branch-delete':
			return check(branchDeleteResult, await branchDelete(ctx, cmd));
	}
}

/** Anfrage ausführen (mit Zeitlimit) und Antwort an Atrium senden */
export async function handleRpc(
	ctx: RpcContext & { api: RunnerApi; redactor: Redactor },
	cmd: RpcCommand
): Promise<void> {
	const log = ctx.log ?? silentLogger;
	let body: { ok: boolean; result?: unknown; error?: string };
	try {
		let timer: NodeJS.Timeout | undefined;
		const result = await Promise.race([
			executeRpc(ctx, cmd),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new RpcError('Zeitlimit der Anfrage überschritten')), RPC_TIMEOUT_MS);
			})
		]).finally(() => clearTimeout(timer));
		// Dateiinhalte für den Editor bleiben unverändert (sonst würde Speichern Werte zerstören);
		// alle übrigen Ergebnisse (Diffs, Meldungen, PR-Titel …) werden bereinigt.
		const raw = cmd.op === 'fs.read' || cmd.op === 'fs.list';
		body = { ok: true, result: raw ? result : ctx.redactor.redactDeep(result) };
	} catch (e) {
		const known = e instanceof RpcError || e instanceof PathError || e instanceof GitError;
		const msg = known ? e.message : `Interner Fehler: ${errorMessage(e)}`;
		if (!known) log.warn(`RPC ${cmd.op} fehlgeschlagen`, errorMessage(e));
		body = { ok: false, error: ctx.redactor.redact(msg).slice(0, 4000) };
	}
	try {
		await ctx.api.rpc(cmd.reqId, body);
	} catch (e) {
		log.warn(`RPC-Antwort ${cmd.reqId} konnte nicht gesendet werden`, errorMessage(e));
	}
}
