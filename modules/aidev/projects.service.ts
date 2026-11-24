/** Projekte: Repo-Angabe zerlegen, Eingaben prüfen. */
import { sql } from 'drizzle-orm';
import { errors } from '$lib/sdk/server';
import { oneOf, type Row, type Tx } from './db';
import { repoSlug } from './schemas';

const REPO_RE =
	/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git` → Teile, sonst `null` */
export function parseRepo(input: string): { owner: string; name: string } | null {
	const m = REPO_RE.exec(input.trim());
	if (!m) return null;
	const owner = m[1] ?? '';
	const name = m[2] ?? '';
	if (!repoSlug.safeParse(owner).success || !repoSlug.safeParse(name).success) return null;
	if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
	return { owner, name };
}

export function requireRepo(input: string): { owner: string; name: string } {
	const repo = parseRepo(input);
	if (!repo) {
		throw errors.validation([
			{
				path: ['repo'],
				message: 'GitHub-Repo als „owner/repo“ oder Link (https://github.com/owner/repo) angeben'
			}
		]);
	}
	return repo;
}

export async function assertRunnerExists(tx: Tx, runnerId: string | null | undefined) {
	if (!runnerId) return;
	if (!(await oneOf(tx, sql`SELECT 1 FROM runner WHERE id = ${runnerId}`))) {
		throw errors.validation([{ path: ['preferredRunnerId'], message: 'Unbekannter Runner' }]);
	}
}

export async function requireProject(tx: Tx, id: string, forUpdate = false): Promise<Row> {
	const row = await oneOf(
		tx,
		forUpdate
			? sql`SELECT * FROM project WHERE id = ${id} FOR UPDATE`
			: sql`SELECT * FROM project WHERE id = ${id}`
	);
	if (!row) throw errors.notFound('Projekt nicht gefunden');
	return row;
}

export async function assertNoDuplicate(tx: Tx, owner: string, name: string, exceptId?: string) {
	const dup = await oneOf(
		tx,
		sql`SELECT id FROM project WHERE lower(repo_owner) = lower(${owner})
			AND lower(repo_name) = lower(${name}) AND archived_at IS NULL
			${exceptId ? sql`AND id <> ${exceptId}` : sql``}`
	);
	if (dup) throw errors.conflict('Für dieses Repo gibt es bereits ein Projekt');
}
