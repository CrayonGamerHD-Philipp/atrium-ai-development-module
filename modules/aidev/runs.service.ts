/**
 * Rückmeldungen der Runner zu Läufen: annehmen, ablehnen, Ereignisse, Verbrauch, Limits, Abschluss – dazu
 * `loseRun` (Lease abgelaufen, Runner gesperrt). Folgezustände der Aufträge: siehe Kopf von `tasks.service.ts`.
 *
 * Verbindungsverlust (`loseRun(…, { connection: true })`: Lease eines laufenden Laufs abgelaufen oder Runner nach
 * Neustart/Absturz ohne den Lauf angemeldet): `error_kind = CONNECTION_LOST` (`'connection'`), der Versuch wird
 * zurückgebucht und der Auftrag wieder `queued` (`CONNECTION_LOST_MESSAGE`). Ab `MAX_CONNECTION_RETRIES`
 * aufeinanderfolgenden Verlusten seit dem letzten Neustart (`connectionLossStreak`) → `failed`
 * (`CONNECTION_LOST_FAILED_MESSAGE`). `connectionLossTargets` liefert dem Scheduler die betroffenen Runner/Konten.
 */
import { sql } from 'drizzle-orm';
import { errors, inList, num, rowsOf, str, toIso, type Row } from '$lib/sdk/server';
import { clip, jsonb, LEASE_SEC, MAX_CONNECTION_RETRIES, oneOf, type Tx } from './db';
import { sendCommand, type Effects } from './effects';
import { storeLimitSnapshot } from './limits.service';
import { extractPlan } from './prompts';
import {
	MAX_EVENT_TEXT,
	type FinishInput,
	type LimitInput,
	type RunEvent,
	type UsageInput
} from './protocol';
import { backoffMs, calibrateBudget, unitsOf, weekStartOf } from './scheduler';
import type { Limits } from './schemas';
import {
	applyOutcome,
	applyPlan,
	checkPlan,
	createResolveTask,
	excludeAccount,
	getTask,
	isFinal,
	planOf,
	transition,
	upsertPull,
	type PullInfo,
	type StoredPlan
} from './tasks.service';

const LEASE = sql`now() + ${LEASE_SEC}::int * interval '1 second'`;
const ACTIVE = ['offered', 'running'];

/** Lauf dieses Runners (fremde/unbekannte → 404) */
export async function ownRun(tx: Tx, runnerId: string, runId: string): Promise<Row> {
	const candidate = await oneOf(
		tx,
		sql`SELECT task_id FROM run WHERE id = ${runId} AND runner_id = ${runnerId}`
	);
	if (!candidate) throw errors.notFound('Lauf nicht gefunden');
	// Zustandswechsel sperren immer zuerst den Auftrag und danach den Lauf.
	await getTask(tx, String(candidate.task_id), true);
	const run = await oneOf(
		tx,
		sql`SELECT * FROM run WHERE id = ${runId} AND runner_id = ${runnerId} FOR UPDATE`
	);
	if (!run) throw errors.notFound('Lauf nicht gefunden');
	return run;
}

/** Reservierung des Laufs: nie gestartet → löschen, sonst als Schätzung behalten (ohne gemeldeten Verbrauch) */
async function settleReservation(tx: Tx, run: Row, started: boolean): Promise<void> {
	const reported = await oneOf(
		tx,
		sql`SELECT 1 FROM usage_ledger WHERE run_id = ${run.id} AND source = 'reported' LIMIT 1`
	);
	if (!started || reported) {
		await tx.execute(
			sql`DELETE FROM usage_ledger WHERE run_id = ${run.id} AND source = 'reserved'`
		);
	} else {
		await tx.execute(
			sql`UPDATE usage_ledger SET source = 'estimated' WHERE run_id = ${run.id} AND source = 'reserved'`
		);
	}
}

/** `error_kind` eines Laufs, dessen Verbindung zum Runner verloren ging (Lease abgelaufen, Runner neu gestartet) */
export const CONNECTION_LOST = 'connection';
/** Meldung am Auftrag nach einem Verbindungsverlust (er wird automatisch neu eingeplant) */
export const CONNECTION_LOST_MESSAGE =
	'Verbindung zum Runner verloren – Auftrag wird automatisch neu gestartet';
/** Meldung am Auftrag, wenn `MAX_CONNECTION_RETRIES` aufeinanderfolgende Verbindungsverluste erreicht sind */
export const CONNECTION_LOST_FAILED_MESSAGE = `Verbindung zum Runner ${MAX_CONNECTION_RETRIES}-mal in Folge verloren – automatische Neustarts beendet. Bitte Runner prüfen und den Auftrag mit „Neu starten“ erneut einplanen.`;

/**
 * Läufe, die seit dem letzten Neustart des Auftrags tatsächlich liefen: `task.started_at` wird beim Neustart
 * geleert und bei der ersten Annahme danach gesetzt (`acceptRun`), ältere Läufe zählen daher nicht mehr.
 */
const SINCE_RESTART = sql`r.started_at IS NOT NULL AND r.started_at >= t.started_at`;

/**
 * Aufeinanderfolgende jüngste Verbindungsverluste des Auftrags (nach `created_at` absteigend, bis zum ersten
 * gestarteten Lauf mit anderem Ausgang) seit dem letzten Neustart. Nie gestartete Läufe (abgelehnt, Angebot
 * verfallen) unterbrechen die Folge nicht – sonst setzte ein abstürzender Runner, der Angebote verfallen lässt,
 * den Zähler immer wieder zurück.
 */
export async function connectionLossStreak(tx: Tx, taskId: string): Promise<number> {
	const row = await oneOf(
		tx,
		sql`SELECT count(*)::int AS n FROM run r JOIN task t ON t.id = r.task_id
			WHERE r.task_id = ${taskId} AND r.status = 'lost' AND r.error_kind = ${CONNECTION_LOST}
				AND ${SINCE_RESTART}
				AND r.created_at > COALESCE((
					SELECT max(o.created_at) FROM run o
					WHERE o.task_id = ${taskId} AND o.started_at IS NOT NULL
						AND o.status NOT IN ('offered', 'running')
						AND NOT (o.status = 'lost' AND o.error_kind = ${CONNECTION_LOST})
				), '-infinity'::timestamptz)`
	);
	return num(row?.n);
}

/**
 * Runner und Konten der Verbindungsverluste seit dem letzten Neustart je Auftrag – der Scheduler zieht sie weich
 * ab (anderer Agent bevorzugt, der alte bleibt als Ausweg).
 */
export async function connectionLossTargets(
	tx: Tx,
	taskIds: string[]
): Promise<Map<string, { runnerIds: string[]; accountIds: string[] }>> {
	const out = new Map<string, { runnerIds: string[]; accountIds: string[] }>();
	if (!taskIds.length) return out;
	const rows = await rowsOf(
		tx,
		sql`SELECT r.task_id, array_agg(DISTINCT r.runner_id) FILTER (WHERE r.runner_id IS NOT NULL) AS runner_ids,
				array_agg(DISTINCT r.account_id) FILTER (WHERE r.account_id IS NOT NULL) AS account_ids
			FROM run r JOIN task t ON t.id = r.task_id
			WHERE r.task_id IN (${inList(taskIds)}) AND r.status = 'lost'
				AND r.error_kind = ${CONNECTION_LOST} AND ${SINCE_RESTART}
			GROUP BY r.task_id`
	);
	for (const r of rows) {
		out.set(String(r.task_id), {
			runnerIds: ((r.runner_ids as unknown[] | null) ?? []).map(String),
			accountIds: ((r.account_ids as unknown[] | null) ?? []).map(String)
		});
	}
	return out;
}

/** Art des Verlusts für `loseRun` */
export interface LoseRunOptions {
	/**
	 * Verbindung zum Runner verloren (Lease eines laufenden Laufs abgelaufen, Runner neu gestartet): `error_kind`
	 * = `connection`, der Versuch zählt nicht, der Auftrag wird wieder `queued` – bis `MAX_CONNECTION_RETRIES`
	 * aufeinanderfolgende Verluste erreicht sind (→ `failed`, Hinweis auf „Neu starten“).
	 */
	connection?: boolean;
}

/**
 * Lauf als verloren markieren und den Auftrag zurückstellen. `counted` = Versuch zählt (lief bereits);
 * sonst wird er zurückgebucht. Ohne verbleibende Versuche → `failed`. `opts.connection`: Verbindungsverlust
 * (siehe `LoseRunOptions`, `counted` wird dann ignoriert).
 */
export async function loseRun(
	tx: Tx,
	fx: Effects,
	run: Row,
	message: string,
	counted: boolean,
	opts: LoseRunOptions = {}
): Promise<void> {
	const kind = opts.connection ? sql`${CONNECTION_LOST}` : sql`COALESCE(error_kind, 'internal')`;
	await tx.execute(
		sql`UPDATE run SET status = 'lost', finished_at = now(), lease_expires_at = NULL,
				error_kind = ${kind}, error_message = ${message}
			WHERE id = ${run.id}`
	);
	await settleReservation(tx, run, run.status === 'running');
	sendCommand(fx, str(run.runner_id), { type: 'cancel', runId: String(run.id), reason: message });
	fx.runs.add(String(run.id));
	fx.overview = true;
	fx.dispatch = true;
	const task = await getTask(tx, String(run.task_id), true);
	if (!task || (task.status !== 'queued' && task.status !== 'running')) return;
	if (opts.connection) {
		await tx.execute(
			sql`UPDATE task SET attempts = GREATEST(attempts - 1, 0) WHERE id = ${task.id}`
		);
		const streak = await connectionLossStreak(tx, String(task.id));
		const exhausted = streak >= MAX_CONNECTION_RETRIES;
		await transition(tx, fx, String(task.id), exhausted ? 'failed' : 'queued', {
			error: exhausted ? CONNECTION_LOST_FAILED_MESSAGE : CONNECTION_LOST_MESSAGE
		});
		return;
	}
	if (!counted) {
		await tx.execute(
			sql`UPDATE task SET attempts = GREATEST(attempts - 1, 0) WHERE id = ${task.id}`
		);
		await transition(tx, fx, String(task.id), 'queued', { error: message });
		return;
	}
	const exhausted = num(task.attempts) >= num(task.max_attempts);
	await transition(tx, fx, String(task.id), exhausted ? 'failed' : 'queued', { error: message });
}

// ---------------------------------------------------------------- Annehmen / Ablehnen

export async function acceptRun(tx: Tx, fx: Effects, runnerId: string, runId: string) {
	const run = await ownRun(tx, runnerId, runId);
	if (run.status === 'running') return { ok: true };
	if (run.status !== 'offered') throw errors.conflict('Der Lauf ist nicht mehr angeboten');
	const task = await getTask(tx, String(run.task_id), true);
	if (!task || task.status !== 'queued') {
		await tx.execute(
			sql`UPDATE run SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL,
					error_kind = 'cancelled', error_message = 'Auftrag nicht mehr offen'
				WHERE id = ${run.id}`
		);
		await settleReservation(tx, run, false);
		fx.runs.add(runId);
		throw errors.conflict('Der Auftrag ist nicht mehr offen');
	}
	await tx.execute(
		sql`UPDATE run SET status = 'running', started_at = now(), lease_expires_at = ${LEASE}
			WHERE id = ${run.id}`
	);
	await tx.execute(
		sql`UPDATE task SET started_at = COALESCE(started_at, now()) WHERE id = ${task.id}`
	);
	await transition(tx, fx, String(task.id), 'running');
	fx.runs.add(runId);
	return { ok: true };
}

export async function rejectRun(
	tx: Tx,
	fx: Effects,
	runnerId: string,
	runId: string,
	reason: string
) {
	const run = await ownRun(tx, runnerId, runId);
	if (run.status !== 'offered') return { ok: true };
	// Ein Runner, der gerade beendet wird, lehnt alles ab – das Konto bleibt für den Auftrag zulässig
	const draining = await oneOf(
		tx,
		sql`SELECT 1 FROM runner WHERE id = ${runnerId} AND draining LIMIT 1`
	);
	if (run.account_id && !draining)
		await excludeAccount(tx, String(run.task_id), String(run.account_id));
	await loseRun(tx, fx, run, `Vom Runner abgelehnt: ${reason || 'ohne Grund'}`, false);
	return { ok: true };
}

// ---------------------------------------------------------------- Ereignisse

/** Texte kürzen; sehr große Nutzlasten durch eine gekürzte Textform ersetzen */
export function trimPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		out[k] = typeof v === 'string' ? clip(v, MAX_EVENT_TEXT) : v;
	}
	const json = JSON.stringify(out);
	if (json.length <= MAX_EVENT_TEXT * 4) return out;
	return {
		...(typeof out.name === 'string' ? { name: out.name } : {}),
		text: clip(json, MAX_EVENT_TEXT),
		truncated: true
	};
}

export async function recordEvents(
	tx: Tx,
	runnerId: string,
	runId: string,
	events: RunEvent[],
	limits: Limits
): Promise<{ run: Row; inserted: RunEvent[]; dropped: number }> {
	const run = await ownRun(tx, runnerId, runId);
	const room = Math.max(0, limits.maxEventsPerRun - num(run.event_count));
	const unique = [...new Map(events.map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
	const take = unique.slice(0, room);
	let inserted: RunEvent[] = [];
	if (take.length) {
		const values = sql.join(
			take.map(
				(e) =>
					sql`(${run.id}, ${e.seq}, ${e.ts}::timestamptz, ${e.kind}, ${jsonb(trimPayload(e.payload))})`
			),
			sql`, `
		);
		const rows = await rowsOf(
			tx,
			sql`INSERT INTO run_event (run_id, seq, ts, kind, payload) VALUES ${values}
				ON CONFLICT (run_id, seq) DO NOTHING
				RETURNING seq, ts, kind, payload`
		);
		inserted = rows
			.map((r) => ({
				seq: num(r.seq),
				ts: toIso(r.ts),
				kind: String(r.kind) as RunEvent['kind'],
				payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
					string,
					unknown
				>
			}))
			.sort((a, b) => a.seq - b.seq);
	}
	const bytes = inserted.reduce((n, e) => n + JSON.stringify(e.payload).length, 0);
	await tx.execute(
		sql`UPDATE run SET event_count = event_count + ${inserted.length},
				event_bytes = event_bytes + ${bytes},
				lease_expires_at = CASE WHEN status = 'running' THEN ${LEASE} ELSE lease_expires_at END
			WHERE id = ${run.id}`
	);
	return { run, inserted, dropped: unique.length - take.length };
}

// ---------------------------------------------------------------- Verbrauch und Limits

export async function recordUsage(
	tx: Tx,
	fx: Effects,
	runnerId: string,
	runId: string,
	input: UsageInput
): Promise<{ units: number }> {
	const run = await ownRun(tx, runnerId, runId);
	const units = unitsOf(input);
	if (run.account_id) {
		await tx.execute(
			sql`INSERT INTO usage_ledger (id, account_id, run_id, model, input_tokens, output_tokens,
					cache_read_tokens, cache_write_tokens, cost_microusd, units, source)
				VALUES (${crypto.randomUUID()}, ${run.account_id}, ${run.id}, ${input.model || String(run.model ?? '')},
					${input.inputTokens}, ${input.outputTokens}, ${input.cacheReadTokens},
					${input.cacheWriteTokens}, ${Math.round((input.costUsd ?? 0) * 1_000_000)}, ${units}, 'reported')`
		);
	}
	await tx.execute(sql`DELETE FROM usage_ledger WHERE run_id = ${run.id} AND source = 'reserved'`);
	await tx.execute(sql`UPDATE run SET units = units + ${units} WHERE id = ${run.id}`);
	fx.overview = true;
	return { units };
}

const LIMIT_REASONS: Record<LimitInput['kind'], string> = {
	rate: 'Rate-Limit des Anbieters',
	'5h': '5-Stunden-Limit erreicht',
	week: 'Wochenlimit erreicht',
	auth: 'Anmeldung beim Anbieter abgelaufen',
	other: 'Limit des Anbieters erreicht'
};

async function usedSince(tx: Tx, accountId: string, since: number): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT COALESCE(sum(units), 0) AS used FROM usage_ledger
			WHERE account_id = ${accountId} AND source <> 'reserved'
				AND ts >= ${new Date(since).toISOString()}::timestamptz`
	);
	return num(r?.used);
}

export async function recordLimit(
	tx: Tx,
	fx: Effects,
	runnerId: string,
	runId: string,
	input: LimitInput
): Promise<{ cooldownUntil: string | null }> {
	const run = await ownRun(tx, runnerId, runId);
	if (!run.account_id) return { cooldownUntil: null };
	const account = await oneOf(
		tx,
		sql`SELECT * FROM provider_account WHERE id = ${run.account_id} FOR UPDATE`
	);
	if (!account) return { cooldownUntil: null };
	const now = Date.now();
	const anchor = account.week_anchor ? new Date(toIso(account.week_anchor)).getTime() : null;
	const used5h = await usedSince(tx, String(account.id), now - 5 * 3600 * 1000);
	const usedWeek = await usedSince(tx, String(account.id), weekStartOf(anchor, now));
	const resetsAt = input.resetsAt ? new Date(input.resetsAt).getTime() : null;
	const until = new Date(
		resetsAt && resetsAt > now ? resetsAt : now + backoffMs(num(account.cooldown_strikes))
	).toISOString();
	const prev = (v: unknown) => (v === null || v === undefined ? null : num(v));
	const cal5h =
		input.kind === '5h' ? calibrateBudget(prev(account.calibrated_5h_units), used5h) : null;
	const calWeek =
		input.kind === 'week' ? calibrateBudget(prev(account.calibrated_week_units), usedWeek) : null;
	await tx.execute(
		sql`UPDATE provider_account SET cooldown_until = ${until}::timestamptz,
				cooldown_reason = ${LIMIT_REASONS[input.kind]},
				cooldown_strikes = cooldown_strikes + 1,
				calibrated_5h_units = ${cal5h === null ? sql`calibrated_5h_units` : sql`${cal5h}`},
				calibrated_week_units = ${calWeek === null ? sql`calibrated_week_units` : sql`${calWeek}`},
				logged_in = ${input.kind === 'auth' ? sql`false` : sql`logged_in`}
			WHERE id = ${account.id}`
	);
	await tx.execute(
		sql`INSERT INTO limit_event (id, account_id, run_id, kind, resets_at, units_at_hit, raw)
			VALUES (${crypto.randomUUID()}, ${account.id}, ${run.id}, ${input.kind},
				${input.resetsAt}::timestamptz, ${input.kind === 'week' ? usedWeek : used5h}, ${clip(input.raw, 2000)})`
	);
	// Limit-Fenster zum Zeitpunkt des Treffers als neuer Schnappschuss (nur neuere Runner melden sie)
	if (input.windows) {
		await storeLimitSnapshot(
			tx,
			String(account.id),
			{ observedAt: new Date(now).toISOString(), source: 'error', windows: input.windows },
			now
		);
	}
	fx.overview = true;
	fx.dispatch = true;
	return { cooldownUntil: until };
}

// ---------------------------------------------------------------- Abschluss

export async function finishRun(
	tx: Tx,
	fx: Effects,
	runnerId: string,
	runId: string,
	input: FinishInput
): Promise<{ ok: true; taskStatus: string | null }> {
	const run = await ownRun(tx, runnerId, runId);
	if (!ACTIVE.includes(String(run.status))) {
		// schon abgeschlossen (Wiederholung des Runners) – nichts mehr ändern
		const t = await getTask(tx, String(run.task_id));
		return { ok: true, taskStatus: t ? String(t.status) : null };
	}
	await tx.execute(
		sql`UPDATE run SET status = ${input.status}, finished_at = now(), lease_expires_at = NULL,
				session_id = COALESCE(${input.sessionId}, session_id),
				head_sha = COALESCE(${input.headSha}, head_sha),
				branch = COALESCE(${input.branch}, branch),
				summary = ${input.summary},
				error_kind = ${input.errorKind},
				error_message = ${input.errorMessage},
				started_at = COALESCE(started_at, now())
			WHERE id = ${run.id}`
	);
	for (const c of input.commits) {
		await tx.execute(
			sql`INSERT INTO run_commit (run_id, sha, message, additions, deletions, files)
				VALUES (${run.id}, ${c.sha}, ${c.message}, ${c.additions}, ${c.deletions}, ${jsonb(c.files)})
				ON CONFLICT (run_id, sha) DO NOTHING`
		);
	}
	await settleReservation(tx, run, true);
	fx.runs.add(runId);
	fx.overview = true;
	fx.dispatch = true;
	if (input.status === 'succeeded' && run.account_id) {
		await tx.execute(
			sql`UPDATE provider_account SET cooldown_strikes = 0 WHERE id = ${run.account_id}`
		);
	}

	const task = await getTask(tx, String(run.task_id), true);
	if (!task) return { ok: true, taskStatus: null };
	if (input.sessionId) {
		await tx.execute(
			sql`UPDATE task SET session_id = ${input.sessionId}, session_account_id = ${run.account_id}
				WHERE id = ${task.id}`
		);
	}
	const pr: PullInfo | null = input.pr
		? {
				number: input.pr.number,
				url: input.pr.url,
				branch: input.branch ?? str(run.branch),
				merged: input.merged
			}
		: null;

	// Auftrag inzwischen beendet (abgebrochen, Elternauftrag gescheitert): nur Ergebnis festhalten
	if (isFinal(task.status) || (task.status !== 'queued' && task.status !== 'running')) {
		if (pr)
			await upsertPull(tx, fx, String(task.project_id), String(task.id), String(task.title), pr);
		return { ok: true, taskStatus: String(task.status) };
	}

	switch (input.status) {
		case 'succeeded':
			if (task.chat_question === true && !input.summary?.trim()) {
				await failAttempt(tx, fx, task, 'Der Agent hat keine Antwort geliefert');
				break;
			}
			await succeed(tx, fx, task, input, pr);
			break;
		case 'failed':
			await fail(tx, fx, task, run, input);
			break;
		case 'limited': {
			const known = await oneOf(
				tx,
				sql`SELECT 1 FROM limit_event WHERE run_id = ${run.id} AND resets_at IS NOT NULL LIMIT 1`
			);
			if (!known && run.account_id)
				await excludeAccount(tx, String(task.id), String(run.account_id));
			await tx.execute(
				sql`UPDATE task SET attempts = GREATEST(attempts - 1, 0) WHERE id = ${task.id}`
			);
			await transition(tx, fx, String(task.id), 'queued', {
				error: input.errorMessage ?? 'Limit des Anbieters erreicht – wird neu eingeplant'
			});
			break;
		}
		case 'cancelled':
			await tx.execute(
				sql`UPDATE task SET attempts = GREATEST(attempts - 1, 0) WHERE id = ${task.id}`
			);
			await transition(tx, fx, String(task.id), 'queued', {
				error: input.errorMessage ?? 'Lauf abgebrochen – wird neu eingeplant'
			});
			break;
	}
	const after = await getTask(tx, String(task.id));
	return { ok: true, taskStatus: after ? String(after.status) : null };
}

async function succeed(
	tx: Tx,
	fx: Effects,
	task: Row,
	input: FinishInput,
	pr: PullInfo | null
): Promise<void> {
	const summary = input.summary;
	if (task.role === 'orchestrate' && !planOf(task)) {
		let check = checkPlan(input.plan);
		if (!check.ok && summary) {
			const extracted = checkPlan(extractPlan(summary));
			if (extracted.ok || input.plan === undefined || input.plan === null) check = extracted;
		}
		if (!check.ok) {
			await failAttempt(tx, fx, task, check.error);
			return;
		}
		await applyPlan(tx, fx, task, check.plan, summary);
		return;
	}
	if (task.role === 'resolve' && task.parent_id) {
		const original = await getTask(tx, String(task.parent_id), true);
		await transition(tx, fx, String(task.id), 'done', { error: null, summary });
		if (original && original.status === 'blocked') {
			await tx.execute(
				sql`UPDATE task SET branch_pushed = ${input.branchPushed}, branch = COALESCE(${input.branch}, branch) WHERE id = ${original.id}`
			);
			await markDelivered(tx, original);
			await applyOutcome(tx, fx, original, { pr, summary: null });
		}
		return;
	}
	await tx.execute(
		sql`UPDATE task SET branch_pushed = ${input.branchPushed} WHERE id = ${task.id}`
	);
	await markDelivered(tx, task);
	await applyOutcome(tx, fx, task, { pr, summary });
}

/** Ausliefern einer Orchestrierung abgeschlossen */
async function markDelivered(tx: Tx, task: Row): Promise<void> {
	const plan = planOf(task);
	if (!plan || plan.delivered) return;
	const next: StoredPlan = { ...plan, delivered: true };
	await tx.execute(sql`UPDATE task SET plan = ${jsonb(next)} WHERE id = ${task.id}`);
}

/** Fehlversuch: weitere Versuche → `queued`, sonst `failed` */
async function failAttempt(tx: Tx, fx: Effects, task: Row, message: string): Promise<void> {
	const exhausted = num(task.attempts) >= num(task.max_attempts);
	await transition(tx, fx, String(task.id), exhausted ? 'failed' : 'queued', { error: message });
}

async function fail(tx: Tx, fx: Effects, task: Row, run: Row, input: FinishInput): Promise<void> {
	const message =
		input.errorMessage ?? `Lauf fehlgeschlagen${input.errorKind ? ` (${input.errorKind})` : ''}`;
	const writes = !(task.role === 'orchestrate' && !planOf(task));
	if (input.errorKind === 'conflict' && task.role !== 'resolve' && writes) {
		const branch = input.branch ?? str(task.branch) ?? str(run.branch);
		if (branch && !task.branch) {
			await tx.execute(sql`UPDATE task SET branch = ${branch} WHERE id = ${task.id}`);
		}
		await createResolveTask(
			tx,
			fx,
			{ ...task, branch: branch ?? task.branch },
			input.conflictFiles,
			branch
		);
		await transition(tx, fx, String(task.id), 'blocked', {
			error: 'Konflikt beim Zusammenführen – Konfliktlösung ist eingeplant'
		});
		return;
	}
	if ((input.errorKind === 'auth' || input.errorKind === 'limit') && run.account_id) {
		await excludeAccount(tx, String(task.id), String(run.account_id));
	}
	await failAttempt(tx, fx, task, message);
}
