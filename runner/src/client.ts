/**
 * Verbindung zu Atrium: JSON-Anfragen mit Wiederholung (Netzfehler, 5xx, 429 mit `retry-after`), SSE-Befehlsstrom
 * mit automatischem Neuverbinden und Ereignis-Batcher je Lauf.
 */
import { randomBytes } from 'node:crypto';
import { backoffMs, errorMessage, sleep } from './util/async.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import type { Redactor } from './redact.ts';
import { SseParser } from './sse.ts';
import {
	MAX_EVENT_TEXT,
	MAX_EVENTS_PER_BATCH,
	runnerCommandSchema,
	runOfferSchema,
	type FinishInput,
	type HeartbeatInput,
	type HeartbeatResult,
	type LimitInput,
	type RegisterInput,
	type RegisterResult,
	type RpcResponseInput,
	type RunEvent,
	type RunEventKind,
	type RunnerCommand,
	type UsageInput,
	heartbeatResult,
	registerResult
} from './protocol.ts';
import { RUNNER_VERSION } from './version.ts';

/** Fehlerantwort von Atrium (`{ error: { code, message } }`) */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
	/** Endgültiger Fehler (keine Wiederholung sinnvoll) */
	get permanent(): boolean {
		return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
	}
}

export interface RequestOptions {
	/** Höchstzahl der Versuche (Standard 5) */
	attempts?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type FetchFn = typeof fetch;

export interface ClientOptions {
	atriumUrl: string;
	apiKey: string;
	fetch?: FetchFn;
	log?: Logger;
	/** Basis für Backoff (Tests verkürzen) */
	backoffBaseMs?: number;
}

function parseRetryAfter(v: string | null): number | null {
	if (!v) return null;
	if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.min(300_000, Number(v) * 1000);
	const t = Date.parse(v);
	if (!Number.isNaN(t)) return Math.max(0, Math.min(300_000, t - Date.now()));
	return null;
}

export class AtriumClient {
	readonly base: string;
	private readonly fetchFn: FetchFn;
	private readonly log: Logger;
	readonly backoffBaseMs: number;
	/** Kennung dieses Prozesses für den SSE-Strom (bleibt bei Reconnects gleich) */
	readonly clientId = randomBytes(12).toString('hex');

	constructor(private readonly o: ClientOptions) {
		this.base = `${o.atriumUrl.replace(/\/+$/, '')}/api/v1/modules/aidev`;
		this.fetchFn = o.fetch ?? fetch;
		this.log = o.log ?? silentLogger;
		this.backoffBaseMs = o.backoffBaseMs ?? 500;
	}

	private headers(json: boolean): Record<string, string> {
		const h: Record<string, string> = {
			authorization: `Bearer ${this.o.apiKey}`,
			accept: 'application/json',
			'user-agent': `atrium-aidev-runner/${RUNNER_VERSION}`
		};
		if (json) h['content-type'] = 'application/json';
		return h;
	}

	/** JSON-Anfrage; liefert `data` der Antwort */
	async request<T = unknown>(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
		opts: RequestOptions = {}
	): Promise<T> {
		const attempts = opts.attempts ?? 5;
		let lastErr: unknown;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (opts.signal?.aborted) throw new Error('Abgebrochen');
			let waitMs = backoffMs(attempt, this.backoffBaseMs);
			try {
				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
				const onAbort = () => ctrl.abort();
				opts.signal?.addEventListener('abort', onAbort, { once: true });
				let res: Response;
				try {
					res = await this.fetchFn(this.base + path, {
						method,
						headers: this.headers(body !== undefined),
						body: body !== undefined ? JSON.stringify(body) : undefined,
						signal: ctrl.signal
					});
				} finally {
					clearTimeout(timer);
					opts.signal?.removeEventListener('abort', onAbort);
				}
				const text = await res.text();
				let json: unknown = null;
				if (text) {
					try {
						json = JSON.parse(text);
					} catch {
						json = null;
					}
				}
				if (res.ok) {
					return (json && typeof json === 'object' && 'data' in json
						? (json as { data: unknown }).data
						: json) as T;
				}
				const errObj =
					json && typeof json === 'object' && 'error' in json
						? ((json as { error: { code?: string; message?: string } }).error ?? {})
						: {};
				const err = new ApiError(
					res.status,
					errObj.code ?? `http_${res.status}`,
					errObj.message ?? (text.slice(0, 300) || res.statusText || `HTTP ${res.status}`)
				);
				if (err.permanent) throw err;
				lastErr = err;
				if (res.status === 429) {
					waitMs = parseRetryAfter(res.headers.get('retry-after')) ?? Math.max(waitMs, 2000);
				}
			} catch (e) {
				if (e instanceof ApiError && e.permanent) throw e;
				lastErr = e;
			}
			if (attempt < attempts - 1) {
				this.log.debug(`${method} ${path} fehlgeschlagen, neuer Versuch in ${waitMs} ms`, errorMessage(lastErr));
				await sleep(waitMs, opts.signal);
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	}

	/** Offener SSE-Strom (`GET /runner/stream`) als Byte-Leser */
	async openStream(signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
		const res = await this.fetchFn(`${this.base}/runner/stream?client=${this.clientId}`, {
			method: 'GET',
			headers: { ...this.headers(false), accept: 'text/event-stream', 'cache-control': 'no-cache' },
			signal
		});
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			let message = text.slice(0, 300) || `HTTP ${res.status}`;
			try {
				const j = JSON.parse(text) as { error?: { message?: string } };
				if (j.error?.message) message = j.error.message;
			} catch {
				// kein JSON
			}
			throw Object.assign(new ApiError(res.status, `http_${res.status}`, message), {
				retryAfterMs: parseRetryAfter(res.headers.get('retry-after'))
			});
		}
		return res.body.getReader();
	}
}

/** Typisierte Endpunkte des Runner-Protokolls */
export class RunnerApi {
	constructor(readonly client: AtriumClient) {}

	async register(input: RegisterInput, signal?: AbortSignal): Promise<RegisterResult> {
		const data = await this.client.request('POST', '/runner/register', input, { signal, attempts: 3 });
		return registerResult.parse(data);
	}
	async heartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
		const data = await this.client.request('POST', '/runner/heartbeat', input, { attempts: 2 });
		return heartbeatResult.parse(data);
	}
	/** Verpasste Befehle (Angebote) nach einem Neuverbinden */
	async pending(): Promise<RunnerCommand[]> {
		const data = await this.client.request('GET', '/runner/pending', undefined, { attempts: 3 });
		return parsePending(data);
	}
	accept(runId: string): Promise<unknown> {
		return this.client.request('POST', `/runner/runs/${runId}/accept`, {}, { attempts: 4 });
	}
	reject(runId: string, reason: string): Promise<unknown> {
		return this.client.request('POST', `/runner/runs/${runId}/reject`, { reason: reason.slice(0, 500) }, { attempts: 4 });
	}
	events(runId: string, events: RunEvent[]): Promise<unknown> {
		return this.client.request('POST', `/runner/runs/${runId}/events`, { events }, { attempts: 3 });
	}
	usage(runId: string, usage: UsageInput): Promise<unknown> {
		return this.client.request('POST', `/runner/runs/${runId}/usage`, usage, { attempts: 6 });
	}
	limit(runId: string, limit: LimitInput): Promise<unknown> {
		return this.client.request('POST', `/runner/runs/${runId}/limit`, limit, { attempts: 6 });
	}
	finish(runId: string, input: FinishInput): Promise<unknown> {
		return this.client.request('POST', `/runner/runs/${runId}/finish`, input, { attempts: 12 });
	}
	rpc(reqId: string, input: RpcResponseInput): Promise<unknown> {
		return this.client.request('POST', `/runner/rpc/${reqId}`, input, { attempts: 3 });
	}
	ptyOutput(sid: string, seq: number, data: string): Promise<unknown> {
		return this.client.request('POST', `/runner/pty/${sid}/output`, { seq, data }, { attempts: 3 });
	}
	ptyExit(sid: string, code: number | null): Promise<unknown> {
		return this.client.request('POST', `/runner/pty/${sid}/exit`, { code }, { attempts: 3 });
	}
}

/**
 * Antwort von `/runner/pending` tolerant lesen: Liste von Befehlen bzw. Angeboten oder Objekt mit
 * `commands`/`offers`. Ungültige Einträge werden übersprungen.
 */
export function parsePending(data: unknown): RunnerCommand[] {
	let items: unknown[] = [];
	if (Array.isArray(data)) items = data;
	else if (data && typeof data === 'object') {
		const o = data as Record<string, unknown>;
		if (Array.isArray(o.commands)) items.push(...o.commands);
		if (Array.isArray(o.offers)) items.push(...o.offers);
	}
	const out: RunnerCommand[] = [];
	for (const item of items) {
		if (item && typeof item === 'object' && 'type' in item) {
			const r = runnerCommandSchema.safeParse(item);
			if (r.success) out.push(r.data);
		} else {
			const r = runOfferSchema.safeParse(item);
			if (r.success) out.push({ type: 'offer', offer: r.data });
		}
	}
	return out;
}

// ---------------------------------------------------------------- SSE-Befehlsstrom

export interface StreamHandlers {
	onCommand(cmd: RunnerCommand): void;
	/** Nach jedem erfolgreichen (Neu-)Verbinden – z. B. `/runner/pending` abholen */
	onConnected?(): void | Promise<void>;
	/** Endgültiger Fehler (z. B. 401): Strom wird erst nach `fatalDelayMs` neu versucht */
	onAuthError?(err: ApiError): void;
}

export interface StreamOptions {
	/** Ohne Daten (auch ohne `: ping`) gilt die Verbindung nach dieser Zeit als tot */
	idleTimeoutMs?: number;
	log?: Logger;
}

/**
 * Hält den SSE-Strom offen, bis `signal` abbricht. Neuverbinden mit Backoff (bzw. `retry:` des Servers).
 * `reconnect()` des Rückgabewerts erzwingt ein sofortiges Neuverbinden (z. B. nach `revoked`).
 */
export function runCommandStream(
	client: AtriumClient,
	handlers: StreamHandlers,
	signal: AbortSignal,
	o: StreamOptions = {}
): { done: Promise<void>; reconnect(): void } {
	const log = o.log ?? silentLogger;
	const idleTimeoutMs = o.idleTimeoutMs ?? 90_000;
	let current: AbortController | null = null;
	let forced = false;

	const done = (async () => {
		let attempt = 0;
		let serverRetry: number | null = null;
		while (!signal.aborted) {
			const ctrl = new AbortController();
			current = ctrl;
			const onAbort = () => ctrl.abort();
			signal.addEventListener('abort', onAbort, { once: true });
			let idle: NodeJS.Timeout | undefined;
			const touch = () => {
				if (idle) clearTimeout(idle);
				idle = setTimeout(() => ctrl.abort(), idleTimeoutMs);
			};
			let wait: number | null = null;
			try {
				touch();
				const reader = await client.openStream(ctrl.signal);
				attempt = 0;
				log.info('Befehlsstrom verbunden');
				touch();
				void Promise.resolve(handlers.onConnected?.()).catch((e: unknown) =>
					log.warn('Nachholen ausstehender Befehle fehlgeschlagen', errorMessage(e))
				);
				const parser = new SseParser();
				for (;;) {
					const { value, done: end } = await reader.read();
					if (end) break;
					touch();
					for (const msg of parser.push(value)) {
						if (msg.event !== 'message' && msg.event !== 'command') continue;
						let json: unknown;
						try {
							json = JSON.parse(msg.data);
						} catch {
							log.warn('Ungültige SSE-Nachricht (kein JSON) verworfen');
							continue;
						}
						const cmd = runnerCommandSchema.safeParse(json);
						if (!cmd.success) {
							log.warn('Unbekannter oder ungültiger Befehl verworfen', cmd.error.issues[0]?.message);
							continue;
						}
						try {
							handlers.onCommand(cmd.data);
						} catch (e) {
							log.error('Fehler beim Verarbeiten eines Befehls', errorMessage(e));
						}
					}
					if (parser.retryMs !== null) serverRetry = parser.retryMs;
				}
				reader.releaseLock();
				if (!signal.aborted && !forced) log.warn('Befehlsstrom vom Server beendet');
			} catch (e) {
				if (signal.aborted) break;
				if (e instanceof ApiError) {
					if (e.status === 401 || e.status === 403) {
						handlers.onAuthError?.(e);
						wait = 60_000;
					} else {
						const ra = (e as ApiError & { retryAfterMs?: number | null }).retryAfterMs;
						if (ra) wait = ra;
					}
				}
				if (!forced) log.warn('Befehlsstrom unterbrochen', errorMessage(e));
			} finally {
				if (idle) clearTimeout(idle);
				signal.removeEventListener('abort', onAbort);
				ctrl.abort();
			}
			if (signal.aborted) break;
			if (forced) {
				forced = false;
				continue;
			}
			const delay = wait ?? Math.max(serverRetry ?? 0, backoffMs(attempt++, 1000, 30_000));
			await sleep(delay, signal);
		}
	})();

	return {
		done,
		reconnect() {
			forced = true;
			current?.abort();
		}
	};
}

// ---------------------------------------------------------------- Ereignis-Batcher

/** Grenzen eines Batches: 100 Ereignisse bzw. ≤ 512 KB JSON */
export const BATCH_MAX_EVENTS = Math.min(100, MAX_EVENTS_PER_BATCH);
export const BATCH_MAX_BYTES = 512 * 1024;
const FLUSH_MS = 250;
/** Größte Nutzlast eines Ereignisses (JSON) – größere Werte werden zu Text gekürzt */
const MAX_PAYLOAD_BYTES = 64 * 1024;

export function truncateText(s: string, max = MAX_EVENT_TEXT): string {
	if (s.length <= max) return s;
	const suffix = ' …[gekürzt]';
	return s.slice(0, max - suffix.length) + suffix;
}

function truncateDeep(v: unknown, depth = 0): unknown {
	if (typeof v === 'string') return truncateText(v);
	if (depth > 20 || v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.slice(0, 500).map((x) => truncateDeep(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) out[k] = truncateDeep(x, depth + 1);
	return out;
}

/** Nutzlast kürzen: lange Texte auf `MAX_EVENT_TEXT`, insgesamt ≤ 64 KB */
export function limitPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const p = truncateDeep(payload) as Record<string, unknown>;
	const json = JSON.stringify(p);
	if (Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES) return p;
	const out: Record<string, unknown> = { truncated: true };
	if (typeof p.name === 'string') out.name = p.name;
	out.text = truncateText(json, Math.min(MAX_EVENT_TEXT, 16_000));
	return out;
}

export interface BatcherOptions {
	runId: string;
	api: RunnerApi;
	redactor: Redactor;
	log?: Logger;
	flushMs?: number;
	retryBaseMs?: number;
}

/**
 * Sammelt Ereignisse eines Laufs und sendet sie in Batches (alle 250 ms oder ab 100 Ereignissen/512 KB).
 * `seq` ist fortlaufend ab 0; fehlgeschlagene Batches werden erneut gesendet (Atrium ist über `seq` idempotent).
 */
export class EventBatcher {
	private seq = 0;
	private queue: { event: RunEvent; bytes: number }[] = [];
	private queuedBytes = 0;
	private timer: NodeJS.Timeout | null = null;
	private sending: Promise<void> | null = null;
	private closed = false;
	private failures = 0;
	private readonly log: Logger;
	/** Anzahl verworfener Ereignisse (endgültige Fehler) */
	dropped = 0;

	constructor(private readonly o: BatcherOptions) {
		this.log = o.log ?? silentLogger;
	}

	get nextSeq(): number {
		return this.seq;
	}

	push(kind: RunEventKind, payload: Record<string, unknown>): void {
		if (this.closed) return;
		const event: RunEvent = {
			seq: this.seq++,
			ts: new Date().toISOString(),
			kind,
			payload: limitPayload(this.o.redactor.redactDeep(payload))
		};
		const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
		this.queue.push({ event, bytes });
		this.queuedBytes += bytes;
		if (this.queue.length >= BATCH_MAX_EVENTS || this.queuedBytes >= BATCH_MAX_BYTES) this.kick(0);
		else this.kick(this.o.flushMs ?? FLUSH_MS);
	}

	private kick(delay: number): void {
		if (this.sending) return;
		if (this.timer) {
			if (delay > 0) return;
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.sendLoop();
		}, delay);
	}

	private sendLoop(): Promise<void> {
		if (this.sending) return this.sending;
		this.sending = (async () => {
			try {
				while (this.queue.length) {
					const batch: RunEvent[] = [];
					let bytes = 0;
					for (const item of this.queue) {
						if (batch.length >= BATCH_MAX_EVENTS) break;
						if (batch.length > 0 && bytes + item.bytes > BATCH_MAX_BYTES) break;
						batch.push(item.event);
						bytes += item.bytes;
					}
					try {
						await this.o.api.events(this.o.runId, batch);
						this.failures = 0;
					} catch (e) {
						if (e instanceof ApiError && e.permanent) {
							this.dropped += batch.length;
							this.log.warn(`Ereignisse verworfen (${e.status})`, e.message);
						} else {
							this.failures++;
							if (this.closed && this.failures >= 5) {
								this.dropped += this.queue.length;
								this.log.warn('Ereignisse nach mehreren Fehlversuchen verworfen', errorMessage(e));
								this.queue = [];
								this.queuedBytes = 0;
								return;
							}
							await sleep(backoffMs(this.failures, this.o.retryBaseMs ?? 500, 15_000));
							continue;
						}
					}
					this.queue.splice(0, batch.length);
					this.queuedBytes -= bytes;
				}
			} finally {
				this.sending = null;
			}
		})();
		return this.sending;
	}

	/** Alles Ausstehende senden (vor `finish`) */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		while (this.queue.length || this.sending) {
			await this.sendLoop();
		}
	}

	/** Keine weiteren Ereignisse annehmen, Rest senden */
	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
	}
}
