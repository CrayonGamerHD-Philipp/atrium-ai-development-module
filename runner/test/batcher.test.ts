import { describe, expect, it } from 'vitest';
import { ApiError, AtriumClient, BATCH_MAX_BYTES, EventBatcher, parsePending, RunnerApi, truncateText } from '../src/client.ts';
import { MAX_EVENT_TEXT, type RunEvent } from '../src/protocol.ts';
import { Redactor } from '../src/redact.ts';

const RUN = '11111111-1111-4111-8111-111111111111';

/** RunnerApi-Attrappe: zeichnet Batches auf, kann Fehler simulieren */
function fakeApi(fail: (n: number) => Error | null = () => null) {
	const batches: RunEvent[][] = [];
	let calls = 0;
	const api = {
		events: async (_runId: string, events: RunEvent[]) => {
			const err = fail(calls++);
			if (err) throw err;
			batches.push(events);
			return {};
		}
	} as unknown as RunnerApi;
	return { api, batches, calls: () => calls };
}

describe('EventBatcher', () => {
	it('vergibt fortlaufende seq und bündelt', async () => {
		const { api, batches } = fakeApi();
		const b = new EventBatcher({ runId: RUN, api, redactor: new Redactor(), flushMs: 20 });
		for (let i = 0; i < 5; i++) b.push('text', { text: `t${i}` });
		await b.close();
		expect(batches).toHaveLength(1);
		expect(batches[0]?.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(batches[0]?.[0]?.ts).toMatch(/Z$/);
	});

	it('teilt nach 100 Ereignissen und nach Bytes', async () => {
		const { api, batches } = fakeApi();
		const b = new EventBatcher({ runId: RUN, api, redactor: new Redactor(), flushMs: 1000 });
		for (let i = 0; i < 250; i++) b.push('text', { text: 'x' });
		await b.close();
		expect(batches.map((x) => x.length)).toEqual([100, 100, 50]);
		const all = batches.flat().map((e) => e.seq);
		expect(all).toEqual([...Array(250).keys()]);

		const big = fakeApi();
		const b2 = new EventBatcher({ runId: RUN, api: big.api, redactor: new Redactor(), flushMs: 1000 });
		for (let i = 0; i < 80; i++) b2.push('text', { text: 'y'.repeat(MAX_EVENT_TEXT) });
		await b2.close();
		for (const batch of big.batches) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(BATCH_MAX_BYTES + 1000);
		expect(big.batches.length).toBeGreaterThan(1);
		expect(big.batches.flat()).toHaveLength(80);
	});

	it('kürzt lange Texte und entfernt Geheimnisse', async () => {
		const { api, batches } = fakeApi();
		const b = new EventBatcher({ runId: RUN, api, redactor: new Redactor(['supergeheim123']), flushMs: 5 });
		b.push('text', { text: 'a'.repeat(MAX_EVENT_TEXT + 500) });
		b.push('stderr', { text: 'token supergeheim123 und ghp_' + 'a'.repeat(36) });
		b.push('tool', { name: 'Edit', input: { big: 'z'.repeat(15_000), more: Array(20).fill('q'.repeat(10_000)) } });
		await b.close();
		const [e0, e1, e2] = batches.flat();
		expect((e0?.payload.text as string).length).toBe(MAX_EVENT_TEXT);
		expect(e1?.payload.text).toBe('token [entfernt] und [entfernt]');
		expect(e2?.payload).toMatchObject({ truncated: true, name: 'Edit' });
		expect(truncateText('kurz')).toBe('kurz');
	});

	it('sendet fehlgeschlagene Batches erneut (gleiche seq)', async () => {
		const { api, batches, calls } = fakeApi((n) => (n < 2 ? new Error('Netzfehler') : null));
		const b = new EventBatcher({ runId: RUN, api, redactor: new Redactor(), flushMs: 5, retryBaseMs: 5 });
		b.push('text', { text: 'a' });
		b.push('text', { text: 'b' });
		await b.close();
		expect(calls()).toBe(3);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.map((e) => e.seq)).toEqual([0, 1]);
	});

	it('verwirft Batches bei endgültigen Fehlern (4xx)', async () => {
		const { api, batches } = fakeApi((n) => (n === 0 ? new ApiError(404, 'not_found', 'Lauf unbekannt') : null));
		const b = new EventBatcher({ runId: RUN, api, redactor: new Redactor(), flushMs: 5 });
		b.push('text', { text: 'a' });
		await b.flush();
		b.push('text', { text: 'b' });
		await b.close();
		expect(b.dropped).toBe(1);
		expect(batches.flat().map((e) => e.seq)).toEqual([1]);
	});
});

describe('AtriumClient', () => {
	it('wiederholt bei 5xx und 429 (retry-after) und liefert data', async () => {
		const seen: string[] = [];
		let n = 0;
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen.push(`${init.method} ${url} ${(init.headers as Record<string, string>).authorization}`);
			n++;
			if (n === 1) return new Response('boom', { status: 502 });
			if (n === 2) return new Response(JSON.stringify({ error: { code: 'rate', message: 'langsam' } }), { status: 429, headers: { 'retry-after': '0' } });
			return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
		}) as unknown as typeof fetch;
		const c = new AtriumClient({ atriumUrl: 'http://atrium.test/', apiKey: 'key-12345678', fetch: fetchFn, backoffBaseMs: 1 });
		expect(await c.request('POST', '/runner/heartbeat', {})).toEqual({ ok: 1 });
		expect(seen[0]).toBe('POST http://atrium.test/api/v1/modules/aidev/runner/heartbeat Bearer key-12345678');
		expect(n).toBe(3);
	});

	it('wirft endgültige Fehler ohne Wiederholung', async () => {
		let n = 0;
		const fetchFn = (async () => {
			n++;
			return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Kein Zugriff' } }), { status: 403 });
		}) as unknown as typeof fetch;
		const c = new AtriumClient({ atriumUrl: 'http://atrium.test', apiKey: 'key-12345678', fetch: fetchFn, backoffBaseMs: 1 });
		await expect(c.request('GET', '/runner/pending')).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Kein Zugriff' });
		expect(n).toBe(1);
	});

	it('liest /pending tolerant', () => {
		const offer = { type: 'cancel', runId: RUN, reason: '' };
		expect(parsePending([offer, { type: 'unbekannt' }])).toHaveLength(1);
		expect(parsePending({ commands: [offer] })).toHaveLength(1);
		expect(parsePending(null)).toEqual([]);
	});
});
