/**
 * Mini-Atrium für Tests (node:http): SSE-Strom `/runner/stream`, alle Runner-Endpunkte, Aufzeichnung aller
 * Anfragen (Pfad + Body). Bodies werden gegen die Schemas aus `protocol.ts` geprüft.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	checkpointInput,
	eventsInput,
	finishInput,
	heartbeatInput,
	leasesInput,
	limitInput,
	ptyExitInput,
	ptyOutputInput,
	registerInput,
	rejectInput,
	rpcResponseInput,
	usageInput,
	type RunnerCommand
} from '../../src/protocol.ts';

export interface Recorded {
	method: string;
	path: string;
	body: unknown;
	/** Schema-Fehler (sollte leer sein) */
	invalid?: string;
}

const PREFIX = '/api/v1/modules/aidev';
export const RUNNER_ID = '99999999-9999-4999-8999-999999999999';

export class FakeAtrium {
	readonly requests: Recorded[] = [];
	private server: http.Server;
	private streams = new Set<http.ServerResponse>();
	url = '';
	apiKey = 'test-api-key-123456';
	/** Antwort für /runner/pending */
	pending: unknown[] = [];
	/** Läufe, die per Heartbeat abgebrochen werden sollen */
	cancel: string[] = [];
	/** Nächste Antworten für events (Fehler simulieren) */
	failEvents = 0;
	/** Anhänge für `GET /runner/runs/:id/attachments/:attachmentId` (binär); fehlende → 404 */
	attachments = new Map<string, Buffer>();
	/** Nächste Antworten für Anhänge mit 503 (Wiederholung prüfen) */
	failAttachments = 0;
	/** `registerResult.features` (Standard: keine Erweiterung – wie ein älteres Atrium) */
	features: Record<string, boolean> | undefined = undefined;
	/** `registerResult.leaseSec` */
	leaseSec: number | undefined = undefined;
	/** Läufe mit ungültiger Lease (`/runner/leases` → revoked) */
	revoked = new Set<string>();
	/** Läufe, deren Meldungen (events/finish/checkpoint) mit 409 abgelehnt werden */
	conflict = new Set<string>();
	private waiters: { pred: (r: Recorded) => boolean; resolve: (r: Recorded) => void }[] = [];

	constructor() {
		this.server = http.createServer((req, res) => void this.handle(req, res));
	}

	async start(): Promise<void> {
		await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		for (const s of this.streams) s.destroy();
		this.server.closeAllConnections?.();
		await new Promise<void>((r) => this.server.close(() => r()));
	}

	/** Befehl an alle verbundenen Runner senden */
	send(cmd: RunnerCommand): void {
		const data = JSON.stringify(cmd);
		for (const s of this.streams) s.write(`data: ${data}\n\n`);
	}

	get connected(): number {
		return this.streams.size;
	}

	/** Wartet auf eine (auch bereits erfolgte) Anfrage */
	waitFor(pred: (r: Recorded) => boolean, timeoutMs = 60_000): Promise<Recorded> {
		const found = this.requests.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('Zeitüberschreitung beim Warten auf Anfrage')), timeoutMs);
			this.waiters.push({
				pred,
				resolve: (r) => {
					clearTimeout(t);
					resolve(r);
				}
			});
		});
	}

	byPath(re: RegExp): Recorded[] {
		return this.requests.filter((r) => re.test(r.path));
	}

	private record(r: Recorded): void {
		this.requests.push(r);
		for (const w of [...this.waiters]) {
			if (w.pred(r)) {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				w.resolve(r);
			}
		}
	}

	private json(res: http.ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://x');
		if (req.headers.authorization !== `Bearer ${this.apiKey}`)
			return this.json(res, 401, { error: { code: 'unauthorized', message: 'API-Key ungültig' } });
		if (!url.pathname.startsWith(PREFIX)) return this.json(res, 404, { error: { code: 'not_found', message: '?' } });
		const p = url.pathname.slice(PREFIX.length);

		if (req.method === 'GET' && p === '/runner/stream') {
			if (!/^[A-Za-z0-9_-]{8,64}$/.test(url.searchParams.get('client') ?? '')) return this.json(res, 400, { error: { code: 'client', message: 'client fehlt' } });
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
			res.write('retry: 500\n: ping\n\n');
			this.streams.add(res);
			res.write(`data: ${JSON.stringify({ type: 'hello', runnerId: RUNNER_ID, status: 'approved' })}\n\n`);
			req.on('close', () => this.streams.delete(res));
			this.record({ method: 'GET', path: p, body: null });
			return;
		}

		const att = /^\/runner\/runs\/([0-9a-f-]+)\/attachments\/([0-9a-f-]+)$/.exec(p);
		if (req.method === 'GET' && att) {
			this.record({ method: 'GET', path: p, body: null });
			if (this.failAttachments > 0) {
				this.failAttachments--;
				return this.json(res, 503, { error: { code: 'unavailable', message: 'kurz weg' } });
			}
			const bytes = this.attachments.get(att[2] ?? '');
			if (!bytes) return this.json(res, 404, { error: { code: 'not_found', message: 'Anhang nicht gefunden' } });
			res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
			res.end(bytes);
			return;
		}

		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const raw = Buffer.concat(chunks).toString('utf8');
		let body: unknown = null;
		if (raw) {
			try {
				body = JSON.parse(raw);
			} catch {
				return this.json(res, 400, { error: { code: 'bad_json', message: 'Kein JSON' } });
			}
		}
		if (req.headers['content-type'] !== 'application/json' && req.method === 'POST')
			return this.json(res, 415, { error: { code: 'content_type', message: 'JSON erwartet' } });

		const check = (schema: { safeParse(v: unknown): { success: boolean; error?: { message: string } } }) => {
			const r = schema.safeParse(body);
			return r.success ? undefined : (r.error?.message ?? 'ungültig');
		};
		let invalid: string | undefined;
		let data: unknown = {};
		if (p === '/runner/register') {
			invalid = check(registerInput);
			data = {
				runnerId: RUNNER_ID,
				status: 'approved',
				heartbeatSec: 1,
				...(this.features ? { features: this.features } : {}),
				...(this.leaseSec ? { leaseSec: this.leaseSec } : {})
			};
		} else if (p === '/runner/leases') {
			invalid = check(leasesInput);
			const runs = ((body as { runs?: { runId: string }[] })?.runs ?? []).map((r) => r.runId);
			data = {
				valid: runs.filter((id) => !this.revoked.has(id)),
				revoked: runs.filter((id) => this.revoked.has(id)).map((runId) => ({ runId, reason: 'Lauf wurde übernommen' }))
			};
		} else if (/\/checkpoint$/.test(p)) {
			invalid = check(checkpointInput);
		} else if (p === '/runner/heartbeat') {
			invalid = check(heartbeatInput);
			data = { status: 'approved', cancel: this.cancel.splice(0) };
		} else if (p === '/runner/pending') {
			data = this.pending.splice(0);
		} else if (/^\/runner\/runs\/[0-9a-f-]+\/accept$/.test(p)) {
			data = { ok: true };
		} else if (/\/reject$/.test(p)) invalid = check(rejectInput);
		else if (/\/events$/.test(p)) {
			invalid = check(eventsInput);
			if (this.failEvents > 0) {
				this.failEvents--;
				this.record({ method: req.method ?? '', path: p, body, invalid: 'simulierter Fehler' });
				return this.json(res, 503, { error: { code: 'unavailable', message: 'kurz weg' } });
			}
		} else if (/\/usage$/.test(p)) invalid = check(usageInput);
		else if (/\/limit$/.test(p)) invalid = check(limitInput);
		else if (/\/finish$/.test(p)) {
			const r = finishInput.safeParse(body);
			invalid = r.success ? undefined : r.error.message;
		} else if (/^\/runner\/rpc\//.test(p)) invalid = check(rpcResponseInput);
		else if (/^\/runner\/pty\/[^/]+\/output$/.test(p)) invalid = check(ptyOutputInput);
		else if (/^\/runner\/pty\/[^/]+\/exit$/.test(p)) invalid = check(ptyExitInput);
		else return this.json(res, 404, { error: { code: 'not_found', message: `Unbekannt: ${p}` } });

		const runId = /^\/runner\/runs\/([0-9a-f-]+)\//.exec(p)?.[1];
		if (runId && this.conflict.has(runId) && /\/(events|finish|checkpoint)$/.test(p)) {
			this.record({ method: req.method ?? '', path: p, body, invalid: '409' });
			return this.json(res, 409, { error: { code: 'conflict', message: 'Lauf wurde übernommen' } });
		}
		this.record({ method: req.method ?? '', path: p, body, invalid });
		if (invalid) return this.json(res, 400, { error: { code: 'invalid', message: invalid } });
		this.json(res, 200, { data });
	}
}
