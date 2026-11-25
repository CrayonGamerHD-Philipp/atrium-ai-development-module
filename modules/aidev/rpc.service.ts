/**
 * RPC Atrium → Runner: Befehl `rpc` über den Runner-Hub senden und auf die Antwort (`POST /runner/rpc/:reqId`)
 * warten. Dazu die Wahl des Runners für Projekt-Operationen (Dateien, Git, PRs, Terminal).
 */
import { sql } from 'drizzle-orm';
import { errors, rowsOf } from '$lib/sdk/server';
import { mdb, oneOf, type Row, type Tx } from './db';
import { runnerConnected, sendToRunner } from './live';
import type { RpcOp, RpcProject, RpcResponseInput, WorkspaceTarget } from './protocol';

interface PendingRpc {
	runnerId: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRpc>();

export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

export function rpcProjectOf(project: Row): RpcProject {
	return {
		id: String(project.id),
		repoOwner: String(project.repo_owner),
		repoName: String(project.repo_name),
		defaultBranch: String(project.default_branch)
	};
}

/**
 * Befehl an den Runner senden und auf die Antwort warten. Runner nicht verbunden oder keine Antwort →
 * `unavailable`; Fehlermeldung des Runners → `badRequest` mit dessen Text.
 */
export function callRunner(
	runnerId: string,
	op: RpcOp,
	project: RpcProject,
	target: WorkspaceTarget,
	args: Record<string, unknown> = {},
	timeoutMs = DEFAULT_RPC_TIMEOUT_MS
): Promise<unknown> {
	if (!runnerConnected(runnerId)) {
		return Promise.reject(errors.unavailable('Kein Runner erreichbar'));
	}
	const reqId = crypto.randomUUID();
	return new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(reqId);
			reject(errors.unavailable('Der Runner hat nicht rechtzeitig geantwortet'));
		}, timeoutMs);
		pending.set(reqId, { runnerId, resolve, reject, timer });
		const sent = sendToRunner(runnerId, { type: 'rpc', reqId, op, project, target, args });
		if (!sent) {
			clearTimeout(timer);
			pending.delete(reqId);
			reject(errors.unavailable('Kein Runner erreichbar'));
		}
	});
}

/** Antwort des Runners zuordnen; `false` = unbekannt oder von einem anderen Runner */
export function resolveRpc(runnerId: string, reqId: string, response: RpcResponseInput): boolean {
	const entry = pending.get(reqId);
	if (!entry || entry.runnerId !== runnerId) return false;
	pending.delete(reqId);
	clearTimeout(entry.timer);
	if (response.ok) entry.resolve(response.result ?? null);
	else entry.reject(errors.badRequest(`Runner: ${response.error || 'Unbekannter Fehler'}`));
	return true;
}

/** Wartende Anfragen eines Runners (oder alle) sofort abbrechen */
export function rejectAllRpc(runnerId?: string): void {
	for (const [reqId, entry] of pending) {
		if (runnerId && entry.runnerId !== runnerId) continue;
		pending.delete(reqId);
		clearTimeout(entry.timer);
		entry.reject(errors.unavailable('Kein Runner erreichbar'));
	}
}

/** Nur für Tests: Anzahl wartender Anfragen */
export const pendingRpcCount = () => pending.size;

/** Antwort mit einem Schema prüfen; ungültig → `unavailable` */
export function parseResult<T>(
	schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
	value: unknown
): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw errors.unavailable('Ungültige Antwort des Runners');
	return parsed.data;
}

// ---------------------------------------------------------------- Runner-Wahl

/** Optionen der Runner-Wahl: nur Runner mit Terminal (`pty`) bzw. mit `git.branch-delete` (`branchCleanup`) */
export interface PickRunnerOptions {
	pty?: boolean;
	branchCleanup?: boolean;
}

/** Freigegebene Runner, die gerade verbunden sind (optional nur mit Capability `branchCleanup`) */
async function connectedRunners(tx: Tx, branchCleanup = false): Promise<Row[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT * FROM runner WHERE status = 'approved'
			${branchCleanup ? sql`AND capabilities->>'branchCleanup' = 'true'` : sql``}
			ORDER BY last_seen_at DESC NULLS LAST, created_at`
	);
	return rows.filter((r) => runnerConnected(String(r.id)));
}

const hasPty = (r: Row) => {
	const caps = r.capabilities as { pty?: boolean } | null;
	return caps?.pty === true;
};

/**
 * Runner für eine Projekt-Operation: bevorzugter Runner des Projekts (verbunden + freigegeben), sonst der
 * Runner des letzten Laufs des Projekts, sonst irgendein verbundener Runner. Bei `target = run:<id>` der
 * Runner dieses Laufs (Lauf muss zum Projekt gehören). `opts` schränkt auf passende Runner ein (auch beim
 * Lauf-Ziel). Kein Runner → `unavailable`.
 */
export async function pickRunner(
	tx: Tx,
	project: Row,
	target: WorkspaceTarget,
	opts: PickRunnerOptions = {}
): Promise<string> {
	const runners = (await connectedRunners(tx, opts.branchCleanup)).filter(
		(r) => !opts.pty || hasPty(r)
	);
	const ids = new Set(runners.map((r) => String(r.id)));
	if (target.startsWith('run:')) {
		const runId = target.slice(4);
		const run = await oneOf(
			tx,
			sql`SELECT runner_id FROM run WHERE id = ${runId} AND project_id = ${project.id}`
		);
		if (!run) throw errors.notFound('Lauf nicht gefunden');
		const id = run.runner_id ? String(run.runner_id) : null;
		if (!id || !ids.has(id)) throw errors.unavailable('Kein Runner erreichbar');
		return id;
	}
	const preferred = project.preferred_runner_id ? String(project.preferred_runner_id) : null;
	if (preferred && ids.has(preferred)) return preferred;
	const last = await rowsOf(
		tx,
		sql`SELECT runner_id FROM run WHERE project_id = ${project.id} AND runner_id IS NOT NULL
			ORDER BY created_at DESC LIMIT 20`
	);
	for (const r of last) if (ids.has(String(r.runner_id))) return String(r.runner_id);
	const any = runners[0];
	if (!any) {
		throw errors.unavailable(
			opts.pty
				? 'Kein Runner mit Terminal erreichbar'
				: opts.branchCleanup
					? 'Kein Runner mit Branch-Aufräumen erreichbar'
					: 'Kein Runner erreichbar'
		);
	}
	return String(any.id);
}

/** Irgendein verbundener, freigegebener Runner (ohne Projektbezug, z. B. Repo vor dem Anlegen prüfen) */
export async function pickAnyRunner(tx: Tx): Promise<string> {
	const any = (await connectedRunners(tx))[0];
	if (!any) throw errors.unavailable('Kein Runner erreichbar');
	return String(any.id);
}

/** Projekt laden (404) und Runner wählen – in einer eigenen Transaktion */
export async function projectAndRunner(
	projectId: string,
	target: WorkspaceTarget,
	opts: PickRunnerOptions = {}
): Promise<{ project: Row; runnerId: string }> {
	return mdb().transaction(async (tx) => {
		const project = await oneOf(tx, sql`SELECT * FROM project WHERE id = ${projectId}`);
		if (!project) throw errors.notFound('Projekt nicht gefunden');
		return { project, runnerId: await pickRunner(tx, project, target, opts) };
	});
}
