/**
 * Energie-Ereignisse: Zeilenparser (logind, Hilfsskripte), Uhrsprung mit Fake-Timern, injizierte Kindprozesse
 * (Delay-Inhibitor, Rückfall auf dbus-monitor, fehlende Werkzeuge, Aufräumen).
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	macScript,
	parseDbusMonitorLine,
	parseGdbusLine,
	parseHelperLine,
	PowerMonitor,
	windowsScript,
	type DbusMonitorState,
	type PowerChild,
	type PowerEvent,
	type PowerSpawn
} from '../src/power.ts';

describe('parseGdbusLine', () => {
	it('erkennt PrepareForSleep und PrepareForShutdown(WithMetadata)', () => {
		const p = '/org/freedesktop/login1: org.freedesktop.login1.Manager.';
		expect(parseGdbusLine(`${p}PrepareForSleep (true,)`)).toEqual({ signal: 'sleep', start: true });
		expect(parseGdbusLine(`${p}PrepareForSleep (false,)`)).toEqual({ signal: 'sleep', start: false });
		expect(parseGdbusLine(`${p}PrepareForShutdown (true,)`)).toEqual({ signal: 'shutdown', start: true });
		expect(parseGdbusLine(`${p}PrepareForShutdownWithMetadata (true, {'type': <'reboot'>})`)).toEqual({
			signal: 'shutdown',
			start: true,
			type: 'reboot'
		});
	});

	it('ignoriert alle anderen Zeilen', () => {
		expect(parseGdbusLine('Monitoring signals on object /org/freedesktop/login1 owned by org.freedesktop.login1')).toBeNull();
		expect(parseGdbusLine('The name org.freedesktop.login1 is owned by :1.4')).toBeNull();
		expect(
			parseGdbusLine("/org/freedesktop/login1: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Manager', {}, [])")
		).toBeNull();
		expect(parseGdbusLine('')).toBeNull();
	});
});

describe('parseDbusMonitorLine', () => {
	it('liest das zweizeilige Format', () => {
		const lines = [
			'signal time=1700000000.1 sender=org.freedesktop.DBus -> destination=:1.99 serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired',
			'   string ":1.99"',
			'signal time=1700000001.2 sender=:1.4 -> destination=(null destination) serial=812 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep',
			'   boolean true',
			'signal time=1700000002.3 sender=:1.4 -> destination=(null destination) serial=813 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForShutdownWithMetadata',
			'   boolean true',
			'   array [',
			'signal time=1700000003.4 sender=:1.4 -> destination=(null destination) serial=814 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=SessionNew',
			'   boolean false'
		];
		let state: DbusMonitorState = { pending: null };
		const signals = [];
		for (const l of lines) {
			const r = parseDbusMonitorLine(l, state);
			state = r.state;
			if (r.signal) signals.push(r.signal);
		}
		expect(signals).toEqual([
			{ signal: 'sleep', start: true },
			{ signal: 'shutdown', start: true }
		]);
	});
});

describe('parseHelperLine', () => {
	it('liest die Zeilen der Hilfsskripte', () => {
		expect(parseHelperLine('AIDEV-POWER suspend')).toEqual({ type: 'event', kind: 'suspend' });
		expect(parseHelperLine('AIDEV-POWER resume\r')).toEqual({ type: 'event', kind: 'resume' });
		expect(parseHelperLine('AIDEV-POWER shutdown')).toEqual({ type: 'event', kind: 'shutdown' });
		expect(parseHelperLine('AIDEV-POWER ready')).toEqual({ type: 'ready' });
		expect(parseHelperLine('AIDEV-POWER error Add-Type fehlgeschlagen')).toEqual({
			type: 'error',
			message: 'Add-Type fehlgeschlagen'
		});
		expect(parseHelperLine('AIDEV-POWER explode')).toBeNull();
		expect(parseHelperLine('suspend')).toBeNull();
	});

	it('Hilfsskripte enthalten die erwarteten Nachrichten', () => {
		const w = windowsScript(8000);
		expect(w).toContain('WM_POWERBROADCAST');
		expect(w).toContain('[AidevPowerWindow]::Run(8000)');
		expect(windowsScript(999_999)).toContain('Run(60000)');
		const m = macScript();
		expect(m).toContain('NSWorkspaceWillSleepNotification');
		expect(m).toContain('NSWorkspaceWillPowerOffNotification');
	});
});

// ---------------------------------------------------------------- Kindprozesse

class FakeChild extends EventEmitter implements PowerChild {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly written: string[] = [];
	killed: NodeJS.Signals[] = [];
	stdinEnded = false;
	constructor(
		readonly cmd: string,
		readonly args: string[]
	) {
		super();
		this.stdin.on('data', (d: Buffer) => this.written.push(d.toString()));
		this.stdin.on('finish', () => {
			this.stdinEnded = true;
		});
	}
	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.killed.push(signal);
		return true;
	}
	line(s: string): void {
		this.stdout.write(`${s}\n`);
	}
}

function fakeSpawn(missing: string[] = []) {
	const children: FakeChild[] = [];
	const spawn: PowerSpawn = (cmd, args) => {
		const c = new FakeChild(cmd, args);
		children.push(c);
		if (missing.includes(cmd)) {
			const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
			setImmediate(() => c.emit('error', err));
		}
		return c;
	};
	return { spawn, children, of: (cmd: string) => children.filter((c) => c.cmd === cmd) };
}

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
	for (let i = 0; i < 5; i++) await tick();
};

function monitor(platform: NodeJS.Platform, missing: string[] = [], extra = {}) {
	const f = fakeSpawn(missing);
	const warns: string[] = [];
	const log = {
		debug: () => undefined,
		info: () => undefined,
		warn: (m: string) => warns.push(m),
		error: (m: string) => warns.push(m),
		child: () => log
	};
	const m = new PowerMonitor({ platform, spawn: f.spawn, log, ...extra });
	const events: PowerEvent[] = [];
	m.onEvent((e) => events.push(e));
	return { m, events, warns, ...f };
}

describe('PowerMonitor (Linux)', () => {
	it('hält einen Delay-Inhibitor, meldet Ereignisse, gibt ihn bei ack frei und holt ihn nach resume neu', async () => {
		const t = monitor('linux');
		t.m.start();
		const [inh] = t.of('systemd-inhibit');
		expect(inh?.args).toEqual(expect.arrayContaining(['--mode=delay', '--what=sleep:shutdown', '--no-ask-password', 'cat']));
		const [mon] = t.of('gdbus');
		expect(mon?.args).toEqual(expect.arrayContaining(['monitor', '--system']));
		expect(t.m.methods).toEqual(['clock', 'gdbus']);

		// ack ohne anstehendes Ereignis: Inhibitor bleibt
		t.m.ack();
		expect(inh?.stdinEnded).toBe(false);

		mon?.line('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)');
		await flush();
		expect(t.events).toEqual([{ kind: 'suspend', source: 'logind' }]);
		t.m.ack();
		await flush();
		expect(inh?.stdinEnded).toBe(true);

		mon?.line('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)');
		await flush();
		expect(t.events.at(-1)).toMatchObject({ kind: 'resume', source: 'logind' });
		expect(t.of('systemd-inhibit')).toHaveLength(2);

		// Herunterfahren: beide Varianten von logind → nur ein Ereignis
		mon?.line('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (true,)');
		mon?.line("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdownWithMetadata (true, {'type': <'poweroff'>})");
		await flush();
		expect(t.events.filter((e) => e.kind === 'shutdown')).toHaveLength(1);

		t.m.stop();
		await flush();
		expect(mon?.killed).toContain('SIGTERM');
		expect(t.of('systemd-inhibit')[1]?.stdinEnded).toBe(true);
		expect(t.warns).toEqual([]);
	});

	it('weicht auf dbus-monitor aus und läuft ohne Werkzeuge nur mit dem Uhrsprung weiter', async () => {
		const t = monitor('linux', ['gdbus']);
		t.m.start();
		await flush();
		const [dm] = t.of('dbus-monitor');
		expect(dm).toBeDefined();
		dm?.line('signal time=1.0 sender=:1.4 -> destination=(null destination) serial=1 path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep');
		dm?.line('   boolean true');
		await flush();
		expect(t.events).toEqual([{ kind: 'suspend', source: 'logind' }]);
		t.m.stop();

		const none = monitor('linux', ['gdbus', 'dbus-monitor', 'systemd-inhibit']);
		expect(() => none.m.start()).not.toThrow();
		await flush();
		expect(none.m.methods).toEqual(['clock']);
		expect(none.warns.some((w) => w.includes('Inhibitor'))).toBe(true);
		expect(none.warns.some((w) => w.includes('nur Erkennung über Uhrsprung'))).toBe(true);
		none.m.stop();
	});

	it('wirft nicht, wenn schon der Start des Kindprozesses fehlschlägt', () => {
		const m = new PowerMonitor({
			platform: 'linux',
			spawn: () => {
				throw new Error('kaputt');
			}
		});
		expect(() => m.start()).not.toThrow();
		expect(m.methods).toEqual(['clock']);
		m.stop();
	});
});

describe('PowerMonitor (Windows, macOS)', () => {
	it('Windows: PowerShell-Fenster, ack über stdin', async () => {
		const t = monitor('win32', [], { waitMs: 5000 });
		t.m.start();
		const [ps] = t.of('powershell.exe');
		expect(ps?.args).toContain('-EncodedCommand');
		const script = Buffer.from(ps?.args.at(-1) ?? '', 'base64').toString('utf16le');
		expect(script).toContain('[AidevPowerWindow]::Run(5000)');
		ps?.line('AIDEV-POWER ready');
		ps?.line('AIDEV-POWER suspend');
		await flush();
		expect(t.events).toEqual([{ kind: 'suspend', source: 'windows' }]);
		t.m.ack();
		await flush();
		expect(ps?.written.join('')).toBe('ack\n');
		// Windows meldet das Aufwachen oft doppelt (RESUMEAUTOMATIC + RESUMESUSPEND)
		ps?.line('AIDEV-POWER resume');
		ps?.line('AIDEV-POWER resume');
		ps?.line('AIDEV-POWER shutdown');
		await flush();
		expect(t.events.map((e) => e.kind)).toEqual(['suspend', 'resume', 'shutdown']);
		t.m.stop();
		await flush();
		expect(ps?.stdinEnded).toBe(true);
	});

	it('macOS: osascript mit JXA', async () => {
		const t = monitor('darwin');
		t.m.start();
		const [osa] = t.of('osascript');
		expect(osa?.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
		osa?.line('AIDEV-POWER suspend');
		osa?.line('AIDEV-POWER resume');
		await flush();
		expect(t.events.map((e) => `${e.kind}/${e.source}`)).toEqual(['suspend/macos', 'resume/macos']);
		t.m.stop();
	});

	it('meldet einen Fehler des Hilfsskripts als Warnung und startet nach unerwartetem Ende neu', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
		try {
			const t = monitor('darwin');
			t.m.start();
			const [osa] = t.of('osascript');
			osa?.line('AIDEV-POWER error keine Sitzung');
			await vi.advanceTimersByTimeAsync(1500);
			expect(t.warns.some((w) => w.includes('Fehler'))).toBe(true);
			osa?.emit('exit', 1, null);
			await vi.advanceTimersByTimeAsync(2500);
			expect(t.of('osascript')).toHaveLength(2);
			t.m.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('PowerMonitor (Uhrsprung)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('meldet resume, wenn der Timer deutlich zu spät feuert', () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
		const t = monitor('linux', [], { platformEvents: false, clockTickMs: 5_000, clockJumpMs: 30_000 });
		t.m.start();
		vi.advanceTimersByTime(20_000);
		expect(t.events).toEqual([]);
		// PC schläft 2 min: die Uhr springt, der Timer feuert erst danach
		vi.setSystemTime(Date.now() + 120_000);
		vi.advanceTimersByTime(5_000);
		expect(t.events).toEqual([{ kind: 'resume', source: 'clock', detail: 'Uhrsprung 120 s' }]);
		vi.advanceTimersByTime(30_000);
		expect(t.events).toHaveLength(1);
		// Uhr zurückgestellt: kein Ereignis
		vi.setSystemTime(Date.now() - 600_000);
		vi.advanceTimersByTime(5_000);
		expect(t.events).toHaveLength(1);
		t.m.stop();
		expect(t.of('systemd-inhibit')).toHaveLength(0);
	});

	it('meldet dasselbe Aufwachen nur einmal (Plattform und Uhrsprung)', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
		const t = monitor('win32');
		t.m.start();
		const [ps] = t.of('powershell.exe');
		ps?.line('AIDEV-POWER suspend');
		await flush();
		vi.setSystemTime(Date.now() + 300_000);
		vi.advanceTimersByTime(5_000);
		ps?.line('AIDEV-POWER resume');
		await flush();
		expect(t.events.map((e) => `${e.kind}/${e.source}`)).toEqual(['suspend/windows', 'resume/clock']);
		t.m.stop();
	});
});
