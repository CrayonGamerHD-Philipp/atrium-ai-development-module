/**
 * Terminal-Sitzung im Browser (xterm.js) gegen `POST /projects/:id/terminal` → `{ sid }` → SSE `/terminal/:sid/live`.
 * Eingaben werden ~20 ms gebündelt und in Reihenfolge gesendet, Größenänderungen entprellt gemeldet.
 * xterm wird erst im Browser geladen (`start` aus `onMount`).
 */
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { TerminalLiveEvent } from '../../schemas';
import { closeTerminal, openTerminal, terminalInput, terminalResize } from '../api';
import { errMsg, isUnavailable } from '../format';
import { LiveStream, type LiveStatus } from '../live.svelte';

export type TermStatus = 'opening' | 'live' | 'exited' | 'error';

const LIGHT = {
	background: '#ffffff',
	foreground: '#1f2328',
	cursor: '#1f2328',
	cursorAccent: '#ffffff',
	selectionBackground: '#b6cff5'
};
const DARK = {
	background: '#0f1115',
	foreground: '#e3e6ea',
	cursor: '#e3e6ea',
	cursorAccent: '#0f1115',
	selectionBackground: '#3a4a66'
};

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(Math.round(n), min), max);
const INPUT_MAX = 16_000;

let counter = 0;

export class TermSession {
	readonly key = `t${++counter}`;
	readonly label: string;
	status = $state<TermStatus>('opening');
	liveStatus = $state<LiveStatus>('connecting');
	error = $state('');
	unavailable = $state(false);
	exitCode = $state<number | null>(null);

	sid: string | null = null;
	private term: Terminal | null = null;
	private fit: FitAddon | null = null;
	private live: LiveStream<TerminalLiveEvent> | null = null;
	private observer: ResizeObserver | null = null;
	private lastSeq = -1;
	private buffer = '';
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private sending: Promise<void> = Promise.resolve();
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private size = { cols: 0, rows: 0 };
	private disposed = false;
	private container: HTMLElement | null = null;

	constructor(
		private readonly projectId: string,
		readonly target: string,
		index: number
	) {
		this.label = `Terminal ${index}`;
	}

	async start(container: HTMLElement, dark: boolean): Promise<void> {
		this.container = container;
		const [{ Terminal: Term }, { FitAddon: Fit }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit'),
			import('@xterm/xterm/css/xterm.css')
		]);
		if (this.disposed) return;
		const term = new Term({
			fontFamily:
				'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: false,
			theme: dark ? DARK : LIGHT
		});
		const fit = new Fit();
		term.loadAddon(fit);
		term.open(container);
		this.term = term;
		this.fit = fit;
		this.safeFit();
		const cols = clamp(term.cols || 120, 10, 500);
		const rows = clamp(term.rows || 32, 5, 200);
		this.size = { cols, rows };

		term.onData((data) => this.queueInput(data));
		this.observer = new ResizeObserver(() => this.onResize());
		this.observer.observe(container);

		term.write('\x1b[2mVerbinde mit dem Runner …\x1b[0m\r\n');
		try {
			const res = await openTerminal(this.projectId, { target: this.target, cols, rows });
			if (this.disposed) {
				void closeTerminal(res.sid).catch(() => undefined);
				return;
			}
			this.sid = res.sid;
			this.connect(res.sid);
		} catch (e) {
			this.status = 'error';
			this.unavailable = isUnavailable(e);
			this.error = this.unavailable
				? 'Kein Runner mit Terminal ist gerade online.'
				: errMsg(e, 'Terminal konnte nicht geöffnet werden');
			term.write(`\r\n\x1b[31m${this.error}\x1b[0m\r\n`);
		}
	}

	private connect(sid: string) {
		const live = new LiveStream<TerminalLiveEvent>({
			path: `/terminal/${sid}/live`,
			onEvent: (e) => {
				this.liveStatus = live.status;
				switch (e.type) {
					case 'hello':
						if (this.status === 'opening') {
							this.status = 'live';
							this.term?.focus();
						}
						break;
					case 'output':
						if (e.seq <= this.lastSeq) return;
						this.lastSeq = e.seq;
						this.term?.write(e.data);
						break;
					case 'exit':
						this.status = 'exited';
						this.exitCode = e.code;
						this.term?.write(
							`\r\n\x1b[2m[Prozess beendet${e.code !== null ? ` mit Code ${e.code}` : ''}]\x1b[0m\r\n`
						);
						live.close();
						break;
					case 'error':
						this.term?.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
						break;
				}
			},
			onRevoked: () => {
				this.status = 'error';
				this.error = 'Zugriff auf das Terminal wurde entzogen.';
				this.term?.write(`\r\n\x1b[31m${this.error}\x1b[0m\r\n`);
			}
		});
		this.live = live;
		live.connect();
	}

	private queueInput(data: string) {
		if (!this.sid || this.status !== 'live') return;
		this.buffer += data;
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			const chunk = this.buffer;
			this.buffer = '';
			const sid = this.sid;
			if (!chunk || !sid) return;
			this.sending = this.sending.then(async () => {
				for (let i = 0; i < chunk.length; i += INPUT_MAX) {
					try {
						await terminalInput(sid, chunk.slice(i, i + INPUT_MAX));
					} catch (e) {
						this.term?.write(`\r\n\x1b[31m${errMsg(e, 'Eingabe nicht übertragen')}\x1b[0m\r\n`);
						return;
					}
				}
			});
		}, 20);
	}

	private safeFit() {
		if (!this.fit || !this.container) return;
		if (!this.container.offsetWidth || !this.container.offsetHeight) return;
		try {
			this.fit.fit();
		} catch {
			// unsichtbar o. Ä.
		}
	}

	private onResize() {
		this.safeFit();
		if (this.resizeTimer) clearTimeout(this.resizeTimer);
		this.resizeTimer = setTimeout(() => {
			const term = this.term;
			if (!term || !this.sid || this.status !== 'live') return;
			const cols = clamp(term.cols, 10, 500);
			const rows = clamp(term.rows, 5, 200);
			if (cols === this.size.cols && rows === this.size.rows) return;
			this.size = { cols, rows };
			void terminalResize(this.sid, cols, rows).catch(() => undefined);
		}, 200);
	}

	/** Nach dem Sichtbarwerden (Reiterwechsel) neu einpassen */
	refit(): void {
		requestAnimationFrame(() => {
			this.onResize();
			this.term?.focus();
		});
	}

	setDark(dark: boolean): void {
		if (this.term) this.term.options.theme = dark ? DARK : LIGHT;
	}

	dispose(): void {
		this.disposed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		if (this.resizeTimer) clearTimeout(this.resizeTimer);
		this.observer?.disconnect();
		this.live?.close();
		if (this.sid) void closeTerminal(this.sid).catch(() => undefined);
		this.sid = null;
		this.term?.dispose();
		this.term = null;
	}
}
