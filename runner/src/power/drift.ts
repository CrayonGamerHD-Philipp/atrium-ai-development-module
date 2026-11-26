/**
 * Aufwach-Erkennung ohne Betriebssystem-Ereignis: Ein Timer läuft alle `intervalMs`; liegt zwischen zwei Takten
 * deutlich mehr Zeit (Wanduhr), war der Rechner im Standby (Prozess eingefroren). Erkennt so auch ein Standby, das
 * ohne Ereignis begann (z. B. Deckel zu bei Modern Standby). Meldet nur `resume`.
 */
import type { PowerHandler, PowerMonitor } from './types.ts';

export interface DriftOptions {
	intervalMs?: number;
	/** Sprung ab dieser Größe gilt als Standby (ms) */
	thresholdMs?: number;
	now?: () => number;
}

export class ClockDriftMonitor implements PowerMonitor {
	readonly name = 'clock';
	readonly graceMs = null;
	private timer: NodeJS.Timeout | null = null;
	private last = 0;
	private readonly intervalMs: number;
	private readonly thresholdMs: number;
	private readonly now: () => number;

	constructor(o: DriftOptions = {}) {
		this.intervalMs = o.intervalMs ?? 5_000;
		this.thresholdMs = o.thresholdMs ?? 30_000;
		this.now = o.now ?? Date.now;
	}

	async start(handler: PowerHandler): Promise<boolean> {
		this.last = this.now();
		this.timer = setInterval(() => void this.tick(handler), this.intervalMs);
		this.timer.unref();
		return true;
	}

	/** Ein Takt (öffentlich für Tests) */
	async tick(handler: PowerHandler): Promise<void> {
		const now = this.now();
		const gap = now - this.last;
		this.last = now;
		if (gap - this.intervalMs >= this.thresholdMs) {
			await handler({ type: 'resume', source: this.name, sleptMs: gap - this.intervalMs });
		}
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
