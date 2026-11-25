/**
 * Runner: Identität (API-Key ↔ `runner.api_key_id`), Registrierung, Heartbeat, Verbindungsstatus und die
 * Verwaltungsaktionen (freigeben, sperren, entfernen).
 */
import { sql } from 'drizzle-orm';
import { errors, inList, rowsOf, str, type RequestContext } from '$lib/sdk/server';
import { jsonb, LEASE_SEC, mdb, oneOf, type Row, type Tx } from './db';
import { newEffects, sendCommand, type Effects } from './effects';
import {
	PROTOCOL_VERSION,
	type HeartbeatInput,
	type HeartbeatResult,
	type RegisterInput,
	type RegisterResult
} from './protocol';
import { publish } from './publish.service';
import { rejectAllRpc } from './rpc.service';
import { loseRun } from './runs.service';
import { storeLimitSnapshot } from './limits.service';
import { HEARTBEAT_SEC } from './db';

/** API-Key des aufrufenden Runners (nur technische Konten per API-Key) */
export function runnerKeyOf(ctx: RequestContext): string {
	if (ctx.actor.type !== 'api_key' || !ctx.actor.id) {
		throw errors.forbidden('Nur Runner mit API-Key dürfen diese Schnittstelle nutzen');
	}
	return ctx.actor.id;
}

/** Runner des Aufrufers; unbekannt → 404, gesperrt → 403 (außer `allowDisabled`) */
export async function requireRunner(
	tx: Tx,
	ctx: RequestContext,
	opts: { allowDisabled?: boolean; forUpdate?: boolean } = {}
): Promise<Row> {
	const key = runnerKeyOf(ctx);
	const runner = await oneOf(
		tx,
		opts.forUpdate
			? sql`SELECT * FROM runner WHERE api_key_id = ${key} FOR UPDATE`
			: sql`SELECT * FROM runner WHERE api_key_id = ${key}`
	);
	if (!runner) throw errors.notFound('Runner nicht registriert');
	if (runner.status === 'disabled' && !opts.allowDisabled) {
		throw errors.forbidden('Der Runner ist gesperrt');
	}
	return runner;
}

export async function registerRunner(
	tx: Tx,
	fx: Effects,
	ctx: RequestContext,
	input: RegisterInput
): Promise<RegisterResult> {
	if (input.protocol < 1 || input.protocol > PROTOCOL_VERSION) {
		throw errors.badRequest(
			`Protokollversion ${input.protocol} wird nicht unterstützt (Server: ${PROTOCOL_VERSION})`
		);
	}
	const key = runnerKeyOf(ctx);
	let runner = await oneOf(tx, sql`SELECT * FROM runner WHERE api_key_id = ${key} FOR UPDATE`);
	if (!runner) {
		const id = crypto.randomUUID();
		runner = await oneOf(
			tx,
			sql`INSERT INTO runner (id, name, api_key_id, status, version, capabilities, max_slots,
					reported_max_slots, last_seen_at)
				VALUES (${id}, ${input.name}, ${key}, 'pending', ${input.version}, ${jsonb(input.capabilities)},
					${input.maxSlots}, ${input.maxSlots}, now())
				ON CONFLICT (api_key_id) DO NOTHING
				RETURNING *`
		);
		if (!runner) throw errors.conflict('Runner wird gerade registriert – bitte erneut versuchen');
		fx.audits.push({
			action: 'aidev.runner.registered',
			target: id,
			metadata: { name: input.name, version: input.version, accounts: input.accounts.length }
		});
	} else {
		// geändertes MAX_SLOTS des Runners übernehmen; ein von der Verwaltung gesetzter Wert bleibt,
		// solange der Runner denselben Wert meldet (NULL: zuletzt vor Migration 0006 angemeldet)
		const reported = runner.reported_max_slots;
		const slotsChanged =
			reported === null || reported === undefined || Number(reported) !== input.maxSlots;
		runner = await oneOf(
			tx,
			sql`UPDATE runner SET name = ${input.name}, version = ${input.version},
					capabilities = ${jsonb(input.capabilities)}, last_seen_at = now(), draining = false,
					max_slots = ${slotsChanged ? input.maxSlots : Number(runner.max_slots)},
					reported_max_slots = ${input.maxSlots}
				WHERE id = ${runner.id} RETURNING *`
		);
	}
	const runnerId = String(runner!.id);
	const keys = input.accounts.map((a) => a.key);
	for (const a of input.accounts) {
		await tx.execute(
			sql`INSERT INTO provider_account (id, runner_id, key, provider, label, logged_in, models)
				VALUES (${crypto.randomUUID()}, ${runnerId}, ${a.key}, ${a.provider}, ${a.label},
					${a.loggedIn}, ${jsonb(a.models)})
				ON CONFLICT (runner_id, key) DO UPDATE SET provider = EXCLUDED.provider,
					label = EXCLUDED.label, logged_in = EXCLUDED.logged_in, models = EXCLUDED.models`
		);
	}
	// nicht mehr gemeldete Konten bleiben (Einstellungen, Verbrauch), gelten aber als abgemeldet
	await tx.execute(
		keys.length
			? sql`UPDATE provider_account SET logged_in = false
				WHERE runner_id = ${runnerId} AND key NOT IN (${inList(keys)})`
			: sql`UPDATE provider_account SET logged_in = false WHERE runner_id = ${runnerId}`
	);
	if (input.runIds) await releaseOrphanedRuns(tx, fx, runnerId, input.runIds);
	fx.overview = true;
	fx.dispatch = true;
	return {
		runnerId,
		status: String(runner!.status) as RegisterResult['status'],
		heartbeatSec: HEARTBEAT_SEC
	};
}

/**
 * Anmeldung mit `runIds`: laufende Läufe dieses Runners, die er nicht mehr ausführt (Neustart, Absturz), sofort
 * als `lost` freigeben, statt bis zum Ende der Lease zu warten. Der Versuch zählt wie beim Lease-Ablauf (ein
 * Auftrag, der den Runner wiederholt abstürzen lässt, endet so nach `max_attempts`); ein geordnetes Beenden meldet
 * seine Läufe vorher selbst als `cancelled`. Angebotene Läufe holt der Runner nach der Anmeldung erneut ab.
 */
async function releaseOrphanedRuns(
	tx: Tx,
	fx: Effects,
	runnerId: string,
	active: string[]
): Promise<number> {
	const runs = await rowsOf(
		tx,
		active.length
			? sql`SELECT * FROM run WHERE runner_id = ${runnerId} AND status = 'running'
					AND id NOT IN (${inList(active)}) ORDER BY created_at FOR UPDATE`
			: sql`SELECT * FROM run WHERE runner_id = ${runnerId} AND status = 'running'
					ORDER BY created_at FOR UPDATE`
	);
	for (const run of runs) {
		await loseRun(tx, fx, run, 'Runner wurde neu gestartet – Lauf wird neu eingeplant', true);
	}
	return runs.length;
}

export async function heartbeat(
	tx: Tx,
	fx: Effects,
	ctx: RequestContext,
	input: HeartbeatInput
): Promise<HeartbeatResult> {
	const runner = await requireRunner(tx, ctx, { allowDisabled: true, forUpdate: true });
	const status = String(runner.status) as HeartbeatResult['status'];
	const runnerId = String(runner.id);
	await tx.execute(
		sql`UPDATE runner SET last_seen_at = now(), online = ${status !== 'disabled'},
				slots_used = ${input.slotsUsed}, draining = ${input.draining === true}
			WHERE id = ${runnerId}`
	);
	for (const a of input.accounts) {
		const account = await oneOf(
			tx,
			sql`UPDATE provider_account SET logged_in = ${a.loggedIn}
				WHERE runner_id = ${runnerId} AND key = ${a.key}
				RETURNING id`
		);
		// Limit-Stand nur von Runnern, die ihn melden (ältere Runner: Feld fehlt → nichts ändern)
		if (account && a.limits) await storeLimitSnapshot(tx, String(account.id), a.limits);
	}
	const reported = [...new Set(input.runIds)];
	let keep = new Set<string>();
	if (reported.length && status !== 'disabled') {
		const rows = await rowsOf(
			tx,
			sql`UPDATE run r SET lease_expires_at = now() + ${LEASE_SEC}::int * interval '1 second'
				FROM task t
				WHERE r.task_id = t.id AND r.id IN (${inList(reported)}) AND r.runner_id = ${runnerId}
					AND r.status = 'running' AND t.status NOT IN ('cancelled', 'done', 'failed')
				RETURNING r.id`
		);
		keep = new Set(rows.map((r) => String(r.id)));
		// angebotene, aber schon gestartete Läufe (Annahme unterwegs) nicht abbrechen
		const offered = await rowsOf(
			tx,
			sql`SELECT id FROM run WHERE id IN (${inList(reported)}) AND runner_id = ${runnerId}
				AND status = 'offered'`
		);
		for (const r of offered) keep.add(String(r.id));
	}
	fx.overview = true;
	fx.dispatch = true;
	return { status, cancel: reported.filter((id) => !keep.has(id)) };
}

/** SSE-Verbindung steht: Runner online */
export async function runnerOnline(runnerId: string): Promise<void> {
	await mdb().transaction((tx) =>
		tx.execute(sql`UPDATE runner SET online = true, last_seen_at = now() WHERE id = ${runnerId}`)
	);
	const fx = newEffects();
	fx.overview = true;
	fx.dispatch = true;
	await publish(null, fx);
}

/** Letzte SSE-Verbindung beendet: offline, wartende RPCs abbrechen */
export async function runnerDisconnected(runnerId: string): Promise<void> {
	rejectAllRpc(runnerId);
	await mdb().transaction((tx) =>
		tx.execute(sql`UPDATE runner SET online = false WHERE id = ${runnerId}`)
	);
	const fx = newEffects();
	fx.overview = true;
	fx.dispatch = true;
	await publish(null, fx);
}

/**
 * Aktive Läufe eines Runners beenden (gesperrt/entfernt): angebotene und laufende → `lost` ohne Zählung des
 * Versuchs (der Runner bekommt `cancel`), die Aufträge werden neu eingeplant.
 */
export async function releaseRunnerRuns(tx: Tx, fx: Effects, runnerId: string, reason: string) {
	const runs = await rowsOf(
		tx,
		sql`SELECT * FROM run WHERE runner_id = ${runnerId} AND status IN ('offered', 'running') FOR UPDATE`
	);
	for (const run of runs) await loseRun(tx, fx, run, reason, false);
	return runs.length;
}

export interface RunnerPatchResult {
	changedStatus: 'approved' | 'disabled' | null;
}

export async function patchRunner(
	tx: Tx,
	fx: Effects,
	id: string,
	patch: { name?: string; status?: 'approved' | 'disabled'; maxSlots?: number }
): Promise<RunnerPatchResult> {
	const runner = await oneOf(tx, sql`SELECT * FROM runner WHERE id = ${id} FOR UPDATE`);
	if (!runner) throw errors.notFound('Runner nicht gefunden');
	await tx.execute(
		sql`UPDATE runner SET name = ${patch.name ?? String(runner.name)},
				status = ${patch.status ?? String(runner.status)},
				max_slots = ${patch.maxSlots ?? Number(runner.max_slots)}
			WHERE id = ${id}`
	);
	const changed = patch.status && patch.status !== runner.status ? patch.status : null;
	if (changed === 'disabled') {
		await releaseRunnerRuns(tx, fx, id, 'Runner wurde gesperrt');
		await tx.execute(sql`UPDATE runner SET online = false WHERE id = ${id}`);
	}
	if (changed === 'approved') {
		sendCommand(fx, id, { type: 'hello', runnerId: id, status: 'approved' });
	}
	if (changed) {
		fx.audits.push({
			action: changed === 'approved' ? 'aidev.runner.approved' : 'aidev.runner.disabled',
			target: id,
			metadata: { name: str(patch.name) ?? String(runner.name) }
		});
	}
	fx.overview = true;
	fx.dispatch = true;
	return { changedStatus: changed };
}

export async function deleteRunner(tx: Tx, fx: Effects, id: string): Promise<void> {
	const runner = await oneOf(tx, sql`SELECT * FROM runner WHERE id = ${id} FOR UPDATE`);
	if (!runner) throw errors.notFound('Runner nicht gefunden');
	await releaseRunnerRuns(tx, fx, id, 'Runner wurde entfernt');
	await tx.execute(
		sql`UPDATE workspace_session SET closed_at = now() WHERE runner_id = ${id} AND closed_at IS NULL`
	);
	await tx.execute(
		sql`UPDATE project SET preferred_runner_id = NULL WHERE preferred_runner_id = ${id}`
	);
	await tx.execute(sql`DELETE FROM runner WHERE id = ${id}`);
	fx.audits.push({
		action: 'aidev.runner.deleted',
		target: id,
		metadata: { name: String(runner.name) }
	});
	fx.overview = true;
	fx.dispatch = true;
}
