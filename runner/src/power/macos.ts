/**
 * macOS: JXA-Hilfsprozess (`osascript -l JavaScript`, Teil des Systems) mit NSWorkspace-Benachrichtigungen:
 * `NSWorkspaceWillSleepNotification` → `suspend`, `NSWorkspaceDidWakeNotification` → `resume`,
 * `NSWorkspaceWillPowerOffNotification` → `shutdown` (Herunterfahren, Neustart, Abmelden). macOS wartet auf diese
 * Benachrichtigungen nicht – die Übergabe läuft, solange das System noch nicht schläft (typisch wenige Sekunden);
 * beim Herunterfahren beendet launchd den Runner zusätzlich mit `SIGTERM` (`ExitTimeOut` im LaunchAgent).
 */
import { LineProcess } from './line-process.ts';
import type { PowerHandler, PowerMonitor } from './types.ts';

export const MACOS_HELPER_JXA = String.raw`
ObjC.import('Cocoa');
function emit(s) {
	var data = $(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
	$.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
ObjC.registerSubclass({
	name: 'AidevPowerObserver',
	methods: {
		'willSleep:': { types: ['void', ['id']], implementation: function () { emit('suspend'); } },
		'didWake:': { types: ['void', ['id']], implementation: function () { emit('resume'); } },
		'willPowerOff:': { types: ['void', ['id']], implementation: function () { emit('shutdown'); } }
	}
});
var observer = $.AidevPowerObserver.alloc.init;
var center = $.NSWorkspace.sharedWorkspace.notificationCenter;
center.addObserverSelectorNameObject(observer, 'willSleep:', $.NSWorkspaceWillSleepNotification, $());
center.addObserverSelectorNameObject(observer, 'didWake:', $.NSWorkspaceDidWakeNotification, $());
center.addObserverSelectorNameObject(observer, 'willPowerOff:', $.NSWorkspaceWillPowerOffNotification, $());
emit('ready');
while (true) {
	$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(60));
}
`;

export class MacPowerMonitor implements PowerMonitor {
	readonly name = 'macos';
	readonly graceMs = 3_000;
	private proc: LineProcess | null = null;
	private chain: Promise<void> = Promise.resolve();

	async start(handler: PowerHandler): Promise<boolean> {
		const proc = new LineProcess({
			command: '/usr/bin/osascript',
			args: ['-l', 'JavaScript', '-e', MACOS_HELPER_JXA],
			onLine: (line) => {
				const type = line.trim();
				if (type !== 'suspend' && type !== 'resume' && type !== 'shutdown') return;
				this.chain = this.chain.then(() => handler({ type, source: this.name }));
			}
		});
		if (!(await proc.start())) return false;
		this.proc = proc;
		return true;
	}

	async stop(): Promise<void> {
		await this.proc?.stop();
		this.proc = null;
	}
}
