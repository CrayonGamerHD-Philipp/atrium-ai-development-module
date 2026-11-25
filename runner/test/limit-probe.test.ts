import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountConfigSchema, type AccountConfig } from '../src/config.ts';
import type { AccountState } from '../src/executor.ts';
import {
	CLAUDE_USAGE_URL,
	fetchClaudeUsage,
	LimitProber,
	limitProbeEnabled,
	MAX_BACKOFF_MS,
	readClaudeOAuthToken,
	type ProbeFetch
} from '../src/limit-probe.ts';
import type { Logger } from '../src/log.ts';
import { LimitStore } from '../src/providers/limit-snapshot.ts';

const TOKEN = 'sk-ant-oat01-GEHEIMES-TOKEN-1234567890';
const USAGE = {
	five_hour: { utilization: 37.0, resets_at: '2026-11-25T18:00:00Z' },
	seven_day: { utilization: 52.0, resets_at: '2026-11-29T00:00:00Z' },
	seven_day_sonnet: null
};

let home: string;
const t0 = new Date('2026-11-25T10:00:00.000Z');

beforeAll(async () => {
	home = await mkdtemp(path.join(os.tmpdir(), 'limit-probe-'));
	await mkdir(path.join(home, '.claude'), { recursive: true });
	await writeFile(
		path.join(home, '.claude', '.credentials.json'),
		JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: t0.getTime() + 3 * 3_600_000 } })
	);
});

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingLog(lines: string[]): Logger {
	const l: Logger = {
		debug: (m, e) => lines.push(`${m} ${e === undefined ? '' : JSON.stringify(e)}`),
		info: (m, e) => lines.push(`${m} ${e === undefined ? '' : JSON.stringify(e)}`),
		warn: (m, e) => lines.push(`${m} ${e === undefined ? '' : JSON.stringify(e)}`),
		error: (m, e) => lines.push(`${m} ${e === undefined ? '' : JSON.stringify(e)}`),
		child: () => l
	};
	return l;
}

describe('readClaudeOAuthToken', () => {
	it('liest das Token aus der Umgebung bzw. der Anmeldedatei', async () => {
		expect(await readClaudeOAuthToken({ CLAUDE_CODE_OAUTH_TOKEN: 'aus-env' }, t0)).toBe('aus-env');
		expect(await readClaudeOAuthToken({ CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, t0)).toBe(TOKEN);
		expect(await readClaudeOAuthToken({ HOME: home }, t0)).toBe(TOKEN);
	});

	it('liefert null ohne Login, bei kaputter Datei oder abgelaufenem Token', async () => {
		expect(await readClaudeOAuthToken({ HOME: path.join(home, 'fehlt') }, t0)).toBeNull();
		expect(await readClaudeOAuthToken({ HOME: home }, new Date(t0.getTime() + 4 * 3_600_000))).toBeNull();
		const broken = await mkdtemp(path.join(os.tmpdir(), 'limit-probe-kaputt-'));
		try {
			await writeFile(path.join(broken, '.credentials.json'), '{kaputt');
			expect(await readClaudeOAuthToken({ CLAUDE_CONFIG_DIR: broken }, t0)).toBeNull();
		} finally {
			await rm(broken, { recursive: true, force: true });
		}
	});
});

describe('fetchClaudeUsage', () => {
	it('fragt den OAuth-Endpunkt ab und bildet die Fenster ab', async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		const r = await fetchClaudeUsage(TOKEN, async (url, init) => {
			seen = { url, init };
			return json(USAGE);
		});
		expect(r).toEqual({
			ok: true,
			windows: [
				{ window: '5h', label: 'five_hour', usedPercent: 37, resetsAt: '2026-11-25T18:00:00.000Z', status: 'allowed' },
				{ window: 'week', label: 'seven_day', usedPercent: 52, resetsAt: '2026-11-29T00:00:00.000Z', status: 'allowed' }
			]
		});
		expect(seen!.url).toBe(CLAUDE_USAGE_URL);
		const headers = seen!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
		expect(seen!.init.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		['Netzwerkfehler', (async () => {
			throw new Error(`connect ECONNREFUSED (Token ${TOKEN})`);
		}) as ProbeFetch],
		['HTTP 500', (async () => json({ error: 'x' }, 500)) as ProbeFetch],
		['HTTP 401', (async () => json({ error: 'x' }, 401)) as ProbeFetch],
		['kein JSON', (async () => new Response('<html>', { status: 200 })) as ProbeFetch],
		['unbekannte Form', (async () => json({ ganz: 'anders' })) as ProbeFetch]
	])('verschluckt Fehler: %s', async (_name, f) => {
		const r = await fetchClaudeUsage(TOKEN, f);
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(TOKEN);
	});

	it('bricht nach dem Zeitlimit ab', async () => {
		const hang: ProbeFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		const started = Date.now();
		const r = await fetchClaudeUsage(TOKEN, hang, 150);
		expect(r).toEqual({ ok: false, status: null, error: 'Zeitüberschreitung' });
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

describe('LimitProber', () => {
	const claude = accountConfigSchema.parse({ key: 'claude-main', provider: 'claude', home: '/x' });
	const codex = accountConfigSchema.parse({ key: 'codex-main', provider: 'codex' });

	function setup(fetchFn: ProbeFetch, accts: AccountConfig[] = [claude, codex], extra: { limitProbe?: boolean } = {}) {
		let now = t0;
		const store = new LimitStore();
		const lines: string[] = [];
		const states = new Map<string, AccountState>(
			accts.map((a) => [a.key, { config: a, ok: true, loggedIn: true, version: '1' }])
		);
		let calls = 0;
		const prober = new LimitProber({
			config: { accounts: accts, limitProbeMin: 5, ...extra },
			store,
			accounts: () => states,
			fetch: (url, init) => {
				calls++;
				return fetchFn(url, init);
			},
			log: recordingLog(lines),
			now: () => now,
			env: () => ({ HOME: home })
		});
		return {
			prober,
			store,
			lines,
			calls: () => calls,
			advance(min: number) {
				now = new Date(now.getTime() + min * 60_000);
			}
		};
	}

	it('ist standardmäßig nur für Claude an und lässt sich abschalten', () => {
		expect(limitProbeEnabled(claude, {})).toBe(true);
		expect(limitProbeEnabled(codex, {})).toBe(false);
		expect(limitProbeEnabled(codex, { limitProbe: true })).toBe(false);
		expect(limitProbeEnabled(claude, { limitProbe: false })).toBe(false);
		expect(limitProbeEnabled({ ...claude, limitProbe: true }, { limitProbe: false })).toBe(true);
		expect(limitProbeEnabled({ ...claude, limitProbe: false }, {})).toBe(false);
	});

	it('fragt fällige Konten ab und legt den Stand im Speicher ab', async () => {
		const s = setup(async () => json(USAGE));
		await s.prober.tick();
		expect(s.calls()).toBe(1);
		expect(s.store.snapshot('claude-main')).toMatchObject({ source: 'probe', observedAt: t0.toISOString() });
		expect(s.store.snapshot('codex-main')).toBeNull();
		// vor Ablauf des Abstands keine erneute Abfrage
		s.advance(4);
		await s.prober.tick();
		expect(s.calls()).toBe(1);
		s.advance(1);
		await s.prober.tick();
		expect(s.calls()).toBe(2);
	});

	it('verschluckt Fehler, wartet danach länger und protokolliert kein Token', async () => {
		const s = setup(async () => {
			throw new Error(`fetch failed: Bearer ${TOKEN}`);
		});
		await expect(s.prober.tick()).resolves.toBeUndefined();
		expect(s.calls()).toBe(1);
		expect(s.store.snapshot('claude-main')).toBeNull();
		// kein Wiederholsturm: nach 5 min noch keine neue Abfrage (Abstand wächst)
		s.advance(5);
		await s.prober.tick();
		expect(s.calls()).toBe(1);
		s.advance(6);
		await s.prober.tick();
		expect(s.calls()).toBe(2);
		expect(s.lines.length).toBeGreaterThan(0);
		for (const l of s.lines) expect(l).not.toContain(TOKEN);
	});

	it('pausiert nach 401/429 lange', async () => {
		const s = setup(async () => json({ error: 'unauthorized' }, 401));
		await s.prober.tick();
		s.advance(MAX_BACKOFF_MS / 60_000 - 1);
		await s.prober.tick();
		expect(s.calls()).toBe(1);
		s.advance(1);
		await s.prober.tick();
		expect(s.calls()).toBe(2);
	});

	it('überspringt Konten mit frischem Stand aus einem Lauf, ohne Login oder wenn abgeschaltet', async () => {
		const s = setup(async () => json(USAGE));
		s.store.update('claude-main', [{ window: '5h', label: 'five_hour', usedPercent: 1, resetsAt: null, status: 'allowed' }], 'stream', t0);
		await s.prober.tick();
		expect(s.calls()).toBe(0);
		s.advance(5);
		await s.prober.tick();
		expect(s.calls()).toBe(1);

		const off = setup(async () => json(USAGE), [claude], { limitProbe: false });
		expect(off.prober.enabled).toBe(false);
		await off.prober.tick();
		expect(off.calls()).toBe(0);

		// Konto ohne Login: keine Abfrage
		const p = new LimitProber({
			config: { accounts: [claude], limitProbeMin: 5 },
			store: new LimitStore(),
			accounts: () => new Map(),
			fetch: () => {
				throw new Error('darf nicht aufgerufen werden');
			},
			env: () => ({ HOME: home })
		});
		await expect(p.tick()).resolves.toBeUndefined();
	});

	it('fragt ohne OAuth-Token nicht ab', async () => {
		let calls = 0;
		const p = new LimitProber({
			config: { accounts: [claude], limitProbeMin: 5 },
			store: new LimitStore(),
			accounts: () => new Map([[claude.key, { config: claude, ok: true, loggedIn: true, version: '1' }]]),
			fetch: async () => {
				calls++;
				return json(USAGE);
			},
			env: () => ({ HOME: path.join(home, 'fehlt'), ANTHROPIC_API_KEY: 'sk-ant-api-xyz' })
		});
		await p.tick();
		expect(calls).toBe(0);
	});
});
