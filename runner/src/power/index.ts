/**
 * Auswahl der Energieüberwachung je Plattform. Der Runner kombiniert immer die Betriebssystem-Ereignisse (sofern
 * verfügbar) mit der Zeitsprung-Erkennung (`ClockDriftMonitor`) – so wird ein Aufwachen auch dann erkannt, wenn
 * das Standby ohne Ereignis begann.
 */
import { ClockDriftMonitor } from './drift.ts';
import { LinuxPowerMonitor } from './linux.ts';
import { MacPowerMonitor } from './macos.ts';
import type { PowerEvent, PowerHandler, PowerMonitor } from './types.ts';
import { WindowsPowerMonitor } from './windows.ts';

export type { PowerEvent, PowerHandler, PowerMonitor } from './types.ts';
export { ClockDriftMonitor } from './drift.ts';
export { FakePowerMonitor } from './fake.ts';

/** Betriebssystem-Überwachung der aktuellen Plattform (oder `null`) */
export function platformPowerMonitor(platform: NodeJS.Platform = process.platform): PowerMonitor | null {
	switch (platform) {
		case 'linux':
			return new LinuxPowerMonitor();
		case 'win32':
			return new WindowsPowerMonitor();
		case 'darwin':
			return new MacPowerMonitor();
		default:
			return null;
	}
}

/** Mehrere Überwachungen als eine: startet alle, verfügbar wenn mindestens eine startet */
export class CombinedPowerMonitor implements PowerMonitor {
	readonly name: string;
	readonly graceMs: number | null;
	private active: PowerMonitor[] = [];

	constructor(private readonly parts: PowerMonitor[]) {
		this.name = parts.map((p) => p.name).join('+');
		const graces = parts.map((p) => p.graceMs).filter((g): g is number => g !== null);
		this.graceMs = graces.length ? Math.min(...graces) : null;
	}

	/** Namen der tatsächlich gestarteten Überwachungen */
	get started(): string[] {
		return this.active.map((p) => p.name);
	}

	async start(handler: PowerHandler): Promise<boolean> {
		for (const p of this.parts) {
			try {
				if (await p.start(handler)) this.active.push(p);
			} catch {
				// nicht verfügbar
			}
		}
		return this.active.length > 0;
	}

	async stop(): Promise<void> {
		await Promise.all(this.active.map((p) => p.stop()));
		this.active = [];
	}
}

export function defaultPowerMonitor(): PowerMonitor {
	const os = platformPowerMonitor();
	return new CombinedPowerMonitor([...(os ? [os] : []), new ClockDriftMonitor()]);
}

export function isPowerEvent(e: unknown): e is PowerEvent {
	return !!e && typeof e === 'object' && ['suspend', 'resume', 'shutdown'].includes((e as PowerEvent).type);
}
