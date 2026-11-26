/**
 * Windows: PowerShell-Hilfsprozess mit einem versteckten Fenster (C# über `Add-Type`, keine native Abhängigkeit
 * im Runner). Das Fenster empfängt `WM_POWERBROADCAST` (`PBT_APMSUSPEND` → `suspend`, `PBT_APMRESUMEAUTOMATIC`/
 * `PBT_APMRESUMESUSPEND` → `resume`) sowie `WM_QUERYENDSESSION`/`WM_ENDSESSION` (Herunterfahren, Neustart,
 * Abmelden → `shutdown`). Beim Herunterfahren meldet es per `ShutdownBlockReasonCreate` einen Grund und wartet auf
 * `release` (höchstens 15 s); beim Standby lässt Windows nur etwa 2 s Zeit (danach geht es ohne Warten weiter,
 * der Heartbeat-Timeout in Atrium fängt den Rest ab). Protokoll: Zeilen auf stdout, `release` auf stdin.
 */
import { LineProcess } from './line-process.ts';
import type { PowerHandler, PowerMonitor } from './types.ts';

/** C#-Quelltext des Fensters (wird von PowerShell 5.1 mit dem .NET Framework übersetzt) */
export const WINDOWS_HELPER_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class AidevPowerWindow : Form {
	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string reason);
	[DllImport("user32.dll")]
	static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);
	[DllImport("kernel32.dll")]
	static extern bool SetProcessShutdownParameters(uint level, uint flags);

	const int WM_QUERYENDSESSION = 0x11;
	const int WM_ENDSESSION = 0x16;
	const int WM_POWERBROADCAST = 0x218;
	const int PBT_APMSUSPEND = 0x4;
	const int PBT_APMRESUMESUSPEND = 0x7;
	const int PBT_APMRESUMEAUTOMATIC = 0x12;

	readonly ManualResetEvent released = new ManualResetEvent(false);

	public AidevPowerWindow() {
		ShowInTaskbar = false;
		FormBorderStyle = FormBorderStyle.FixedToolWindow;
		Opacity = 0;
		// früh benachrichtigt werden (vor den meisten Anwendungen)
		SetProcessShutdownParameters(0x3FF, 0);
		Thread reader = new Thread(() => {
			string line;
			while ((line = Console.In.ReadLine()) != null) {
				if (line.Trim() == "release") released.Set();
			}
			Environment.Exit(0);
		});
		reader.IsBackground = true;
		reader.Start();
	}

	protected override void SetVisibleCore(bool value) {
		if (!IsHandleCreated) CreateHandle();
		base.SetVisibleCore(false);
	}

	static void Emit(string s) {
		Console.Out.WriteLine(s);
		Console.Out.Flush();
	}

	protected override void WndProc(ref Message m) {
		if (m.Msg == WM_POWERBROADCAST) {
			int ev = m.WParam.ToInt32();
			if (ev == PBT_APMSUSPEND) {
				released.Reset();
				Emit("suspend");
				released.WaitOne(1800);
			} else if (ev == PBT_APMRESUMESUSPEND || ev == PBT_APMRESUMEAUTOMATIC) {
				Emit("resume");
			}
		} else if (m.Msg == WM_QUERYENDSESSION) {
			released.Reset();
			ShutdownBlockReasonCreate(Handle, "Atrium-Runner übergibt laufende Aufträge an einen Server-Runner");
			Emit("shutdown");
			m.Result = (IntPtr)1;
			return;
		} else if (m.Msg == WM_ENDSESSION) {
			if (m.WParam != IntPtr.Zero) released.WaitOne(15000);
			ShutdownBlockReasonDestroy(Handle);
		}
		base.WndProc(ref m);
	}
}
`;

/** PowerShell-Skript: Fenster übersetzen und Nachrichtenschleife starten */
export function windowsHelperScript(): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		'Add-Type -AssemblyName System.Windows.Forms',
		`Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'\n${WINDOWS_HELPER_CS}\n'@`,
		"[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
		'[System.Windows.Forms.Application]::Run((New-Object AidevPowerWindow))'
	].join('\n');
}

/** `-EncodedCommand` erwartet UTF-16LE als Base64 (stdin bleibt frei für `release`) */
export function encodePowerShell(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

export class WindowsPowerMonitor implements PowerMonitor {
	readonly name = 'windows';
	readonly graceMs = 1_700;
	private proc: LineProcess | null = null;
	private chain: Promise<void> = Promise.resolve();

	async start(handler: PowerHandler): Promise<boolean> {
		const proc = new LineProcess({
			command: 'powershell.exe',
			args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(windowsHelperScript())],
			onLine: (line) => {
				const type = line.trim();
				if (type !== 'suspend' && type !== 'resume' && type !== 'shutdown') return;
				this.chain = this.chain.then(async () => {
					try {
						await handler({ type, source: this.name });
					} finally {
						if (type !== 'resume') proc.write('release');
					}
				});
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
