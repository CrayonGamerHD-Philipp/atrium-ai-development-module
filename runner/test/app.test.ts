/** PC-Oberfläche: lokaler Server (Zugriffsschutz, Routen), Steuerlogik, Seite, Betriebssystem-Aufrufe, Autostart. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLoginTerminal, type OpenDeps } from '../src/app/desktop-open.ts';
import { API_KEY_MASK, maskApiKey, RunnerOps, unmaskApiKey } from '../src/app/ops.ts';
import { appPage } from '../src/app/page.ts';
import { AppServer, TOKEN_HEADER, type AppOps } from '../src/app/server.ts';
import { macTrayScript, windowsTrayScript } from '../src/app/tray.ts';
import { workDirOf } from '../src/desktop/cli.ts';
import { desktopPaths } from '../src/desktop/paths.ts';
import { desktopEntry, systemdUnit, uiLaunchAgentPlist, windowsLauncher, type ServiceManager, type ServiceSpec } from '../src/desktop/service.ts';
import { activityText } from '../src/executor.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aidev-app-'));

/** Rohe Anfrage (eigener Host-Kopf möglich) */
function request(port: number, method: string, p: string, o: { headers?: Record<string, string>; body?: unknown } = {}) {
	return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
		const data = o.body === undefined ? undefined : JSON.stringify(o.body);
		const req = http.request(
			{ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...o.headers } },
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c: string) => (body += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
			}
		);
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

describe('lokaler Server der Oberfläche', () => {
	const calls: string[] = [];
	const ops: AppOps = {
		state: async () => ({ ok: 'state' }),
		action: async (name) => {
			calls.push(name);
			return { ok: true, message: name };
		},
		logs: async (offset) => ({ offset: offset + 1, text: 'x', reset: false }),
		readConfig: async () => ({ path: 'c', exists: true, text: '{}' }),
		writeConfig: async (text) => ({ ok: true, message: text }),
		probe: async () => ({ ok: true, output: 'ok' }),
		login: async (k) => ({ ok: true, message: k }),
		openPath: async (w) => ({ ok: true, message: w }),
		quit: () => calls.push('quit')
	};
	const token = 'test-token-0123456789abcdef';
	const server = new AppServer({ ops, token, page: '<!doctype html><p>Seite</p>' });
	let port = 0;
	const auth = { [TOKEN_HEADER]: token };
	beforeAll(async () => {
		port = await server.listen();
	});
	afterAll(() => server.close());

	it('Seite ohne Token, mit strenger CSP; API nur mit Token', async () => {
		const page = await request(port, 'GET', '/');
		expect(page.status).toBe(200);
		expect(page.headers['content-security-policy']).toContain("default-src 'none'");
		expect(page.headers['x-frame-options']).toBe('DENY');
		expect((await request(port, 'GET', '/api/state')).status).toBe(401);
		expect((await request(port, 'GET', '/api/state', { headers: { [TOKEN_HEADER]: 'falsch' } })).status).toBe(401);
		const ok = await request(port, 'GET', '/api/state', { headers: auth });
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body)).toEqual({ ok: 'state' });
	});

	it('fremder Host (DNS-Rebinding) → 421, auch mit Token', async () => {
		expect((await request(port, 'GET', '/', { headers: { host: `evil.example:${port}` } })).status).toBe(421);
		expect((await request(port, 'GET', '/api/state', { headers: { ...auth, host: `evil.example:${port}` } })).status).toBe(421);
		expect((await request(port, 'GET', '/api/state', { headers: { ...auth, host: `localhost:${port}` } })).status).toBe(200);
	});

	it('Einmal-Code: einmal gegen das Token tauschbar, danach nicht mehr', async () => {
		const url = server.launchUrl();
		expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#c=[A-Za-z0-9_-]+$`));
		expect(url).not.toContain(token);
		const code = url.split('#c=')[1]!;
		const first = await request(port, 'POST', '/api/session', { body: { code } });
		expect(first.status).toBe(200);
		expect(JSON.parse(first.body)).toEqual({ token });
		expect((await request(port, 'POST', '/api/session', { body: { code } })).status).toBe(401);
		expect((await request(port, 'POST', '/api/session', { body: { code: 'geraten' } })).status).toBe(401);
		// abgelaufen
		const old = server.launchUrl(Date.now() - 120_000).split('#c=')[1]!;
		expect((await request(port, 'POST', '/api/session', { body: { code: old } })).status).toBe(401);
	});

	it('Aktionen und übrige Routen', async () => {
		expect(JSON.parse((await request(port, 'POST', '/api/action/pause', { headers: auth })).body)).toEqual({ ok: true, message: 'pause' });
		expect((await request(port, 'POST', '/api/action/rm-rf', { headers: auth })).status).toBe(404);
		expect((await request(port, 'GET', '/api/action/pause', { headers: auth })).status).toBe(404);
		expect(JSON.parse((await request(port, 'GET', '/api/logs?offset=41', { headers: auth })).body)).toMatchObject({ offset: 42 });
		expect(JSON.parse((await request(port, 'PUT', '/api/config', { headers: auth, body: { text: '{"a":1}' } })).body)).toMatchObject({ message: '{"a":1}' });
		expect((await request(port, 'PUT', '/api/config', { headers: auth, body: {} })).status).toBe(400);
		expect((await request(port, 'POST', '/api/open', { headers: auth, body: { which: '/etc' } })).status).toBe(400);
		expect(JSON.parse((await request(port, 'POST', '/api/login', { headers: auth, body: { account: 'claude-pc' } })).body)).toMatchObject({ message: 'claude-pc' });
		const launch = JSON.parse((await request(port, 'POST', '/api/launch-url', { headers: auth })).body) as { url: string };
		expect(launch.url).toContain('#c=');
		await request(port, 'POST', '/api/quit', { headers: auth });
		await new Promise((r) => setTimeout(r, 200));
		expect(calls).toEqual(['pause', 'quit']);
	});
});

describe('API-Key in der angezeigten Konfiguration', () => {
	it('wird verdeckt und beim Speichern wiederhergestellt', () => {
		const file = '{\n  "atriumUrl": "https://a.example.net",\n  "apiKey": "geheimer-key-123"\n}\n';
		const shown = maskApiKey(file);
		expect(shown).not.toContain('geheimer-key-123');
		expect(shown).toContain(`"apiKey": "${API_KEY_MASK}"`);
		expect(unmaskApiKey(shown.replace('a.example.net', 'b.example.net'), file)).toBe(file.replace('a.example.net', 'b.example.net'));
		// neuer Key wird übernommen, Platzhalter der Vorlage bleibt sichtbar
		expect(unmaskApiKey(shown.replace(API_KEY_MASK, 'neuer-key-456'), file)).toContain('"apiKey": "neuer-key-456"');
		expect(maskApiKey('{"apiKey": "API-KEY-EINTRAGEN"}')).toContain('API-KEY-EINTRAGEN');
	});
});

describe('Steuerlogik (RunnerOps)', () => {
	const dir = path.join(tmp, 'ops');
	const configFile = path.join(dir, 'config', 'runner.config.json');
	const paths = { ...desktopPaths('linux', {}, path.join(dir, 'home')), logDir: path.join(dir, 'logs') };
	const fakeService: ServiceManager = {
		name: 'fake',
		location: 'fake',
		install: async () => undefined,
		uninstall: async () => undefined,
		start: async () => undefined,
		stop: async () => undefined,
		status: async () => ({ installed: false, running: false, detail: 'kein Autostart' })
	};
	const commands: string[] = [];
	const ops = new RunnerOps({
		configFile,
		paths,
		service: fakeService,
		command: async (c, rest, io) => {
			commands.push([c, ...rest].join(' '));
			io.out(`ok ${c}`);
			return 0;
		},
		onQuit: () => undefined
	});
	const valid = {
		atriumUrl: 'https://atrium.test.internal',
		apiKey: 'echter-api-key-123456',
		name: 'pc-test',
		kind: 'desktop',
		workDir: '../work',
		accounts: [{ key: 'fake-pc', provider: 'fake' }]
	};

	beforeAll(() => {
		mkdirSync(path.dirname(configFile), { recursive: true });
		writeFileSync(configFile, JSON.stringify(valid, null, 2));
	});

	it('Zustand: Konfiguration, Prozess aus der Zustandsdatei, Arbeitsverzeichnis wie der Runner', async () => {
		let st = await ops.state();
		expect(st.config).toMatchObject({ exists: true, ok: true, complete: true, name: 'pc-test', accounts: [{ key: 'fake-pc' }] });
		expect(st.process.running).toBe(false);
		expect(st.paths.work).toBe(path.resolve(dir, 'work'));
		mkdirSync(st.paths.work, { recursive: true });
		writeFileSync(path.join(st.paths.work, 'state.json'), JSON.stringify({ pid: process.pid, name: 'pc-test', version: '0', kind: 'desktop', status: 'approved', runs: [] }));
		st = await ops.state();
		expect(st.process).toEqual({ running: true, pid: process.pid });
		expect(st.runner?.status).toBe('approved');
	});

	it('Pausieren/Übergeben nur bei laufendem Runner, über die Befehle der Kommandozeile', async () => {
		expect(await ops.action('pause')).toMatchObject({ ok: true, message: 'ok pause' });
		expect(await ops.action('autostart-on')).toMatchObject({ ok: true });
		expect(commands).toEqual(['pause', 'install --no-start']);
		writeFileSync(path.join(dir, 'work', 'state.json'), JSON.stringify({ pid: 999_999_9, runs: [] }));
		expect(await ops.action('handover')).toMatchObject({ ok: false, message: 'Der Runner läuft nicht' });
	});

	it('Vorlage noch nicht ausgefüllt → kein Start, Hinweis', async () => {
		const tpl = path.join(dir, 'tpl', 'runner.config.json');
		mkdirSync(path.dirname(tpl), { recursive: true });
		writeFileSync(tpl, JSON.stringify({ ...valid, atriumUrl: 'https://atrium.example.org', apiKey: 'API-KEY-EINTRAGEN' }));
		const o = new RunnerOps({ configFile: tpl, paths, service: fakeService, onQuit: () => undefined, spawnRunner: async () => { throw new Error('darf nicht starten'); } });
		expect((await o.state()).config).toMatchObject({ ok: true, complete: false });
		expect(await o.action('start')).toMatchObject({ ok: false });
	});

	it('Konfiguration speichern: prüft JSON und Inhalt, behält den API-Key', async () => {
		const shown = await ops.readConfig();
		expect(shown.text).not.toContain('echter-api-key-123456');
		expect(await ops.writeConfig('{ kaputt')).toMatchObject({ ok: false });
		expect(await ops.writeConfig(shown.text.replace('"fake"', '"unbekannt"'))).toMatchObject({ ok: false });
		const saved = await ops.writeConfig(shown.text.replace('pc-test', 'pc-neu'));
		expect(saved.ok).toBe(true);
		const onDisk = JSON.parse(readFileSync(configFile, 'utf8')) as typeof valid;
		expect(onDisk).toMatchObject({ name: 'pc-neu', apiKey: 'echter-api-key-123456' });
	});

	it('Protokoll: Ende beim ersten Abruf, danach nur Neues, ANSI entfernt', async () => {
		mkdirSync(paths.logDir, { recursive: true });
		const log = path.join(paths.logDir, 'runner.log');
		writeFileSync(log, 'zeile 1\n\x1b[31mzeile 2\x1b[0m\n');
		const first = await ops.logs(-1);
		expect(first).toMatchObject({ reset: true, text: 'zeile 1\nzeile 2\n' });
		writeFileSync(log, 'zeile 1\n\x1b[31mzeile 2\x1b[0m\nzeile 3\n');
		const next = await ops.logs(first.offset);
		expect(next).toMatchObject({ reset: false, text: 'zeile 3\n' });
		expect((await ops.logs(10_000_000)).reset).toBe(true);
	});

	it('Anmeldung nur für Konten aus der Konfiguration', async () => {
		expect(await ops.login('fremd; rm -rf /')).toMatchObject({ ok: false });
	});
});

describe('Arbeitsverzeichnis wie der Runner (workDirOf = loadConfig)', () => {
	it('workDir der Datei, sonst ./.work neben der Datei; WORK_DIR hat Vorrang', () => {
		const d = path.join(tmp, 'wd');
		mkdirSync(d, { recursive: true });
		const f = path.join(d, 'runner.config.json');
		writeFileSync(f, JSON.stringify({ workDir: 'arbeit' }));
		expect(workDirOf(f, {})).toBe(path.join(d, 'arbeit'));
		writeFileSync(f, JSON.stringify({}));
		expect(workDirOf(f, {})).toBe(path.join(d, '.work'));
		expect(workDirOf(f, { WORK_DIR: '/x/y' })).toBe(path.resolve(d, '/x/y'));
	});
});

describe('Seite', () => {
	it('eingebettetes Skript ist gültiges JavaScript ohne externe Quellen', () => {
		const html = appPage();
		const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
		expect(script.length).toBeGreaterThan(1000);
		expect(() => new Function(script)).not.toThrow();
		expect(html).not.toMatch(/(src|href)=["']https?:/);
		expect(script).not.toContain('innerHTML');
	});
});

describe('Betriebssystem-Aufrufe', () => {
	const recorder = (platform: NodeJS.Platform) => {
		const calls: { cmd: string; args: string[]; verbatim?: boolean }[] = [];
		const deps: OpenDeps = {
			platform,
			env: {},
			exists: () => false,
			spawnDetached: async (cmd, args, o) => {
				calls.push({ cmd, args, verbatim: o?.verbatim });
				return true;
			}
		};
		return { calls, deps };
	};

	it('Anmelde-Terminal unter Windows: Kommandozeile mit maskierten Pfaden', async () => {
		const { calls, deps } = recorder('win32');
		await openLoginTerminal({ exe: 'C:\\Programme\\Atrium Runner\\atrium-runner.exe', baseArgs: [] }, 'claude-pc', 'C:\\Users\\Max Muster\\cfg.json', deps);
		expect(calls[0]).toEqual({
			cmd: 'cmd.exe',
			args: ['/d', '/c', 'start "Atrium Runner – Anmeldung" cmd /k ""C:\\Programme\\Atrium Runner\\atrium-runner.exe" login claude-pc --config "C:\\Users\\Max Muster\\cfg.json""'],
			verbatim: true
		});
		await expect(openLoginTerminal({ exe: 'x', baseArgs: [] }, 'a&b', 'c', deps)).rejects.toThrow();
		await expect(openLoginTerminal({ exe: 'C:\\a&b\\x.exe', baseArgs: [] }, 'k', 'c', deps)).rejects.toThrow();
	});

	it('Anmelde-Terminal unter macOS/Linux: Argumente in einfachen Anführungszeichen', async () => {
		const mac = recorder('darwin');
		await openLoginTerminal({ exe: "/usr/local/bin/atrium-runner", baseArgs: [] }, 'codex-pc', "/Users/o'neil/cfg.json", mac.deps);
		expect(mac.calls[0]!.args[1]).toContain(`'/Users/o'\\\\''neil/cfg.json'`);
		const lin = recorder('linux');
		await openLoginTerminal({ exe: '/home/a/.local/bin/atrium-runner', baseArgs: [] }, 'gemini-pc', '/home/a/cfg.json', lin.deps);
		expect(lin.calls[0]).toMatchObject({ cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-c', expect.stringContaining("'login' 'gemini-pc'")] });
	});
});

describe('Autostart der Oberfläche', () => {
	const spec: ServiceSpec = {
		exe: '/opt/atrium runner/atrium-runner',
		baseArgs: [],
		configFile: '/home/a/.config/atrium-runner/runner.config.json',
		workDir: '/home/a/.local/share/atrium-runner/work',
		logDir: '/home/a/.local/share/atrium-runner/logs',
		pathEnv: '/usr/bin'
	};
	it('Windows: Startskript startet Tray und Runner', () => {
		const vbs = windowsLauncher({ ...spec, exe: 'C:\\R\\atrium-runner.exe', configFile: 'C:\\C\\runner.config.json', logDir: 'C:\\L' });
		// VBScript: `""` im String = ein Anführungszeichen → "C:\R\atrium-runner.exe" app --background --config "…"
		expect(vbs).toContain('sh.Run """C:\\R\\atrium-runner.exe"" app --background --config ""C:\\C\\runner.config.json""", 0, False');
		expect(vbs.indexOf('app --background')).toBeLessThan(vbs.indexOf('Do'));
	});
	it('Linux: Protokoll in runner.log, Starter im Anwendungsmenü', () => {
		expect(systemdUnit(spec)).toContain('StandardOutput=append:/home/a/.local/share/atrium-runner/logs/runner.log');
		expect(desktopEntry(spec)).toContain('Exec="/opt/atrium runner/atrium-runner" app --config /home/a/.config/atrium-runner/runner.config.json');
	});
	it('macOS: LaunchAgent der Oberfläche nur mit Tray', () => {
		const plist = uiLaunchAgentPlist(spec);
		expect(plist).toContain('<string>app</string>');
		expect(plist).toContain('<string>--background</string>');
		expect(plist).not.toContain('KeepAlive');
	});
	it('Tray-Skripte enthalten die Eltern-PID und alle Befehle', () => {
		const ps = windowsTrayScript("C:\\R\\o'k\\atrium-runner.exe", 4242);
		expect(ps).toContain("ExtractAssociatedIcon('C:\\R\\o''k\\atrium-runner.exe')");
		expect(ps).toContain('Get-Process -Id 4242');
		for (const c of ['open', 'handover', 'pause', 'resume', 'quit']) expect(ps).toContain(`'${c}'`);
		expect(macTrayScript(4242)).toContain('$.kill(4242, 0)');
	});
});

describe('Tätigkeit eines Laufs', () => {
	it('kurze Zeile aus Text, Werkzeug und git-Schritten', () => {
		expect(activityText('text', { text: 'Ich  lese\n die Datei' })).toBe('Ich lese die Datei');
		expect(activityText('tool', { name: 'Edit', summary: 'src/auth.ts' })).toBe('Edit: src/auth.ts');
		expect(activityText('git', { action: 'push', detail: 'origin/feature' })).toBe('git push: origin/feature');
		expect(activityText('status', {})).toBeNull();
		expect(activityText('text', { text: 'x'.repeat(500) })!.length).toBe(200);
	});
});
