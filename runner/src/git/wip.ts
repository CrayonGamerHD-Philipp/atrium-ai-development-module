/**
 * WIP-Zwischenstände eines Laufs (Übergabe vor Standby/Herunterfahren, Checkpoints):
 *
 * - `snapshotWip`: Commit-Objekt aus HEAD plus allen Änderungen im Worktree (inkl. neuer, nicht ignorierter
 *   Dateien) über einen eigenen, temporären Index – Worktree, Index und Branch des Laufs bleiben unberührt, der
 *   Agent kann parallel weiterarbeiten.
 * - `pushWip`: Commit auf den eigenen Ref `refs/aidev/wip/<runId>` pushen (Force; der Ref gehört nur diesem Lauf).
 *   Kein Branch → erscheint weder in PRs noch im Haupt-Branch und löst keine Branch-CI aus.
 * - `fetchWip`/`restoreWip`: Ein anderer Runner holt den Ref und stellt den Stand als nicht committete Änderungen
 *   wieder her (Worktree auf dem WIP-Commit, danach `reset --mixed` auf dessen Eltern-Commit). Frühere Commits des
 *   unterbrochenen Laufs (lokal, noch nicht gepusht) bleiben dabei als Commits erhalten.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { wipRefOf } from '../protocol.ts';
import { GitError } from './git.ts';
import type { RepoRef, Workspace } from './workspace.ts';

/** Kennzeichen in der Commit-Nachricht eines WIP-Commits */
export const WIP_TRAILER = 'Aidev-Wip';

export interface WipSnapshot {
	sha: string;
	ref: string;
	/** HEAD des Worktrees beim Schnappschuss (Eltern-Commit) */
	parent: string;
	/** Enthält der Schnappschuss Änderungen gegenüber HEAD? */
	dirty: boolean;
}

/**
 * Schnappschuss als Commit-Objekt (ohne Branch). `exclude`: Pfade, die nie aufgenommen werden (z. B. die
 * Anhangsablage). Liefert auch ohne Änderungen einen Commit (gleicher Baum wie HEAD), damit lokale, noch nicht
 * gepushte Commits mitgesichert werden.
 */
export async function snapshotWip(
	ws: Workspace,
	dir: string,
	o: { runId: string; taskId: string; reason: string; exclude?: readonly string[]; signal?: AbortSignal }
): Promise<WipSnapshot> {
	const parent = (await ws.run(dir, ['rev-parse', 'HEAD'], { signal: o.signal })).stdout.trim();
	const gitDir = (await ws.run(dir, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
	const index = path.join(gitDir, `aidev-wip-${process.pid}-${Date.now()}.index`);
	const env = { GIT_INDEX_FILE: index };
	try {
		await ws.run(dir, ['read-tree', 'HEAD'], { env, signal: o.signal });
		await ws.run(dir, ['add', '-A'], { env, signal: o.signal, timeoutMs: 120_000 });
		if (o.exclude?.length) await ws.run(dir, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...o.exclude], { env });
		const tree = (await ws.run(dir, ['write-tree'], { env })).stdout.trim();
		const headTree = (await ws.run(dir, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
		const message = `WIP: Zwischenstand (${o.reason})\n\nAidev-Task: ${o.taskId}\nAidev-Run: ${o.runId}\n${WIP_TRAILER}: ${o.reason}\n`;
		const sha = (
			await ws.run(dir, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: message, signal: o.signal })
		).stdout.trim();
		if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError('WIP-Commit konnte nicht erzeugt werden');
		return { sha, ref: wipRefOf(o.runId), parent, dirty: tree !== headTree };
	} finally {
		await rm(index, { force: true }).catch(() => undefined);
	}
}

/** WIP-Commit auf `refs/aidev/wip/<runId>` pushen (eigener Ref des Laufs, daher Force) */
export async function pushWip(
	ws: Workspace,
	repo: RepoRef,
	dir: string,
	snap: WipSnapshot,
	o: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
	assertWipRef(snap.ref);
	await ws.run(dir, ['push', '--quiet', '--no-verify', '--force', 'origin', `${snap.sha}:${snap.ref}`], {
		config: [...ws.netConfig(repo), ...ws.noHooks],
		timeoutMs: o.timeoutMs ?? 60_000,
		signal: o.signal
	});
}

/** WIP-Ref eines anderen Laufs löschen (nach erfolgreicher Fortsetzung; Fehler werden ignoriert) */
export async function deleteWip(ws: Workspace, repo: RepoRef, dir: string, ref: string): Promise<boolean> {
	assertWipRef(ref);
	const r = await ws.run(dir, ['push', '--quiet', '--no-verify', 'origin', `:${ref}`], {
		config: [...ws.netConfig(repo), ...ws.noHooks],
		timeoutMs: 60_000,
		allowFail: true
	});
	return r.code === 0;
}

/** WIP-Ref in den Cache holen (`refs/aidev/fetched/<runId>`); liefert den SHA oder `null` */
export async function fetchWip(ws: Workspace, repo: RepoRef, cache: string, ref: string): Promise<string | null> {
	assertWipRef(ref);
	const local = ref.replace('refs/aidev/wip/', 'refs/aidev/fetched/');
	const r = await ws.run(cache, ['fetch', '--quiet', '--no-tags', 'origin', `+${ref}:${local}`], {
		config: ws.netConfig(repo),
		timeoutMs: 120_000,
		allowFail: true
	});
	if (r.code !== 0) return null;
	return ws.revParse(cache, local);
}

/** Ist `ancestor` Vorfahr von (oder gleich) `commit`? */
export async function isAncestor(ws: Workspace, cwd: string, ancestor: string, commit: string): Promise<boolean> {
	const r = await ws.run(cwd, ['merge-base', '--is-ancestor', ancestor, commit], { allowFail: true });
	return r.code === 0;
}

/**
 * Darf auf dem WIP-Commit fortgesetzt werden? Er muss genau der angebotene Commit sein, einen Eltern-Commit haben
 * und den aktuellen Stand des Remote-Branchs enthalten (sonst ist er veraltet: inzwischen wurde weitergearbeitet).
 */
export async function wipUsable(
	ws: Workspace,
	cache: string,
	o: { fetched: string | null; expected: string; remoteSha: string | null }
): Promise<{ ok: true; parent: string } | { ok: false; reason: string }> {
	if (!o.fetched) return { ok: false, reason: 'Zwischenstand nicht (mehr) vorhanden' };
	if (o.fetched !== o.expected) return { ok: false, reason: 'Zwischenstand wurde verändert' };
	const parent = await ws.revParse(cache, `${o.fetched}^`);
	if (!parent) return { ok: false, reason: 'Zwischenstand ohne Eltern-Commit' };
	if (o.remoteSha && !(await isAncestor(ws, cache, o.remoteSha, parent)))
		return { ok: false, reason: 'Zwischenstand ist älter als der Stand des Branches' };
	return { ok: true, parent };
}

/** Im Worktree (ausgecheckt auf dem WIP-Commit) den Stand als nicht committete Änderungen wiederherstellen */
export async function restoreWip(ws: Workspace, dir: string, parent: string): Promise<void> {
	await ws.run(dir, ['reset', '--quiet', '--mixed', parent]);
}

function assertWipRef(ref: string): void {
	if (!/^refs\/aidev\/wip\/[0-9a-f-]{36}$/.test(ref)) throw new GitError(`WIP-Ref „${ref}“ ist ungültig`);
}
