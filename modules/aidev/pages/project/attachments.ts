/**
 * Reine Hilfen für Dateianhänge (ohne Svelte): Grenzprüfung, Namensvergabe für eingefügte Bilder, Größenformat,
 * Dateien aus Zwischenablage bzw. Drag & Drop und Download-Pfade. Grenzwerte aus `../../schemas`.
 */
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, type AttachmentDto } from '../../schemas';

/** Voller Pfad des Download-Endpunkts (für `<img src>` und Links; Cookies der Sitzung gelten) */
export const attachmentUrl = (id: string) =>
	`/api/v1/modules/aidev/attachments/${encodeURIComponent(id)}`;
/** Upload-Endpunkt eines Projekts (Multipart, ein Feld `file`) */
export const attachmentUploadUrl = (projectId: string) =>
	`/api/v1/modules/aidev/projects/${encodeURIComponent(projectId)}/attachments`;

/** Rasterbilder, die als Vorschau gezeigt werden dürfen (kein SVG – aktive Inhalte) */
const PREVIEW_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const isPreviewImage = (mime: string | null | undefined) =>
	PREVIEW_MIMES.has(String(mime ?? '').toLowerCase());

const NUMBER = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

/** Dateigröße → „512 B“, „1,5 KB“, „10 MB“ (Basis 1024) */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ['KB', 'MB', 'GB'];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${NUMBER.format(v >= 100 ? Math.round(v) : v)} ${units[i]}`;
}

const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg',
	'text/plain': 'txt',
	'application/pdf': 'pdf'
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Zeitstempel `JJJJMMTT-hhmmss` (lokale Zeit) für erzeugte Dateinamen */
export function stamp(now: Date): string {
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

/**
 * Browser vergeben eingefügten Bildern keinen oder einen generischen Namen („image.png“). Dann gilt
 * `bild-<zeit>.<endung>` (bzw. `datei-…` für andere Typen), bei mehreren Dateien mit laufender Nummer.
 */
export function pastedFileName(
	name: string | null | undefined,
	mime: string | null | undefined,
	now: Date,
	index = 0
): string {
	const n = String(name ?? '').trim();
	if (n && !/^image\.[a-z0-9]+$/i.test(n)) return n;
	const type = String(mime ?? '').toLowerCase();
	const ext = EXT_BY_MIME[type] ?? n.split('.').pop()?.toLowerCase() ?? '';
	const base = type.startsWith('image/') || /^image\./i.test(n) ? 'bild' : 'datei';
	const suffix = index > 0 ? `-${index + 1}` : '';
	return `${base}-${stamp(now)}${suffix}${ext ? `.${ext}` : ''}`;
}

/** Minimalform einer Datei für die Grenzprüfung */
export interface FileLike {
	name: string;
	size: number;
	type?: string;
}

export interface Rejected<F extends FileLike = FileLike> {
	file: F;
	reason: string;
}

/**
 * Prüft neue Dateien gegen die Grenzen: höchstens `maxFiles` insgesamt (`existing` bereits angehängt), je Datei
 * `maxBytes` und nicht leer. Liefert die angenommenen und die abgelehnten Dateien (mit deutschem Grund).
 */
export function checkFiles<F extends FileLike>(
	existing: number,
	files: readonly F[],
	limits: { maxFiles?: number; maxBytes?: number } = {}
): { accepted: F[]; rejected: Rejected<F>[] } {
	const maxFiles = limits.maxFiles ?? ATTACHMENT_MAX_FILES;
	const maxBytes = limits.maxBytes ?? ATTACHMENT_MAX_BYTES;
	const accepted: F[] = [];
	const rejected: Rejected<F>[] = [];
	for (const file of files) {
		if (!file.size || file.size <= 0) rejected.push({ file, reason: 'Die Datei ist leer.' });
		else if (file.size > maxBytes)
			rejected.push({ file, reason: `Größer als ${formatBytes(maxBytes)}.` });
		else if (existing + accepted.length >= maxFiles)
			rejected.push({ file, reason: `Höchstens ${maxFiles} Dateien pro Nachricht bzw. Auftrag.` });
		else accepted.push(file);
	}
	return { accepted, rejected };
}

/** Zusammenfassung abgelehnter Dateien für eine Meldung („a.png: Größer als 10 MB.“) */
export function rejectionMessage(rejected: readonly Rejected[]): string {
	return rejected.map((r) => `${r.file.name || 'Datei'}: ${r.reason}`).join(' ');
}

/** Ausschnitt von `DataTransfer`, den Zwischenablage und Drag & Drop gemeinsam haben */
export interface TransferLike<F = File> {
	files?: ArrayLike<F> | null;
	items?: ArrayLike<{ kind: string; getAsFile(): F | null }> | null;
	types?: ArrayLike<string> | readonly string[] | null;
}

/** Dateien einer Zwischenablage bzw. eines Drops: zuerst `files`, sonst `items` mit `kind === 'file'` */
export function transferFiles<F>(dt: TransferLike<F> | null | undefined): F[] {
	if (!dt) return [];
	const files = dt.files ? Array.from(dt.files) : [];
	if (files.length) return files;
	const out: F[] = [];
	for (const item of dt.items ? Array.from(dt.items) : []) {
		if (item.kind !== 'file') continue;
		const f = item.getAsFile();
		if (f) out.push(f);
	}
	return out;
}

/** Werden Dateien gezogen (nicht nur Text oder Links)? Während `dragover` sind die Dateien selbst nicht lesbar. */
export function transferHasFiles(dt: TransferLike<unknown> | null | undefined): boolean {
	if (!dt?.types) return false;
	return Array.from(dt.types).includes('Files');
}

/** Anhänge für die Anzeige: Bilder (Vorschau) und sonstige Dateien getrennt, Reihenfolge bleibt */
export function splitAttachments(list: readonly AttachmentDto[] | null | undefined): {
	images: AttachmentDto[];
	files: AttachmentDto[];
} {
	const images: AttachmentDto[] = [];
	const files: AttachmentDto[] = [];
	for (const a of list ?? []) (isPreviewImage(a.mime) ? images : files).push(a);
	return { images, files };
}
