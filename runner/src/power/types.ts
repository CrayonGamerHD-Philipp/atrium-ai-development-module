/**
 * Gemeinsame Schnittstelle für Energie-Ereignisse des Betriebssystems (Standby/Ruhezustand, Aufwachen,
 * Herunterfahren/Abmelden). Implementierungen: Linux (logind über D-Bus mit Delay-Inhibitor), Windows
 * (PowerShell-Hilfsprozess mit verstecktem Fenster: `WM_POWERBROADCAST`, `WM_QUERYENDSESSION`), macOS (JXA:
 * `NSWorkspaceWillSleepNotification`/`…WillPowerOffNotification`), dazu eine plattformunabhängige
 * Aufwach-Erkennung über Zeitsprünge (`ClockDriftMonitor`) und eine Fake-Implementierung für Tests.
 */

export type PowerEventType = 'suspend' | 'resume' | 'shutdown';

export interface PowerEvent {
	type: PowerEventType;
	/** Quelle (für Logs), z. B. `logind`, `windows`, `macos`, `clock` */
	source: string;
	/** Bei `resume` aus der Zeitsprung-Erkennung: geschätzte Dauer des Standby (ms) */
	sleptMs?: number;
}

/**
 * Wird für `suspend`/`shutdown` aufgerufen und muss die Übergabe erledigen. Erst danach gibt die Implementierung
 * das Betriebssystem frei (Inhibitor lösen, Fenster-Nachricht beantworten).
 */
export type PowerHandler = (event: PowerEvent) => Promise<void>;

export interface PowerMonitor {
	readonly name: string;
	/**
	 * Wie viel Zeit das Betriebssystem typischerweise lässt (ms) – die Übergabe wird darauf begrenzt.
	 * `null` = keine Vorgabe (z. B. Zeitsprung-Erkennung).
	 */
	readonly graceMs: number | null;
	/** Beobachtung starten; `false`, wenn auf diesem System nicht verfügbar */
	start(handler: PowerHandler): Promise<boolean>;
	stop(): Promise<void>;
}
