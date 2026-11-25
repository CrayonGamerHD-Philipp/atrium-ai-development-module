/**
 * Anhänge eines Laufs: Bytes von Atrium laden (`RunnerApi.attachment`, Größe/SHA-256 geprüft) und im Worktree unter
 * `.aidev/attachments/` ablegen. `.aidev/` wird in `info/exclude` des Repositorys eingetragen, damit
 * `git add -A` (`commitAll`) die Dateien in keinem Auslieferungsmodus committet.
 */
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './git/workspace.ts';
import { type AttachmentOffer, safeAttachmentName, uniqueAttachmentNames } from './protocol.ts';

// Gemeinsame Namensregel mit Atrium (`protocol.ts`), damit Prompt und Ablage dieselben Namen nutzen
export { safeAttachmentName, uniqueAttachmentNames };

/** Ablage relativ zum Worktree (Pfadtrenner `/`, wie im Prompt-Hinweis) */
export const ATTACHMENTS_DIR = '.aidev/attachments';
/** Eintrag in `info/exclude` */
export const AIDEV_EXCLUDE = '/.aidev/';

/**
 * `.aidev/` in `info/exclude` eintragen. Bei Worktrees liegt die Datei im gemeinsamen git-dir (Cache) –
 * `git rev-parse --git-path info/exclude` liefert den Pfad, den git tatsächlich liest.
 */
export async function excludeAidevDir(ws: Workspace, dir: string): Promise<string> {
	const r = await ws.run(dir, ['rev-parse', '--git-path', 'info/exclude']);
	const file = path.resolve(dir, r.stdout.trim());
	await mkdir(path.dirname(file), { recursive: true });
	const current = await readFile(file, 'utf8').catch(() => '');
	const lines = current.split(/\r?\n/).map((l) => l.trim());
	if (!lines.includes(AIDEV_EXCLUDE) && !lines.includes('.aidev/') && !lines.includes('.aidev')) {
		const sep = current && !current.endsWith('\n') ? '\n' : '';
		await appendFile(file, `${sep}# Atrium aidev: Anhänge der Läufe\n${AIDEV_EXCLUDE}\n`, 'utf8');
	}
	return file;
}

export interface StoredAttachment {
	/** Pfad relativ zum Worktree, z. B. `.aidev/attachments/bild.png` */
	path: string;
	name: string;
	mime: string;
	size: number;
}

/**
 * Bricht ab, wenn das Repository unter `.aidev/attachments/` versionierte Dateien enthält: `info/exclude` schützt
 * versionierte Dateien nicht – die Ablage würde sie überschreiben bzw. löschen und `git add -A` das übernehmen.
 */
export async function assertAttachmentsUntracked(ws: Workspace, dir: string): Promise<void> {
	const r = await ws.run(dir, ['ls-files', '-z', '--', ATTACHMENTS_DIR]);
	const tracked = r.stdout.split('\0').filter(Boolean);
	if (tracked.length) {
		const list = tracked.slice(0, 5).join(', ') + (tracked.length > 5 ? ', …' : '');
		throw new Error(`${ATTACHMENTS_DIR}/ enthält versionierte Dateien des Repositorys (${list}) – Ablage verweigert`);
	}
}

/** Bricht ab, wenn ein Teil des Ablagepfads ein symbolischer Link ist (z. B. aus dem Repo) */
async function assertNoSymlink(dir: string, rel: string): Promise<void> {
	let cur = dir;
	for (const part of rel.split('/')) {
		cur = path.join(cur, part);
		const st = await lstat(cur).catch(() => null);
		if (st?.isSymbolicLink()) throw new Error(`${rel} ist ein symbolischer Link – Ablage verweigert`);
	}
}

/**
 * Alle Anhänge laden und nach `<dir>/.aidev/attachments/` schreiben (vorhandene Ablage wird ersetzt).
 * `fetch` liefert die geprüften Bytes eines Anhangs; Fehler werden mit dem Dateinamen weitergereicht.
 */
export async function storeAttachments(
	dir: string,
	attachments: readonly AttachmentOffer[],
	fetch: (a: AttachmentOffer) => Promise<Buffer>
): Promise<StoredAttachment[]> {
	await assertNoSymlink(dir, ATTACHMENTS_DIR);
	const target = path.join(dir, ...ATTACHMENTS_DIR.split('/'));
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	const names = uniqueAttachmentNames(attachments.map((a) => a.name));
	const out: StoredAttachment[] = [];
	for (const [i, a] of attachments.entries()) {
		const name = names[i] ?? 'datei';
		let bytes: Buffer;
		try {
			bytes = await fetch(a);
		} catch (e) {
			throw new AttachmentError(a.name, e);
		}
		const file = path.join(target, name);
		// Doppelte Absicherung gegen Pfad-Traversal
		if (path.dirname(file) !== target) throw new AttachmentError(a.name, new Error('ungültiger Dateiname'));
		await writeFile(file, bytes, { flag: 'wx' });
		out.push({ path: `${ATTACHMENTS_DIR}/${name}`, name, mime: a.mime, size: a.size });
	}
	return out;
}

/** Fehler beim Laden eines Anhangs (Dateiname + Ursache) */
export class AttachmentError extends Error {
	constructor(
		readonly attachmentName: string,
		cause: unknown
	) {
		const status = cause instanceof Error && 'status' in cause ? ` (HTTP ${String(cause.status)})` : '';
		super(`Anhang „${attachmentName}“${status}: ${cause instanceof Error ? cause.message : String(cause)}`, {
			cause
		});
		this.name = 'AttachmentError';
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Nennt der Text genau diesen Pfad (nicht nur als Anfang eines längeren Namens wie `bild.png.txt`)? */
function mentionsPath(text: string, p: string): boolean {
	for (let at = text.indexOf(p); at >= 0; at = text.indexOf(p, at + 1)) {
		const rest = text.slice(at + p.length, at + p.length + 2);
		if (!rest || /^([\s`'")\],;:]|\.(\s|$))/.test(rest)) return true;
	}
	return false;
}

/**
 * Hinweis für den Prompt. Nennt der Auftrag (Hinweis des Backends) schon jeden tatsächlich gespeicherten Pfad, wird
 * keiner ergänzt (keine Doppelung). Fehlt ein Pfad – etwa weil ein älteres Backend den Namen anders gebildet hat –,
 * listet der Hinweis die tatsächlichen Pfade, damit der Agent keine nicht vorhandene Datei sucht.
 */
export function attachmentPromptHint(prompt: string, stored: readonly StoredAttachment[]): string | null {
	if (!stored.length || stored.every((s) => mentionsPath(prompt, s.path))) return null;
	const backend = prompt.includes(`${ATTACHMENTS_DIR}/`);
	const lines = stored.map((s) => `- \`${s.path}\` (${s.mime}, ${formatSize(s.size)})`);
	return [
		'## Anhänge',
		'',
		backend
			? 'Die Anhänge liegen unter diesen Pfaden (relativ zum Arbeitsverzeichnis; maßgeblich statt der Angaben oben).'
			: 'Zum Auftrag gehören diese Dateien (relativ zum Arbeitsverzeichnis).',
		'Lies sie bei Bedarf; Bilder kannst du mit deinem Datei-Werkzeug ansehen. Die Dateien liegen außerhalb der',
		'Versionskontrolle – nicht committen, verschieben oder ins Repository kopieren, außer der Auftrag verlangt das',
		'ausdrücklich.',
		'',
		...lines
	].join('\n');
}
