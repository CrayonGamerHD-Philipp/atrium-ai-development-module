/**
 * Anhänge: Namensabsicherung, Prompt-Hinweis und Download über den Client (Größe, SHA-256, Wiederholung).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	attachmentPromptHint,
	safeAttachmentName,
	storeAttachments,
	uniqueAttachmentNames
} from '../src/attachments.ts';
import { ApiError, AtriumClient, DownloadError, RunnerApi } from '../src/client.ts';
import type { AttachmentOffer } from '../src/protocol.ts';
import { FakeAtrium } from './helpers/fake-atrium.ts';

describe('safeAttachmentName', () => {
	it.each([
		['bild.png', 'bild.png'],
		['../../etc/passwd', 'passwd'],
		['C:\\Users\\x\\Desktop\\shot.jpg', 'shot.jpg'],
		['..', 'datei'],
		['.env', 'env'],
		['   ', 'datei'],
		['a\u0000b\nc.txt', 'a_b_c.txt'],
		['frage?<>|*.md', 'frage_____.md'],
		['con.txt', '_con.txt'],
		['ende. ', 'ende'],
		['Bericht  über   Fehler.pdf', 'Bericht über Fehler.pdf']
	])('%j → %j', (raw, expected) => {
		expect(safeAttachmentName(raw)).toBe(expected);
	});

	it('kürzt auf 120 Zeichen und behält die Endung', () => {
		const name = safeAttachmentName(`${'x'.repeat(300)}.png`);
		expect(name).toHaveLength(120);
		expect(name.endsWith('.png')).toBe(true);
	});
});

describe('uniqueAttachmentNames', () => {
	it('macht Duplikate eindeutig (Groß-/Kleinschreibung egal)', () => {
		expect(uniqueAttachmentNames(['bild.png', 'Bild.PNG', 'a/bild.png', 'notiz', 'notiz', '..'])).toEqual([
			'bild.png',
			'Bild (2).PNG',
			'bild (3).png',
			'notiz',
			'notiz (2)',
			'datei'
		]);
	});

	it('bleibt mit Zähler innerhalb von 120 Zeichen', () => {
		const long = `${'y'.repeat(200)}.txt`;
		const [a, b] = uniqueAttachmentNames([long, long]);
		expect(a).not.toBe(b);
		expect([...(b ?? '')].length).toBeLessThanOrEqual(120);
		expect(b?.endsWith(' (2).txt')).toBe(true);
	});
});

describe('attachmentPromptHint', () => {
	const stored = [{ path: '.aidev/attachments/bild.png', name: 'bild.png', mime: 'image/png', size: 2048 }];
	it('listet die Dateien mit Pfad, Typ und Größe', () => {
		const hint = attachmentPromptHint('Bitte ansehen', stored) ?? '';
		expect(hint).toContain('## Anhänge');
		expect(hint).toContain('- `.aidev/attachments/bild.png` (image/png, 2,0 KB)');
	});
	it('kein Hinweis ohne Anhänge oder wenn der Auftrag den Pfad schon nennt', () => {
		expect(attachmentPromptHint('x', [])).toBeNull();
		expect(attachmentPromptHint('Anhänge unter .aidev/attachments/ ansehen', stored)).toBeNull();
	});
});

describe('storeAttachments', () => {
	it('verweigert einen symbolischen Link als Ablageordner', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'aidev-att-'));
		const outside = await mkdtemp(path.join(os.tmpdir(), 'aidev-out-'));
		try {
			await symlink(outside, path.join(dir, '.aidev'), 'dir');
			const a: AttachmentOffer = { id: randomUUID(), name: 'x.txt', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64) };
			await expect(storeAttachments(dir, [a], () => Promise.resolve(Buffer.from('x')))).rejects.toThrow(
				/symbolischer Link/
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe('RunnerApi.attachment', () => {
	let atrium: FakeAtrium;
	let api: RunnerApi;
	const runId = randomUUID();
	const bytes = Buffer.from('Hallo Anhang\n');
	const offer = (over: Partial<AttachmentOffer> = {}): AttachmentOffer => {
		const id = randomUUID();
		atrium.attachments.set(id, bytes);
		return {
			id,
			name: 'a.txt',
			mime: 'text/plain',
			size: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			...over
		};
	};

	beforeAll(async () => {
		atrium = new FakeAtrium();
		await atrium.start();
		api = new RunnerApi(new AtriumClient({ atriumUrl: atrium.url, apiKey: atrium.apiKey, backoffBaseMs: 1 }));
	});
	afterAll(async () => {
		await atrium?.stop();
	});

	it('lädt die Bytes über den Runner-Pfad des Laufs', async () => {
		const a = offer();
		expect(await api.attachment(runId, a)).toEqual(bytes);
		expect(atrium.byPath(new RegExp(`^/runner/runs/${runId}/attachments/${a.id}$`))).toHaveLength(1);
	});

	it('größer als angekündigt → DownloadError ohne Wiederholung', async () => {
		const a = offer({ size: 4 });
		await expect(api.attachment(runId, a)).rejects.toBeInstanceOf(DownloadError);
		expect(atrium.byPath(new RegExp(`/attachments/${a.id}$`))).toHaveLength(1);
	});

	it('kleiner als angekündigt bzw. falsche Prüfsumme → DownloadError', async () => {
		await expect(api.attachment(runId, offer({ size: bytes.length + 5 }))).rejects.toThrow(/unerwartete Größe/);
		await expect(api.attachment(runId, offer({ sha256: '0'.repeat(64) }))).rejects.toThrow(/Prüfsumme/);
	});

	it('404 → ApiError sofort, 503 → Wiederholung', async () => {
		const missing: AttachmentOffer = { ...offer(), id: randomUUID() };
		await expect(api.attachment(runId, missing)).rejects.toBeInstanceOf(ApiError);
		expect(atrium.byPath(new RegExp(`/attachments/${missing.id}$`))).toHaveLength(1);
		atrium.failAttachments = 2;
		const a = offer();
		expect(await api.attachment(runId, a)).toEqual(bytes);
		expect(atrium.byPath(new RegExp(`/attachments/${a.id}$`))).toHaveLength(3);
	});
});
