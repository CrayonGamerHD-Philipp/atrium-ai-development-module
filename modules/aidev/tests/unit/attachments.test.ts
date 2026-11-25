import { describe, it, expect } from 'vitest';
import {
	attachmentUploadUrl,
	attachmentUrl,
	checkFiles,
	formatBytes,
	isPreviewImage,
	pastedFileName,
	rejectionMessage,
	splitAttachments,
	stamp,
	transferFiles,
	transferHasFiles
} from '../../pages/project/attachments';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, type AttachmentDto } from '../../schemas';

const NOW = new Date(2026, 10, 25, 9, 5, 7);
const file = (name: string, size: number, type = 'application/octet-stream') => ({
	name,
	size,
	type
});

describe('formatBytes', () => {
	it('formatiert Bytes, KB und MB deutsch', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(-5)).toBe('0 B');
		expect(formatBytes(Number.NaN)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1,5 KB');
		expect(formatBytes(ATTACHMENT_MAX_BYTES)).toBe('10 MB');
		expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
		expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
	});
});

describe('pastedFileName', () => {
	it('vergibt eingefügten Bildern ohne Namen „bild-<zeit>.png“', () => {
		expect(stamp(NOW)).toBe('20261125-090507');
		expect(pastedFileName('', 'image/png', NOW)).toBe('bild-20261125-090507.png');
		expect(pastedFileName(undefined, 'image/jpeg', NOW)).toBe('bild-20261125-090507.jpg');
	});

	it('ersetzt den generischen Browsernamen „image.png“', () => {
		expect(pastedFileName('image.png', 'image/png', NOW)).toBe('bild-20261125-090507.png');
		expect(pastedFileName('image.webp', '', NOW)).toBe('bild-20261125-090507.webp');
	});

	it('nummeriert mehrere Dateien und behält echte Namen', () => {
		expect(pastedFileName('', 'image/png', NOW, 1)).toBe('bild-20261125-090507-2.png');
		expect(pastedFileName('Bericht.pdf', 'application/pdf', NOW)).toBe('Bericht.pdf');
		expect(pastedFileName('  screenshot.png ', 'image/png', NOW)).toBe('screenshot.png');
		expect(pastedFileName('', 'application/x-unbekannt', NOW)).toBe('datei-20261125-090507');
	});
});

describe('checkFiles', () => {
	it('nimmt gültige Dateien an', () => {
		const r = checkFiles(0, [file('a.txt', 10), file('b.png', ATTACHMENT_MAX_BYTES)]);
		expect(r.accepted.map((f) => f.name)).toEqual(['a.txt', 'b.png']);
		expect(r.rejected).toEqual([]);
	});

	it('lehnt leere und zu große Dateien ab', () => {
		const r = checkFiles(0, [file('leer.txt', 0), file('gross.zip', ATTACHMENT_MAX_BYTES + 1)]);
		expect(r.accepted).toEqual([]);
		expect(r.rejected.map((x) => x.reason)).toEqual(['Die Datei ist leer.', 'Größer als 10 MB.']);
	});

	it('beachtet die Höchstzahl inklusive bereits angehängter Dateien', () => {
		const files = Array.from({ length: 4 }, (_, i) => file(`f${i}.txt`, 1));
		const r = checkFiles(ATTACHMENT_MAX_FILES - 2, files);
		expect(r.accepted.map((f) => f.name)).toEqual(['f0.txt', 'f1.txt']);
		expect(r.rejected).toHaveLength(2);
		expect(rejectionMessage(r.rejected)).toContain(`f2.txt: Höchstens ${ATTACHMENT_MAX_FILES}`);
	});

	it('nutzt eigene Grenzen', () => {
		const r = checkFiles(0, [file('a', 5), file('b', 6), file('c', 1)], {
			maxFiles: 1,
			maxBytes: 5
		});
		expect(r.accepted.map((f) => f.name)).toEqual(['a']);
		expect(r.rejected.map((x) => x.file.name)).toEqual(['b', 'c']);
	});
});

describe('transferFiles / transferHasFiles', () => {
	it('liest zuerst `files`, sonst `items` mit kind „file“', () => {
		expect(transferFiles({ files: ['x', 'y'] })).toEqual(['x', 'y']);
		const items = [
			{ kind: 'string', getAsFile: () => 'text' },
			{ kind: 'file', getAsFile: () => 'bild' },
			{ kind: 'file', getAsFile: () => null }
		];
		expect(transferFiles({ files: [], items })).toEqual(['bild']);
		expect(transferFiles(null)).toEqual([]);
	});

	it('reines Textkleben liefert keine Dateien', () => {
		expect(
			transferFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] })
		).toEqual([]);
		expect(transferHasFiles({ types: ['text/plain'] })).toBe(false);
		expect(transferHasFiles({ types: ['text/plain', 'Files'] })).toBe(true);
		expect(transferHasFiles(undefined)).toBe(false);
	});
});

describe('Anzeige', () => {
	const dto = (id: string, mime: string): AttachmentDto => ({
		id,
		name: `${id}.bin`,
		mime,
		size: 1,
		createdAt: '2026-11-25T09:00:00.000Z'
	});

	it('zeigt nur Rasterbilder als Vorschau (kein SVG)', () => {
		expect(isPreviewImage('image/png')).toBe(true);
		expect(isPreviewImage('IMAGE/JPEG')).toBe(true);
		expect(isPreviewImage('image/svg+xml')).toBe(false);
		expect(isPreviewImage(null)).toBe(false);
		const { images, files } = splitAttachments([
			dto('a', 'image/webp'),
			dto('b', 'image/svg+xml'),
			dto('c', 'application/pdf'),
			dto('d', 'image/gif')
		]);
		expect(images.map((a) => a.id)).toEqual(['a', 'd']);
		expect(files.map((a) => a.id)).toEqual(['b', 'c']);
		expect(splitAttachments(undefined)).toEqual({ images: [], files: [] });
	});

	it('baut die Pfade für Upload und Download', () => {
		expect(attachmentUrl('abc')).toBe('/api/v1/modules/aidev/attachments/abc');
		expect(attachmentUploadUrl('p1')).toBe('/api/v1/modules/aidev/projects/p1/attachments');
	});
});
