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
