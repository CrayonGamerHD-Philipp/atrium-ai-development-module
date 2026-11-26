/**
 * Lokaler HTTP-Server der PC-Oberfläche (`atrium-runner app`): liefert die Seite und eine kleine JSON-Schnittstelle
 * zum Steuern des Runners. Nur `127.0.0.1`, jede API-Anfrage braucht das Zugriffstoken (Kopf `X-Runner-Token`), und
 * der `Host`-Kopf muss auf die eigene Adresse zeigen (Schutz gegen DNS-Rebinding). Andere Webseiten können die
 * Schnittstelle so weder lesen noch aufrufen (eigener Kopf → Preflight, den der Server nie erlaubt).
 *
 * Die eigentliche Arbeit erledigt `AppOps` (siehe `ops.ts`) – hier nur Routing, Prüfungen und JSON.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { TOKEN_HEADER } from './instance.ts';

export { TOKEN_HEADER };
/** Höchstgröße eines Anfrage-Körpers (Konfiguration) */
const MAX_BODY = 256 * 1024;

export const APP_ACTIONS = [
	'start',
	'stop',
	'restart',
	'pause',
	'resume',
	'handover',
	'autostart-on',
	'autostart-off'
] as const;
export type AppAction = (typeof APP_ACTIONS)[number];

export interface ActionResult {
	ok: boolean;
	message: string;
}

export interface AppOps {
	state(): Promise<unknown>;
	action(name: AppAction): Promise<ActionResult>;
	logs(offset: number): Promise<{ offset: number; text: string; reset: boolean }>;
	readConfig(): Promise<{ path: string; exists: boolean; text: string }>;
	writeConfig(text: string): Promise<ActionResult>;
	probe(): Promise<{ ok: boolean; output: string }>;
	login(accountKey: string): Promise<ActionResult>;
	openPath(which: 'config' | 'logs' | 'work'): Promise<ActionResult>;
	quit(): void;
}

export interface AppServerOptions {
	ops: AppOps;
	token: string;
	page: string;
	/** Port (0 = frei wählen) */
	port?: number;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

function sameToken(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		const b = c as Buffer;
		size += b.length;
		if (size > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß');
		chunks.push(b);
	}
	if (!size) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new HttpError(400, 'Kein gültiges JSON');
	}
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Gültigkeit eines Einmal-Codes zum Öffnen des Fensters */
export const LAUNCH_CODE_MS = 60_000;

export class AppServer {
	private readonly server: http.Server;
	port = 0;
	/**
	 * Einmal-Codes für das Öffnen des Fensters: Die Adresse steht in der Kommandozeile des Browsers (für andere
	 * Benutzer sichtbar), deshalb nie das Token selbst, sondern ein Code, der beim ersten Tausch verfällt.
	 */
	private readonly codes = new Map<string, number>();

	constructor(private readonly o: AppServerOptions) {
		this.server = http.createServer((req, res) => void this.handle(req, res));
	}

	async listen(): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.o.port ?? 0, '127.0.0.1', () => resolve());
		});
		this.port = (this.server.address() as AddressInfo).port;
		return this.port;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}/`;
	}

	/** Adresse zum Öffnen des Fensters mit frischem Einmal-Code */
	launchUrl(now: number = Date.now()): string {
		for (const [c, exp] of this.codes) if (exp < now) this.codes.delete(c);
		const code = randomBytes(18).toString('base64url');
		this.codes.set(code, now + LAUNCH_CODE_MS);
		return `${this.url}#c=${code}`;
	}

	/** Einmal-Code gegen das Token tauschen (verbraucht den Code) */
	private redeem(code: string, now: number = Date.now()): string | null {
		const exp = this.codes.get(code);
		this.codes.delete(code);
		return exp !== undefined && exp >= now ? this.o.token : null;
	}

	async close(): Promise<void> {
		this.server.closeAllConnections?.();
		await new Promise<void>((r) => this.server.close(() => r()));
	}

	private hostOk(req: http.IncomingMessage): boolean {
		const host = (req.headers.host ?? '').toLowerCase();
		return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
	}

	private send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
		const data = type === 'application/json' ? JSON.stringify(body) : String(body);
		res.writeHead(status, {
			'content-type': `${type}; charset=utf-8`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			...(type === 'text/html'
				? {
						'content-security-policy':
							"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
						'x-frame-options': 'DENY'
					}
				: {})
		});
		res.end(data);
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			if (!this.hostOk(req)) throw new HttpError(421, 'Unbekannte Adresse');
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
				this.send(res, 200, this.o.page, 'text/html');
				return;
			}
			if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Nicht gefunden');
			if (req.method === 'POST' && url.pathname === '/api/session') {
				const body = (await readBody(req)) as { code?: unknown };
				const token = this.redeem(str(body.code) ?? '');
				if (!token) throw new HttpError(401, 'Code ungültig oder abgelaufen – Fenster erneut öffnen');
				this.send(res, 200, { token });
				return;
			}
			const token = str(req.headers[TOKEN_HEADER]) ?? '';
			if (!token || !sameToken(token, this.o.token)) throw new HttpError(401, 'Zugriffstoken fehlt oder ist falsch');
			this.send(res, 200, await this.route(req, url));
		} catch (e) {
			const status = e instanceof HttpError ? e.status : 500;
			const message = e instanceof Error ? e.message : String(e);
			if (!res.headersSent) this.send(res, status, { error: message });
			else res.end();
		}
	}

	private async route(req: http.IncomingMessage, url: URL): Promise<unknown> {
		const { ops } = this.o;
		const route = `${req.method} ${url.pathname}`;
		switch (route) {
			case 'GET /api/ping':
				return { ok: true };
			case 'POST /api/launch-url':
				// zweiter Aufruf von `atrium-runner app`: Fenster der laufenden Oberfläche öffnen
				return { url: this.launchUrl() };
			case 'GET /api/state':
				return ops.state();
			case 'GET /api/logs': {
				const offset = Number(url.searchParams.get('offset') ?? '-1');
				return ops.logs(Number.isFinite(offset) ? offset : -1);
			}
			case 'GET /api/config':
				return ops.readConfig();
			case 'PUT /api/config': {
				const body = (await readBody(req)) as { text?: unknown };
				const text = str(body.text);
				if (text === null) throw new HttpError(400, 'text fehlt');
				return ops.writeConfig(text);
			}
			case 'POST /api/probe':
				return ops.probe();
			case 'POST /api/login': {
				const body = (await readBody(req)) as { account?: unknown };
				const key = str(body.account);
				if (!key) throw new HttpError(400, 'account fehlt');
				return ops.login(key);
			}
			case 'POST /api/open': {
				const body = (await readBody(req)) as { which?: unknown };
				const which = str(body.which);
				if (which !== 'config' && which !== 'logs' && which !== 'work') throw new HttpError(400, 'which ungültig');
				return ops.openPath(which);
			}
			case 'POST /api/quit':
				setTimeout(() => ops.quit(), 100).unref();
				return { ok: true, message: 'Oberfläche wird beendet (der Runner läuft weiter)' };
		}
		const action = /^POST \/api\/action\/([a-z-]+)$/.exec(route)?.[1];
		if (action && (APP_ACTIONS as readonly string[]).includes(action)) return ops.action(action as AppAction);
		throw new HttpError(404, 'Nicht gefunden');
	}
}
