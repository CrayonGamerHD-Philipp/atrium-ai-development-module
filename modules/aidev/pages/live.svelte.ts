/**
 * Wiederverwendbarer SSE-Client (Muster `notes/pages/editor/sync.svelte.ts`): eigenes Wiederverbinden mit Backoff
 * (1–15 s), `client`-Kennung je Tab, Rückruf nach erneutem `hello`, damit die Seite Verpasstes nachladen kann.
 * Nur im Browser verwenden (in `onMount`/`$effect`).
 */
import { API_BASE } from './api';

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'closed';

/** Kennung je Verbindung (`^[A-Za-z0-9_-]{8,64}$`) */
export function randomClient(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
		return crypto.randomUUID().replace(/-/g, '');
	return `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`.slice(0, 32);
}

export interface LiveOptions<E> {
	/** Pfad relativ zu `/api/v1/modules/aidev`, z. B. `/projects/<id>/live` */
	path: string;
	/** `client`-Parameter anhängen (Endpunkte mit `liveQuery`) */
	withClient?: boolean;
	onEvent: (event: E) => void;
	/** Nach einem Wiederverbinden (zweites und jedes weitere `hello`): Verpasstes nachladen */
	onReconnect?: () => void;
	/** Server hat den Zugriff entzogen (`revoked`) – Verbindung bleibt zu */
	onRevoked?: () => void;
}

export class LiveStream<E extends { type: string }> {
	status = $state<LiveStatus>('connecting');
	readonly client = randomClient();

	private es: EventSource | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private delay = 1000;
	private closed = false;
	private helloCount = 0;

	constructor(private readonly opts: LiveOptions<E>) {}

	connect(): void {
		this.closed = false;
		this.open();
	}

	private url(): string {
		const base = `${API_BASE}${this.opts.path}`;
		if (!this.opts.withClient) return base;
		return `${base}${base.includes('?') ? '&' : '?'}client=${this.client}`;
	}

	private open(): void {
		if (this.closed) return;
		this.es?.close();
		if (this.status !== 'live') this.status = 'connecting';
		const es = new EventSource(this.url(), { withCredentials: true });
		this.es = es;
		es.onmessage = (msg) => {
			let event: E;
			try {
				event = JSON.parse(msg.data as string) as E;
			} catch {
				return;
			}
			if (event.type === 'hello') {
				this.status = 'live';
				this.delay = 1000;
				this.helloCount++;
				if (this.helloCount > 1) this.opts.onReconnect?.();
			}
			if (event.type === 'revoked') {
				this.close();
				this.opts.onRevoked?.();
				return;
			}
			this.opts.onEvent(event);
		};
		es.onerror = () => {
			// Der Browser würde selbst wiederverbinden – Abstand steuern wir selbst
			es.close();
			if (this.es !== es || this.closed) return;
			this.es = null;
			this.status = 'offline';
			if (this.timer) clearTimeout(this.timer);
			this.timer = setTimeout(() => this.open(), this.delay);
			this.delay = Math.min(this.delay * 2, 15_000);
		};
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.es?.close();
		this.es = null;
		this.status = 'closed';
	}
}
