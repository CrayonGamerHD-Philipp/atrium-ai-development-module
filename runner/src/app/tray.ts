/**
 * Tray-Symbol der PC-Oberfläche über Hilfsprozesse, die zum System gehören (keine nativen Module):
 *
 * - Windows: PowerShell mit WinForms `NotifyIcon` (Infobereich der Taskleiste)
 * - macOS: JXA (`osascript -l JavaScript`) mit `NSStatusItem` in der Menüleiste
 * - Linux: kein Tray (Starter im Anwendungsmenü, siehe `install`)
 *
 * Der Hilfsprozess schreibt Menübefehle zeilenweise auf stdout (`open`, `handover`, `pause`, `resume`, `quit`) und
 * beendet sich, wenn die Oberfläche (Eltern-PID) nicht mehr läuft.
 */
import { LineProcess } from '../power/line-process.ts';
import { encodePowerShell } from '../power/windows.ts';

export const TRAY_COMMANDS = ['open', 'handover', 'pause', 'resume', 'quit'] as const;
export type TrayCommand = (typeof TRAY_COMMANDS)[number];

/** PowerShell-Skript für den Infobereich (Windows); `{{EXE}}`/`{{PID}}` werden ersetzt */
export function windowsTrayScript(exe: string, parentPid: number): string {
	const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;
	return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$out = [Console]::Out
function Emit([string]$s) { $out.WriteLine($s); $out.Flush() }
$icon = New-Object System.Windows.Forms.NotifyIcon
try { $icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(${psString(exe)}) } catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'Atrium Runner'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Item([string]$label, [string]$cmd) {
	$i = $menu.Items.Add($label)
	$i.Tag = $cmd
	$i.add_Click({ param($s, $e) Emit $s.Tag })
	return $i
}
$open = Item 'Atrium Runner öffnen' 'open'
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void](Item 'Jetzt an Server übergeben' 'handover')
[void](Item 'Pausieren' 'pause')
[void](Item 'Fortsetzen' 'resume')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void](Item 'Tray-Symbol beenden (Runner läuft weiter)' 'quit')
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Emit 'open' } })
$icon.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
	if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) {
		$icon.Visible = $false
		[System.Windows.Forms.Application]::Exit()
	}
})
$timer.Start()
Emit 'ready'
[System.Windows.Forms.Application]::Run()
$icon.Visible = $false
`;
}

/** JXA-Skript für die Menüleiste (macOS) */
export function macTrayScript(parentPid: number): string {
	return String.raw`
ObjC.import('Cocoa');
ObjC.import('stdlib');
function emit(s) {
	var data = $(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
	$.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}
ObjC.registerSubclass({
	name: 'AidevTrayTarget',
	methods: {
		'pick:': { types: ['void', ['id']], implementation: function (sender) { emit(ObjC.unwrap(sender.representedObject)); } },
		'tick:': { types: ['void', ['id']], implementation: function () {
			if ($.kill(${parentPid}, 0) !== 0) { $.NSApplication.sharedApplication.terminate($()); }
		} }
	}
});
var app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
var target = $.AidevTrayTarget.alloc.init;
var item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
item.button.title = 'Atrium';
var menu = $.NSMenu.alloc.init;
function add(label, cmd) {
	var m = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(label, 'pick:', '');
	m.target = target;
	m.representedObject = $(cmd);
	menu.addItem(m);
}
add('Atrium Runner öffnen', 'open');
menu.addItem($.NSMenuItem.separatorItem);
add('Jetzt an Server übergeben', 'handover');
add('Pausieren', 'pause');
add('Fortsetzen', 'resume');
menu.addItem($.NSMenuItem.separatorItem);
add('Menüleisten-Symbol beenden (Runner läuft weiter)', 'quit');
item.menu = menu;
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(3, target, 'tick:', $(), true);
emit('ready');
app.run;
`;
}

export interface Tray {
	stop(): Promise<void>;
}

/** Tray starten; `null`, wenn es auf diesem System keines gibt oder der Hilfsprozess nicht startet */
export async function startTray(o: {
	platform?: NodeJS.Platform;
	exe: string;
	onCommand(cmd: TrayCommand): void;
}): Promise<Tray | null> {
	const platform = o.platform ?? process.platform;
	let command: string;
	let args: string[];
	if (platform === 'win32') {
		command = 'powershell.exe';
		args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShell(windowsTrayScript(o.exe, process.pid))];
	} else if (platform === 'darwin') {
		command = '/usr/bin/osascript';
		args = ['-l', 'JavaScript', '-e', macTrayScript(process.pid)];
	} else {
		return null;
	}
	const proc = new LineProcess({
		command,
		args,
		restartMs: 0,
		onLine: (line) => {
			const cmd = line.trim();
			if ((TRAY_COMMANDS as readonly string[]).includes(cmd)) o.onCommand(cmd as TrayCommand);
		}
	});
	if (!(await proc.start())) return null;
	return { stop: () => proc.stop() };
}
