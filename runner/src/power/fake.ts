/** Fake-Energieüberwachung für Tests: Ereignisse per `emit` auslösen und auf die Übergabe warten. */
import type { PowerEvent, PowerHandler, PowerMonitor } from './types.ts';

export class FakePowerMonitor implements PowerMonitor {
	readonly name = 'fake';
	private handler: PowerHandler | null = null;
	readonly handled: PowerEvent[] = [];
	started = false;

	constructor(readonly graceMs: number | null = 5000) {}

	async start(handler: PowerHandler): Promise<boolean> {
		this.handler = handler;
		this.started = true;
		return true;
	}

	async stop(): Promise<void> {
		this.started = false;
		this.handler = null;
	}

	/** Ereignis auslösen; löst sich auf, wenn der Runner es erledigt hat (wie die Freigabe des Inhibitors) */
	async emit(type: PowerEvent['type'], extra: Partial<PowerEvent> = {}): Promise<void> {
		if (!this.handler) throw new Error('FakePowerMonitor nicht gestartet');
		const event: PowerEvent = { type, source: 'fake', ...extra };
		await this.handler(event);
		this.handled.push(event);
	}
}
