import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accountEnv, collectSecrets, ConfigError, loadConfig } from '../src/config.ts';

const runnerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ATRIUM_URL: 'https://atrium.test/', ATRIUM_API_KEY: 'abcdefgh12345' };

describe('loadConfig', () => {
	it('liest nur Umgebungsvariablen mit Standardwerten', () => {
		const c = loadConfig({ env, cwd: runnerDir, configPath: undefined });
		expect(c.atriumUrl).toBe('https://atrium.test');
		expect(c.maxSlots).toBe(2);
		expect(c.workDir).toBe(path.resolve(runnerDir, '.work'));
		expect(c.gitAuthorName).toBe('Atrium Agent');
		expect(c.accounts).toEqual([]);
	});

	it('liest die Beispielkonfiguration', () => {
		const c = loadConfig({ env: { ...env, MAX_SLOTS: '4' }, cwd: runnerDir, configPath: 'runner.config.example.json' });
		expect(c.maxSlots).toBe(4);
		expect(c.accounts.map((a) => a.key)).toEqual(['claude-main', 'codex-main', 'gemini-main', 'local-llm']);
		expect(collectSecrets(c)).toContain('bitte-ersetzen');
		const e = accountEnv(c.accounts[0]!, { PATH: '/bin', ATRIUM_API_KEY: 'x' });
		expect(e.ATRIUM_API_KEY).toBeUndefined();
		expect(e.CLAUDE_CONFIG_DIR).toBe(path.join(path.resolve('/accounts/claude-main'), '.claude'));
		expect(e.CODEX_HOME).toBe(path.join(path.resolve('/accounts/claude-main'), '.codex'));
	});

	it('liest die Optionen der aktiven Limit-Abfrage', () => {
		const d = loadConfig({ env, cwd: runnerDir });
		expect(d.limitProbe).toBeUndefined();
		expect(d.limitProbeMin).toBe(5);
		const c = loadConfig({
			env: {
				...env,
				LIMIT_PROBE: 'false',
				LIMIT_PROBE_MIN: '15',
				RUNNER_ACCOUNTS: '[{"key":"claude-main","provider":"claude","limitProbe":true}]'
			},
			cwd: runnerDir
		});
		expect(c.limitProbe).toBe(false);
		expect(c.limitProbeMin).toBe(15);
		expect(c.accounts[0]?.limitProbe).toBe(true);
		expect(() => loadConfig({ env: { ...env, LIMIT_PROBE: 'vielleicht' }, cwd: runnerDir })).toThrow('LIMIT_PROBE');
		expect(() => loadConfig({ env: { ...env, LIMIT_PROBE_MIN: '0' }, cwd: runnerDir })).toThrow('LIMIT_PROBE_MIN');
	});

	it('liest Modus, Übergabefrist und Energie-Ereignisse', () => {
		const d = loadConfig({ env, cwd: runnerDir });
		expect(d).toMatchObject({ mode: 'server', handoffSec: 8, powerEvents: false });
		const desk = loadConfig({ env: { ...env, RUNNER_MODE: 'Desktop', HANDOFF_SEC: '5' }, cwd: runnerDir });
		expect(desk).toMatchObject({ mode: 'desktop', handoffSec: 5, powerEvents: true });
		expect(loadConfig({ env: { ...env, RUNNER_MODE: 'desktop', POWER_EVENTS: 'off' }, cwd: runnerDir }).powerEvents).toBe(false);
		expect(loadConfig({ env: { ...env, POWER_EVENTS: '1' }, cwd: runnerDir }).powerEvents).toBe(true);
		// Datei: Beispiel für den Desktop-Runner setzt mode und handoffSec
		const file = loadConfig({ env, cwd: path.join(runnerDir, 'desktop'), configPath: 'runner.desktop.example.json' });
		expect(file).toMatchObject({ mode: 'desktop', handoffSec: 8, powerEvents: true });
		// Umgebung hat Vorrang vor der Datei
		expect(
			loadConfig({ env: { ...env, RUNNER_MODE: 'server' }, cwd: path.join(runnerDir, 'desktop'), configPath: 'runner.desktop.example.json' }).mode
		).toBe('server');
		expect(() => loadConfig({ env: { ...env, RUNNER_MODE: 'laptop' }, cwd: runnerDir })).toThrow(
			'RUNNER_MODE: muss server oder desktop sein'
		);
		expect(() => loadConfig({ env: { ...env, HANDOFF_SEC: '0' }, cwd: runnerDir })).toThrow(
			'HANDOFF_SEC: muss eine ganze Zahl zwischen 1 und 60 sein'
		);
		expect(() => loadConfig({ env: { ...env, HANDOFF_SEC: '61' }, cwd: runnerDir })).toThrow('HANDOFF_SEC');
		expect(() => loadConfig({ env: { ...env, HANDOFF_SEC: 'bald' }, cwd: runnerDir })).toThrow('HANDOFF_SEC');
		expect(() => loadConfig({ env: { ...env, POWER_EVENTS: 'manchmal' }, cwd: runnerDir })).toThrow(
			'POWER_EVENTS: muss true/false'
		);
	});

	it('meldet verständliche Fehler', () => {
		expect(() => loadConfig({ env: { MAX_SLOTS: 'viele' }, cwd: runnerDir })).toThrow(ConfigError);
		try {
			loadConfig({
				env: { ...env, MAX_SLOTS: 'viele', RUNNER_ACCOUNTS: '[{"key":"X","provider":"openai-api"}]' },
				cwd: runnerDir
			});
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain('MAX_SLOTS: muss eine ganze Zahl');
			expect(msg).toContain('accounts[0].key');
			expect(msg).toContain('accounts[0].baseUrl: ist für openai-api Pflicht');
		}
		expect(() => loadConfig({ env, cwd: runnerDir, configPath: 'gibt-es-nicht.json' })).toThrow(/nicht gefunden/);
	});
});
